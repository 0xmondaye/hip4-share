// Chain access for the wine gacha (InstantGacha.sol on HyperEVM). Isomorphic —
// the page reads the shelf through this and the server routes import the same ABI.
// Unconfigured (no NEXT_PUBLIC_WINE_GACHA_ADDRESS) => the Cellar route shows
// its coming-soon page and the mock shelf is reviewable in CellarPage.

import {
  createPublicClient,
  createWalletClient,
  custom,
  domainSeparator,
  http,
  type PublicClient,
} from "viem"
import { hyperEvm, hyperliquidEvmTestnet } from "viem/chains"
import type { ConnectedWallet } from "@privy-io/react-auth"
import { makeSigner } from "@/lib/privy-signer"

export const WINE_GACHA_ADDRESS = (process.env.NEXT_PUBLIC_WINE_GACHA_ADDRESS ?? "") as
  | `0x${string}`
  | ""

// Default testnet, mirroring the Slabz devnet default: real mainnet money must
// be an explicit opt-in. Privy's default chain list has 999 but not 998, so
// Providers.tsx lists both — embedded wallets can only switchChain to a
// listed chain.
export const WINE_CHAIN =
  process.env.NEXT_PUBLIC_WINE_CHAIN === "mainnet" ? hyperEvm : hyperliquidEvmTestnet

export const wineConfigured = () => WINE_GACHA_ADDRESS !== ""

export const GACHA_ABI = [
  { type: "function", name: "prizeCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "stockEpoch", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "tokenCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "houseAnchor", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  {
    type: "function", name: "tokenAt", stateMutability: "view",
    inputs: [{ type: "uint8" }],
    outputs: [{ name: "token", type: "address" }, { name: "price", type: "uint96" }],
  },
  {
    type: "function", name: "prizeAt", stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ name: "collection", type: "address" }, { name: "tokenId", type: "uint256" }],
  },
  {
    type: "function", name: "sellbackQuote", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ name: "payout", type: "uint256" }, { name: "sellable", type: "bool" }],
  },
  { type: "function", name: "settler", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function", name: "sellbackToken", stateMutability: "view", inputs: [],
    outputs: [{ name: "id", type: "uint8" }, { name: "set", type: "bool" }],
  },
  {
    type: "function", name: "openPack", stateMutability: "nonpayable",
    inputs: [
      {
        name: "req", type: "tuple", components: [
          { name: "user", type: "address" }, { name: "payToken", type: "uint8" },
          { name: "count", type: "uint32" }, { name: "userSeed", type: "bytes32" },
          { name: "minAvailable", type: "uint32" }, { name: "epoch", type: "uint32" },
          { name: "round", type: "uint64" },
        ],
      },
      { name: "signature", type: "bytes" },
      { name: "houseSeed", type: "bytes32" },
      {
        name: "auth", type: "tuple", components: [
          { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" },
          { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "event", name: "Opened",
    inputs: [
      { name: "requestId", type: "bytes32", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "round", type: "uint64", indexed: false },
      { name: "beacon", type: "bytes32", indexed: false },
      { name: "houseSeed", type: "bytes32", indexed: false },
      { name: "count", type: "uint32", indexed: false },
      { name: "poolSize", type: "uint256", indexed: false },
      { name: "paid", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "Prizes",
    inputs: [
      { name: "requestId", type: "bytes32", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "prizes", type: "uint256[]", indexed: false },
    ],
  },
  {
    type: "event", name: "PayoutDeferred",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "collection", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: false },
    ],
  },
  // Named so a simulateContract revert decodes to something a route can branch on. An error
  // missing here does not throw — it just arrives as an undecodable 4-byte blob, which is
  // how a real cause ends up logged as "unknown error". Kept in step with InstantGacha:
  // every custom error openPack or a sellback can actually raise is listed.
  { type: "error", name: "BadHouseSeed", inputs: [] },
  { type: "error", name: "StaleStock", inputs: [] },
  { type: "error", name: "Empty", inputs: [] },
  { type: "error", name: "NotAccepted", inputs: [] },
  { type: "error", name: "Unauthorized", inputs: [] },
  { type: "error", name: "BadInput", inputs: [] },
  { type: "error", name: "BadCount", inputs: [] }, // count 0, or over the 25-prize cap
  { type: "error", name: "BadSeed", inputs: [] },
  { type: "error", name: "TooManyTokens", inputs: [] },
  // Sellback path. OverLimit is the one to expect in production: the buyback has a DAILY
  // ceiling, and now that a quote may exceed the price of a pull, one grand-prize sellback
  // can consume a large slice of it. NotSellable means unquoted, buyback off, or the
  // collection is not allowlisted.
  { type: "error", name: "OverLimit", inputs: [] },
  { type: "error", name: "NotSellable", inputs: [] },
  { type: "error", name: "BadTokenId", inputs: [] },
  { type: "error", name: "NotQueued", inputs: [] },
] as const

/** Pay token 2 is Points on every deployment this repo makes — the id `mintPoints` gifts. */
export const POINTS_TOKEN_ID = 2

/** Points is our own contract: an ERC20 with a role-gated, daily-capped mint. */
export const POINTS_ABI = [
  {
    type: "function", name: "mint", stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }], outputs: [],
  },
  {
    type: "function", name: "mintMany", stateMutability: "nonpayable",
    inputs: [{ type: "address[]" }, { type: "uint256" }], outputs: [],
  },
  { type: "function", name: "dailyMintLimit", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "error", name: "DailyMintLimitExceeded", inputs: [] },
  { type: "error", name: "Unauthorized", inputs: [] },
] as const

export const ERC20_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  {
    type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  {
    type: "function", name: "eip712Domain", stateMutability: "view", inputs: [],
    outputs: [
      { type: "bytes1" }, { name: "name", type: "string" }, { name: "version", type: "string" },
      { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
      { type: "bytes32" }, { type: "uint256[]" },
    ],
  },
  // testnet stand-ins only (MockUSDC3009 in the contract repo's Testnet.s.sol)
  {
    type: "function", name: "mint", stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }], outputs: [],
  },
] as const

export const ERC721_ABI = [
  {
    type: "function", name: "ownerOf", stateMutability: "view",
    inputs: [{ type: "uint256" }], outputs: [{ type: "address" }],
  },
  {
    type: "function", name: "safeTransferFrom", stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }], outputs: [],
  },
  // PrizeNFT: the supplier's stock code behind a bottle id
  {
    type: "function", name: "skuOf", stateMutability: "view",
    inputs: [{ type: "uint256" }], outputs: [{ type: "string" }],
  },
  // PrizeNFT's gasless sale: the holder signs, anyone relays. `nonces` is the number the
  // signature must carry; `eip712Domain` is read rather than hardcoded so a redeployed
  // collection cannot silently invalidate every signature this app produces.
  {
    type: "function", name: "nonces", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "eip712Domain", stateMutability: "view", inputs: [],
    outputs: [
      { type: "bytes1" }, { type: "string" }, { type: "string" }, { type: "uint256" },
      { type: "address" }, { type: "bytes32" }, { type: "uint256[]" },
    ],
  },
  {
    type: "function", name: "sellWithSig", stateMutability: "nonpayable",
    inputs: [
      { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" },
      { type: "bytes" },
    ],
    outputs: [],
  },
  { type: "error", name: "BadSignature", inputs: [] },
  { type: "error", name: "SignatureExpired", inputs: [] },
] as const

// Multicall3's canonical deployment, live on both 998 and 999 — viem only
// ships the address for 999.
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const
/** Browser-side HyperEVM reads go through this route — see src/app/api/wine/rpc/route.ts. */
export const WINE_RPC_PROXY = "/api/wine/rpc"

/**
 * The RPC to read HyperEVM through: a paid endpoint on the server when
 * `WINE_RPC_URL` is set, and the chain's public default everywhere else.
 *
 * Server-only on purpose — there is no `NEXT_PUBLIC_` twin. A paid URL is a
 * credential (the key is in the path or a header), and anything the browser
 * holds is public: it would be readable in the bundle and billable by anyone
 * who found it. The browser reads through /api/wine/rpc instead, a same-origin
 * relay onto the same paid URL; Multicall3 batching keeps it to ~3 requests a
 * shelf load either way.
 */
function wineRpcUrl(): string | undefined {
  // Browser: the same-origin relay at /api/wine/rpc, which forwards to WINE_RPC_URL server-side
  // (or the public RPC when unset). The key never leaves the server; the browser still gets
  // the paid ceiling.
  return typeof window === "undefined" ? process.env.WINE_RPC_URL : WINE_RPC_PROXY
}

let client: PublicClient | null = null

/**
 * Reads for the wine gacha, folded into Multicall3.
 *
 * HyperEVM's public RPCs are strict in both directions: a JSON-RPC batch is
 * capped at 20 ("The batch request was too large — Exceeded max limit of 20")
 * and a burst of individual calls trips `rate limited` (-32005) almost at
 * once — probed 2026-09-04, 8 rounds of 60 concurrent `eth_call`s returned 8
 * results and 472 errors. A shelf read is ~70 calls (one `prizeAt` per bottle
 * on show), so it is exactly the shape that fails, and it failed in the UI as
 * "Couldn't read the cellar".
 *
 * `batch.multicall` turns every concurrent `readContract` into one `aggregate3`
 * eth_call, which is one request instead of seventy. Reads that Multicall3
 * cannot carry (getBalance, getCode, simulateContract) still go on their own.
 *
 * A paid endpoint raises the ceiling but does not replace the batching — three
 * round trips beat seventy on any RPC — so `wineRpcUrl` layers on top. Unset
 * falls back to the chain's public RPC, which the batching alone makes usable.
 */
export function winePublicClient(): PublicClient {
  client ??= createPublicClient({
    chain: {
      ...WINE_CHAIN,
      contracts: { ...WINE_CHAIN.contracts, multicall3: { address: MULTICALL3 } },
    },
    transport: http(wineRpcUrl()),
    // 60 prizeAt reads encode to ~10KB of aggregate3 calldata; viem's default
    // 1024-byte batch would split them straight back into several requests.
    batch: { multicall: { batchSize: 32_768 } },
  })
  return client
}

export interface WineToken {
  id: number
  address: `0x${string}`
  symbol: string
  priceUnits6: bigint // one pull; 0 = retired
}

export interface WineShelf {
  prizeCount: number
  stockEpoch: number
  /** Every payment token the contract knows, in id order (USDC=0, USDT=1, POINTS=2…). */
  tokens: WineToken[]
  prizes: { collection: `0x${string}`; tokenId: bigint }[]
}

/** Cap on prizeAt reads — the shelf view, not pagination. */
const SHELF_MAX = 60

export async function readShelf(): Promise<WineShelf> {
  const c = winePublicClient()
  const addr = WINE_GACHA_ADDRESS as `0x${string}`
  const g = { address: addr, abi: GACHA_ABI } as const
  const [prizeCount, stockEpoch, tokenCount] = await Promise.all([
    c.readContract({ ...g, functionName: "prizeCount" }),
    c.readContract({ ...g, functionName: "stockEpoch" }),
    c.readContract({ ...g, functionName: "tokenCount" }),
  ])
  const n = Math.min(Number(prizeCount), SHELF_MAX)
  const [prizes, tokens] = await Promise.all([
    Promise.all(
      Array.from({ length: n }, (_, i) =>
        c
          .readContract({ ...g, functionName: "prizeAt", args: [BigInt(i)] })
          .then(([collection, tokenId]) => ({ collection, tokenId })),
      ),
    ),
    Promise.all(
      Array.from({ length: Number(tokenCount) }, async (_, id) => {
        const [address, price] = await c.readContract({ ...g, functionName: "tokenAt", args: [id] })
        const symbol = await c
          .readContract({ address, abi: ERC20_ABI, functionName: "symbol" })
          .catch(() => `token ${id}`)
        return { id, address, symbol, priceUnits6: price }
      }),
    ),
  ])
  return {
    prizeCount: Number(prizeCount),
    stockEpoch: Number(stockEpoch),
    tokens,
    prizes,
  }
}

export interface WineBalances {
  /** pay-token balance by token id, 6dp */
  byToken: Record<number, bigint>
  /** native HYPE, wei — only sellbacks need it (the player sends that tx) */
  native: bigint
}

export async function readBalances(user: `0x${string}`, tokens: WineToken[]): Promise<WineBalances> {
  const c = winePublicClient()
  const [native, ...bals] = await Promise.all([
    c.getBalance({ address: user }),
    ...tokens.map((t) =>
      c.readContract({ address: t.address, abi: ERC20_ABI, functionName: "balanceOf", args: [user] }),
    ),
  ])
  const byToken: Record<number, bigint> = {}
  tokens.forEach((t, i) => (byToken[t.id] = bals[i]))
  return { byToken, native }
}

/**
 * EIP-712 domain of the payment token, read from the chain. ERC-5267 when the
 * token implements it (Points does); otherwise `name()` plus whichever version
 * string reproduces the token's own DOMAIN_SEPARATOR() — "2" for Circle's
 * FiatToken, "1" for Solady ERC20s like the testnet mock. Never guess: a wrong
 * domain is an unusable signature that surfaces two hops later as a revert.
 */
export async function tokenDomain(token: `0x${string}`) {
  const c = winePublicClient()
  const t = { address: token, abi: ERC20_ABI } as const
  try {
    const [, name, version] = await c.readContract({ ...t, functionName: "eip712Domain" })
    return { name, version, chainId: WINE_CHAIN.id, verifyingContract: token }
  } catch {
    /* no ERC-5267 */
  }
  const [name, sep] = await Promise.all([
    c.readContract({ ...t, functionName: "name" }),
    c.readContract({ ...t, functionName: "DOMAIN_SEPARATOR" }),
  ])
  for (const version of ["2", "1"]) {
    const domain = { name, version, chainId: WINE_CHAIN.id, verifyingContract: token }
    if (domainSeparator({ domain }) === sep) return domain
  }
  throw new Error(`unrecognised EIP-712 domain for ${token}`)
}

// ── buyback ──────────────────────────────────────────────────────────────────

export interface BottleOffer {
  /** payout in the sellback token, 6dp; 0 = this wine was never quoted */
  priceUnits6: bigint
  /** the contract would pay this transfer right now: quoted, programme on, quote
   *  still under the price of a pull, and the cash is sitting there. There is no
   *  deadline any more — the quote is on the wine, not the bottle, so sell-back
   *  does not expire. This boolean is the whole gate for showing a sell button. */
  sellable: boolean
}

export async function readOffer(collection: `0x${string}`, tokenId: bigint): Promise<BottleOffer> {
  const [payout, sellable] = await winePublicClient().readContract({
    address: WINE_GACHA_ADDRESS as `0x${string}`,
    abi: GACHA_ABI,
    functionName: "sellbackQuote",
    args: [collection, tokenId],
  })
  return { priceUnits6: payout, sellable }
}

/**
 * Sell a bottle back: `safeTransferFrom(player, gacha, tokenId)` from the
 * player's own wallet — the contract pays the quote in the same tx. The ONE
 * wine action the player sends themselves, so it needs HYPE for gas.
 */
/**
 * Sign a bottle over to the buyback. NO transaction, so no gas: the holder signs an EIP-712
 * `Sell` authorisation and the operator relays it, exactly as a pull is relayed.
 *
 * The old path had the holder send `safeTransferFrom` themselves, which meant a guest who was
 * gifted their stake — and so had never held HYPE — could win a bottle and not be able to
 * cash it out. The sell button rendered disabled, reading "Needs a little HYPE for gas".
 *
 * The domain and nonce are READ FROM THE COLLECTION rather than assumed: a redeployed
 * PrizeNFT changes both, and a stale assumption here would produce signatures that every
 * relay rejects with no clue why.
 */
export async function signSellAuthorization(
  wallet: ConnectedWallet,
  collection: `0x${string}`,
  tokenId: bigint,
): Promise<{ deadline: number; signature: `0x${string}` }> {
  const c = winePublicClient()
  const nft = { address: collection, abi: ERC721_ABI } as const
  const [domainRow, nonce] = await Promise.all([
    c.readContract({ ...nft, functionName: "eip712Domain" }),
    c.readContract({ ...nft, functionName: "nonces", args: [wallet.address as `0x${string}`] }),
  ])
  const [, dName, dVersion] = domainRow
  // An hour is long enough for a slow relay and short enough that a signature found later is
  // worthless. It is signed, so nobody can extend it.
  const deadline = Math.floor(Date.now() / 1000) + 3600

  if (wallet.walletClientType === "privy") await wallet.switchChain(WINE_CHAIN.id)
  const signer = await makeSigner(wallet)
  const typed = {
    domain: { name: dName, version: dVersion, chainId: WINE_CHAIN.id, verifyingContract: collection },
    types: {
      Sell: [
        { name: "owner", type: "address" },
        { name: "to", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Sell" as const,
    // Decimal strings, not bigints: the embedded wallet hands this object straight to
    // eth_signTypedData_v4 and JSON.stringify throws on a bigint. Same digest either way.
    message: {
      owner: wallet.address as `0x${string}`,
      to: WINE_GACHA_ADDRESS as `0x${string}`,
      tokenId: tokenId.toString(),
      nonce: nonce.toString(),
      deadline: String(deadline),
    },
  }
  const signature = await (
    signer.signTypedData as (a: typeof typed) => Promise<`0x${string}`>
  )(typed)
  return { deadline, signature }
}

// ── the bottle reader ────────────────────────────────────────────────────────
// Both HyperEVM RPCs cap eth_getLogs at 1000 blocks ("query exceeds max block
// range 1000", probed 2026-09-03), so the Prizes log is not readable from the
// browser. The open route indexes every prize it hands out (wine_prizes in
// Neon) and /api/wine/bottles filters that by ownerOf() — transferred or
// shipped bottles drop out, exactly like coreAssetsOwned() does for slabs.

export interface OwnedBottle {
  collection: `0x${string}`
  tokenId: bigint
  /** Won but still held by the contract — claimable on-chain. */
  deferred: boolean
}

export async function bottlesOwned(user: `0x${string}`): Promise<OwnedBottle[]> {
  const res = await fetch(`/api/wine/bottles?user=${user}`)
  if (!res.ok) throw new Error(`bottles ${res.status}`)
  const j = (await res.json()) as { bottles: { collection: `0x${string}`; tokenId: string; deferred: boolean }[] }
  return j.bottles.map((b) => ({ ...b, tokenId: BigInt(b.tokenId) }))
}

/**
 * The 64-byte BLS signature for a drand evmnet round, from the public relay.
 * 404 = the round isn't produced yet (publishedRound() picks one that is).
 */
export async function fetchDrandSignature(
  round: bigint,
): Promise<{ signature: `0x${string}`; randomness: `0x${string}` } | null> {
  const res = await fetch(`https://api.drand.sh/v2/beacons/evmnet/rounds/${round}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`drand relay ${res.status}`)
  const j = (await res.json()) as { signature: string; randomness: string }
  return { signature: `0x${j.signature}`, randomness: `0x${j.randomness}` }
}
