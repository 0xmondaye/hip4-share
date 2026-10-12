// Server side of the wine gacha: the settler key that submits `openPack`. The
// player never sends a transaction — their ERC-3009 signature moves only the
// money they signed for (the nonce is the requestId, binding every field), and
// payment + prizes land in the SAME transaction, so the house can never take
// money without delivering. The settler key holds gas HYPE and nothing else;
// InstantGacha.settler cannot move funds.
//
// The house's contribution to the draw is a hash chain (see wine-core
// houseChainFrom): every pack reveals the link that hashes to the on-chain
// houseAnchor, and the contract advances the anchor to it. The chain is
// DERIVED from WINE_HOUSE_SECRET rather than stored, so the reveal is a scan
// of a recomputable array — no table to seed, no counter to drift, and nothing
// that can go missing while the deployment stays put.

import { createWalletClient, http, parseEventLogs, parseGwei, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  chainSeedFor,
  decodePrize,
  houseChain,
  houseChainFrom,
  WINE_CHAIN_LINKS,
  type WineRequest,
} from "@/lib/wine-core"
import {
  ERC20_ABI,
  ERC721_ABI,
  fetchDrandSignature,
  GACHA_ABI,
  WINE_CHAIN,
  WINE_GACHA_ADDRESS,
  winePublicClient,
  type OwnedBottle,
} from "@/lib/wine"
import { db, ensureSchema } from "./db"
import { GachaError } from "./http"

/**
 * Fee cap for every settler write. viem's default is ~1.2x the base fee it saw at simulate
 * time, and HyperEVM's base fee swings between small and big blocks, so under load the node
 * rejected sellbacks with "max fee per gas less than block base fee" (2026-09-05, mid-event).
 * The cap is what we are WILLING to pay, not what we pay -- a transaction pays the block's
 * base fee plus the tip -- so 50x the normal 0.1 gwei costs nothing on a quiet block and
 * rides through a spike. Worst case a 200k-gas pack is 0.001 HYPE.
 */
const FEES = { maxFeePerGas: parseGwei("5"), maxPriorityFeePerGas: parseGwei("0.1") }
/** FEES, lifted to 3x the current base fee when a spike takes it past the fixed cap. */
async function fees(pub: ReturnType<typeof winePublicClient>) {
  const base = await pub.getBlock().then((b) => b.baseFeePerGas ?? BigInt(0)).catch(() => BigInt(0))
  const spike = base * BigInt(3)
  return spike > FEES.maxFeePerGas ? { ...FEES, maxFeePerGas: spike } : FEES
}

function settler() {
  // must be InstantGacha.settler — any other key reverts Unauthorized
  const pk = process.env.WINE_KEEPER_PRIVATE_KEY
  if (!pk || !WINE_GACHA_ADDRESS)
    throw new GachaError("NOT_CONFIGURED", "wine gacha is not configured", 503)
  return createWalletClient({
    account: privateKeyToAccount(pk as Hex),
    chain: WINE_CHAIN,
    // Same endpoint the reads use. Bare `http()` falls back to the chain's PUBLIC RPC, which
    // is the one this repo already documents as rate-limiting at -32005 — and of every call
    // in the flow, the broadcast is the one that must not be dropped: the player has already
    // signed and is watching. Server-only file, so the env var is read directly.
    transport: http(process.env.WINE_RPC_URL),
  })
}

export interface OpenInput extends WineRequest {
  validAfter: bigint
  validBefore: bigint
  signature: `0x${string}` // 65-byte r||s||v
}

export interface WonPrize {
  collection: `0x${string}`
  tokenId: string
  deferred: boolean
}

/** The derived chain, built once per process (~125ms for 20k links). */
let chain: `0x${string}`[] | null = null

/**
 * The house chain this deployment can serve.
 *
 * Normally derived from `WINE_HOUSE_SECRET`, which is the shape to prefer: nothing to store,
 * nothing to keep in step, and the anchor is a pure function of the secret.
 *
 * `WINE_HOUSE_TAIL` overrides it with a chain built from a raw tail instead. That exists
 * because the anchor is the ONE deployment argument that cannot be corrected quickly —
 * `setHouseAnchor` is timelocked, so a contract anchored to a chain this server cannot serve
 * is dead for the length of the delay, and re-deploying means re-stocking the whole pool AND
 * waiting out the ceiling timelocks again. Pointing the server at the chain the contract
 * already has is instant and costs nothing. `WINE_HOUSE_LINKS` sets its depth (default
 * WINE_CHAIN_LINKS); a tail is exactly as sensitive as the secret, so it is server-only too.
 */
export function houseChainCached(): `0x${string}`[] {
  if (chain) return chain
  const tail = process.env.WINE_HOUSE_TAIL
  if (tail) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(tail))
      throw new GachaError("NOT_CONFIGURED", "WINE_HOUSE_TAIL must be 32 bytes of hex", 503)
    const links = Number(process.env.WINE_HOUSE_LINKS ?? WINE_CHAIN_LINKS)
    if (!Number.isInteger(links) || links < 1)
      throw new GachaError("NOT_CONFIGURED", "WINE_HOUSE_LINKS must be a positive integer", 503)
    return (chain = houseChain(tail as `0x${string}`, links))
  }
  const secret = process.env.WINE_HOUSE_SECRET
  if (!secret) throw new GachaError("NOT_CONFIGURED", "WINE_HOUSE_SECRET is not set", 503)
  return (chain = houseChainFrom(secret))
}

/** The anchor this secret's chain starts at — the deploy arg / setHouseAnchor target. */
export function expectedAnchor(): `0x${string}` {
  return houseChainCached()[0]
}

/** Can the settler reveal a link for this anchor? What /api/wine/status reports. */
export function chainCovers(anchor: `0x${string}`): boolean {
  return chainSeedFor(houseChainCached(), anchor) !== null
}

/** The settler key's address — public, unlike the key. */
export function settlerAddress(): `0x${string}` {
  const pk = process.env.WINE_KEEPER_PRIVATE_KEY
  if (!pk) throw new GachaError("NOT_CONFIGURED", "WINE_KEEPER_PRIVATE_KEY is not set", 503)
  return privateKeyToAccount(pk as Hex).address
}

/** The chain link that hashes to `anchor`, or a 503 that names the fix. */
function houseSeedFor(anchor: `0x${string}`): `0x${string}` {
  const seed = chainSeedFor(houseChainCached(), anchor)
  if (!seed)
    throw new GachaError(
      "CHAIN_EXHAUSTED",
      `the live anchor is not on this house chain — setHouseAnchor to ${expectedAnchor()}`,
      503,
    )
  return seed
}

// Packs are strictly sequential on the anchor: two in flight would present the
// same houseSeed and the second reverts BadHouseSeed. Serialise within this
// process and retry once across processes.
// ponytail: in-process mutex; a DB advisory lock if Vercel fans out enough to
// see BadHouseSeed retries in the logs.
let chainLock: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = chainLock.then(fn, fn)
  chainLock = run.catch(() => {})
  return run
}

/**
 * Dust of HYPE so a guest can send their own sellback transaction.
 *
 * The settler pays it. That key already holds gas and nothing else, which is exactly the
 * budget this should come out of — it cannot touch the float or the pool. Skips a wallet that
 * already has anything at all, so a returning player is never topped up twice.
 *
 * WINE_GAS_TOPUP_WEI overrides the amount. The default is 0.002 HYPE: a sellback is ~113k gas
 * at 0.1 gwei, so this is dozens of them, and a whole event of guests costs well under 1 HYPE.
 */
const TOPUP_WEI = () => BigInt(process.env.WINE_GAS_TOPUP_WEI ?? "2000000000000000") // 0.002 HYPE
/** Half a top-up still buys many transfers at the 5 gwei cap; below that, refill. (Was "> 0":
 *  a wallet left with dust after a few sends could no longer move its own USDC out.) Mirrored by
 *  HYPE_GAS_RESERVE_WEI on the client, which is what closes the Send-HYPE-then-refill loop. */
const needsGas = async (user: `0x${string}`) =>
  TOPUP_WEI() > BigInt(0) && (await winePublicClient().getBalance({ address: user })) < TOPUP_WEI() / BigInt(2)

async function topUpGas(user: `0x${string}`): Promise<boolean> {
  const amount = TOPUP_WEI()
  if (!(await needsGas(user))) return false
  const pub = winePublicClient()
  const w = settler()
  const hash = await w.sendTransaction({ to: user, value: amount, chain: WINE_CHAIN, ...(await fees(pub)) })
  await pub.waitForTransactionReceipt({ hash })
  console.log("wine gas top-up", user, amount.toString(), hash)
  return true
}

/** Gas for a user about to send from their HyperEVM wallet (a withdrawal moving USDC to
 *  HyperCore). Serialized with openPack/sellback so two settler writes never race a nonce.
 *  Resolves true when HYPE was sent, false when the wallet already had enough. */
export const ensureGas = async (user: `0x${string}`) =>
  // cheap read first, outside the lock: most callers already have gas and must not queue behind
  // a pack opening to learn that. topUpGas re-checks inside.
  (await needsGas(user)) ? serialized(() => topUpGas(user)) : false

/** Open the user's signed pack: pay, draw and deliver in one transaction. */
export function openPack(p: OpenInput) {
  return serialized(async () => {
    try {
      return await openOnce(p)
    } catch (e) {
      if (!String(e).includes("BadHouseSeed")) throw e
      return await openOnce(p) // anchor moved under us — re-read and go again
    }
  })
}

async function openOnce(p: OpenInput) {
  const w = settler()
  const pub = winePublicClient()
  const r = `0x${p.signature.slice(2, 66)}` as Hex
  const s = `0x${p.signature.slice(66, 130)}` as Hex
  const v = parseInt(p.signature.slice(130, 132), 16)

  // Retried. HyperEVM's public RPC can answer an eth_call with an EMPTY result under load
  // instead of an error, and viem turns that into `ContractFunctionZeroDataError: the
  // contract function "houseAnchor" returned no data ("0x")` — which reads like a wrong
  // address or a wrong chain and is neither. viem's own retryCount does not cover it: the
  // response was a valid HTTP 200. Seen once mid-pull, so it fails the player's pack.
  // The real fix is WINE_RPC_URL on a paid endpoint; this stops one blip costing a pull.
  const readAnchor = async (): Promise<`0x${string}`> => {
    let last: unknown
    for (let i = 0; i < 3; i++) {
      try {
        return (await pub.readContract({
          address: WINE_GACHA_ADDRESS as `0x${string}`,
          abi: GACHA_ABI,
          functionName: "houseAnchor",
        })) as `0x${string}`
      } catch (e) {
        last = e
        if (!String(e).includes("returned no data")) throw e
        await new Promise((r) => setTimeout(r, 250 * (i + 1)))
      }
    }
    throw last
  }

  const [beacon, anchor] = await Promise.all([fetchDrandSignature(p.round), readAnchor()])
  if (!beacon) throw new GachaError("NOT_READY", "drand round not published yet — retry", 425)
  const houseSeed = houseSeedFor(anchor)

  const req = {
    user: p.user, payToken: p.payToken, count: p.count, userSeed: p.userSeed,
    minAvailable: p.minAvailable, epoch: p.epoch, round: p.round,
  }
  // simulate first: a revert (StaleStock, Empty, BadCount, bad signature) comes back as a
  // named error instead of a burned settler transaction
  let request
  try {
    ;({ request } = await pub.simulateContract({
      account: w.account, ...(await fees(pub)),
      address: WINE_GACHA_ADDRESS as `0x${string}`,
      abi: GACHA_ABI,
      functionName: "openPack",
      args: [req, beacon.signature, houseSeed, { validAfter: p.validAfter, validBefore: p.validBefore, v, r, s }],
    }))
  } catch (e) {
    const m = String(e)
    if (m.includes("StaleStock") || m.includes("Empty"))
      throw new GachaError("STALE_SHELF", "the shelf changed since you saw it — reload and sign again", 409)
    // `Underfunded` used to be caught here and no such error exists on InstantGacha — a pack
    // does not fund its own buyback any more, so there is nothing for it to be short of.
    if (m.includes("BadCount"))
      throw new GachaError("BAD_COUNT", "a pack is 1 to 25 bottles", 400)
    if (m.includes("Unauthorized"))
      throw new GachaError(
        "NOT_CONFIGURED",
        "WINE_KEEPER_PRIVATE_KEY is not InstantGacha.settler — openPack is settler-only",
        503,
      )
    throw e
  }
  // FIXED gas, never the estimate `simulateContract` hands back. Two reasons, and the
  // second one is silent:
  //
  //  - the draw mixes block.number and block.timestamp, so the estimate replays a
  //    DIFFERENT draw than the mined block — other prizes, other collections, other
  //    warm/cold slots. It is not measuring the transaction that will run.
  //  - each prize transfer is `call(XFER_GAS=200k, ...)` and a failure is SWALLOWED into
  //    `claimable` + `PayoutDeferred`. Under-provision the outer limit and the 63/64 rule
  //    starves those inner calls, so the pack "succeeds", the player is charged, and they
  //    get an IOU instead of the bottle. No revert, nothing in the logs to alert on.
  //
  // ~400k base + 200k per prize is what the contract's own SOP specifies; a live 2-pack
  // measured 380,928 against this limit, so the headroom is real.
  const hash = await w.writeContract({
    ...request,
    // tsconfig targets ES2017, so no BigInt literals — same as wine-core.
    gas: BigInt(400_000) + BigInt(200_000) * BigInt(p.count),
  })
  const receipt = await pub.waitForTransactionReceipt({ hash })

  const logs = parseEventLogs({ abi: GACHA_ABI, logs: receipt.logs })
  const won = logs.find((l) => l.eventName === "Prizes")
  const deferred = new Set(
    logs
      .filter((l) => l.eventName === "PayoutDeferred")
      .map((l) => `${l.args.collection.toLowerCase()}:${l.args.tokenId}`),
  )
  const prizes: WonPrize[] = (won?.args.prizes ?? []).map((word) => {
    const { collection, tokenId } = decodePrize(word)
    return {
      collection,
      tokenId: tokenId.toString(),
      deferred: deferred.has(`${collection.toLowerCase()}:${tokenId}`),
    }
  })
  // A guest who paid in gifted Points has never held HYPE, and the SELLBACK is the one
  // transaction they send themselves — so without this the collection page greets them with a
  // disabled button reading "Needs a little HYPE for gas", which at an event is the whole
  // demo dead. Top them up the moment they own something worth selling.
  //
  // Best-effort and after the fact: the pack has already settled, so a failed top-up must not
  // turn a successful pull into an error. Only for an empty wallet, and only dust — a sellback
  // is ~113k gas, so this covers dozens of them.
  void topUpGas(p.user).catch((e) => console.error("wine gas top-up failed", e))

  // index what landed — the browser can't read Prizes logs (see bottlesOf).
  // Best-effort: a DB blip must not fail a pack that already opened.
  await Promise.all(
    prizes.map((z) =>
      db()`INSERT INTO wine_prizes (tx_hash, collection, token_id, user_addr, deferred)
           VALUES (${hash}, ${z.collection.toLowerCase()}, ${z.tokenId}, ${p.user.toLowerCase()}, ${z.deferred})
           ON CONFLICT DO NOTHING`,
    ),
  ).catch((e) => console.error("wine_prizes insert failed", e))
  return { txHash: hash, prizes }
}

/**
 * Bottles this user still holds, from the open index filtered by ownerOf().
 * ponytail: only OUR openPack writes the index, and only the settler can open
 * packs, so unlike the commit-reveal design nothing lands outside it.
 */
export async function bottlesOf(user: `0x${string}`): Promise<OwnedBottle[]> {
  await ensureSchema()
  const rows = await db()`
    SELECT collection, token_id, bool_or(deferred) AS deferred
    FROM wine_prizes WHERE user_addr = ${user.toLowerCase()}
    GROUP BY collection, token_id`
  const pub = winePublicClient()
  const mine = user.toLowerCase()
  const gacha = WINE_GACHA_ADDRESS.toLowerCase()
  const checked = await Promise.all(
    rows.map(async (r) => {
      const collection = r.collection as `0x${string}`
      const tokenId = BigInt(r.token_id as string)
      try {
        const owner = await pub.readContract({
          address: collection, abi: ERC721_ABI, functionName: "ownerOf", args: [tokenId],
        })
        if (owner.toLowerCase() === mine) return { collection, tokenId, deferred: false }
        if (owner.toLowerCase() === gacha && r.deferred) return { collection, tokenId, deferred: true }
        return null // sold back, transferred, or restocked
      } catch {
        return null // shipped (burned)
      }
    }),
  )
  return checked.filter((b): b is OwnedBottle => b !== null)
}

/**
 * Relay a holder's signed sale to the buyback. The holder never sends a transaction.
 *
 * The signature is the whole authority and `sellWithSig` is permissionless, so this route is
 * a convenience, not a gate: if it is down, the holder or anyone else can submit the same
 * authorisation directly and still get paid. Nothing here can alter what was signed — the
 * destination, the token and the deadline are all inside the digest — so the worst this
 * server can do with a signature is decline to use it.
 *
 * `to` is fixed to the gacha and not taken from the request: the collection also enforces an
 * allowlist of sale destinations, but there is no reason for this endpoint to be the place
 * that gets to name one.
 */
export async function relaySellback(
  owner: `0x${string}`,
  collection: `0x${string}`,
  tokenId: bigint,
  deadline: bigint,
  signature: `0x${string}`,
) {
  const w = settler()
  const pub = winePublicClient()
  let request
  try {
    ;({ request } = await pub.simulateContract({
      account: w.account, ...(await fees(pub)),
      address: collection,
      abi: ERC721_ABI,
      functionName: "sellWithSig",
      args: [owner, WINE_GACHA_ADDRESS as `0x${string}`, tokenId, deadline, signature],
    }))
  } catch (e) {
    const m = String(e)
    // Each of these is a different thing to tell the holder, and an undecoded 4-byte blob
    // tells them none of it.
    if (m.includes("SignatureExpired"))
      throw new GachaError("EXPIRED", "that authorisation has expired — tap sell again", 400)
    if (m.includes("BadSignature"))
      throw new GachaError("BAD_SIGNATURE", "that authorisation is no longer valid — tap sell again", 400)
    if (m.includes("BadInput"))
      throw new GachaError("NOT_CONFIGURED", "the collection does not allow signed sales to this gacha", 503)
    if (m.includes("OverLimit"))
      throw new GachaError("LIMIT", "the buyback has hit its daily ceiling — try again tomorrow", 429)
    if (m.includes("NotSellable"))
      throw new GachaError("NOT_SELLABLE", "this bottle has no buyback quote", 409)
    if (m.includes("TransferFromIncorrectOwner"))
      throw new GachaError("NOT_OWNER", "that bottle is no longer in this wallet", 409)
    throw e
  }
  const hash = await w.writeContract(request)
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== "success") throw new GachaError("FAILED", "the sale did not go through", 502)
  return { txHash: hash }
}

/**
 * Testnet only: the mock USDC in the contract repo has an open `mint`, so the
 * settler can hand a tester a pull's worth. Refuses anywhere but chain 998 —
 * on mainnet the pay token is real USDC and this call would simply revert.
 */
export async function mintTestUsdc(user: `0x${string}`, units6: bigint) {
  if (WINE_CHAIN.id !== 998) throw new GachaError("NOT_CONFIGURED", "faucet is testnet-only", 503)
  const w = settler()
  const pub = winePublicClient()
  const [token] = await pub.readContract({
    address: WINE_GACHA_ADDRESS as `0x${string}`, abi: GACHA_ABI, functionName: "tokenAt", args: [0],
  })
  const { request } = await pub.simulateContract({
    account: w.account, ...(await fees(pub)), address: token, abi: ERC20_ABI, functionName: "mint", args: [user, units6],
  })
  const hash = await w.writeContract(request)
  await pub.waitForTransactionReceipt({ hash })
  return { txHash: hash }
}
