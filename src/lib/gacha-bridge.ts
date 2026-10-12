// Shared client money flows for the direct gacha feature:
//   bridgeBackToBalance — user's Solana USDC → their HL trading balance
//     (sell proceeds, auto-sold pulls, stranded-balance recovery)
//   sellToSlabz — buyback initiate → user signs → submit → wait → bridge back
//   quoteRedeem / shipRedeem — physical shipping (Slabz redeem API)
// The Privy signer is injected as a plain (tx bytes → signed bytes) closure
// so this file stays hook-free.

import type { ConnectedWallet } from "@privy-io/react-auth"
import type { ConnectedStandardSolanaWallet } from "@privy-io/react-auth/solana"
import { RELAY_API } from "./relay-withdraw-core"
import {
  getPayoutQuote,
  getRedeemFundQuote,
  sendPayoutTx,
  GachaApiError,
} from "./gacha-quotes"
import {
  b64ToBytes,
  buybackInitiate,
  buybackStatus,
  buybackSubmit,
  bytesToB64,
  giftClaimComplete,
  giftClaimInit,
  redeemAddAddress,
  redeemAuth,
  redeemBurn,
  redeemEstimate,
  redeemPrepare,
  redeemResume,
  redeemStatus,
  redeemVerify,
  usd,
  SlabzError,
  type ShipAddress,
  type ShipEstimate,
} from "./slabz"
import {
  buybackDead,
  buybackInFlight,
  buybackNotSold,
  buybackSold,
  isRedeemSessionGone,
  payoutTimeoutVerdict,
  redeemStep,
} from "./gacha-core"
import { coverPerpsFromSpot, sweepPerpsToSpot } from "./hl-exchange"
import { b58, usdcUnits6 } from "./solana-client"
import { executeWithdraw, WithdrawTrackableError } from "./relay-withdraw"

export type SignSolanaTx = (tx: Uint8Array) => Promise<Uint8Array>
export type SignSolanaMessage = (message: Uint8Array) => Promise<Uint8Array>


/** Slabz said `submitted` — a settlement really IS in flight — but it outran our
 *  poll window. NOT a failure: the sale is very likely completing and the pack
 *  wallet sweeper will bring the proceeds home. Callers MUST render this in the
 *  muted note slot and retire the Sell button; putting it in the red error box
 *  with a live retry tells the user a working sale broke. */
export class SellSettlingError extends Error {
  constructor(
    message: string,
    public offerCents: number,
  ) {
    super(message)
    this.name = "SellSettlingError"
  }
}

/** The Slabz sale completed and the wallet was paid — only the bridge to HL
 *  stalled. Never render as a plain failure: the card is gone, the money sits
 *  in the pack wallet (the auto-sweeper retries it). Callers mark the item
 *  sold for `soldCents` and show the message as a note. */
export class SoldBridgePendingError extends Error {
  constructor(
    message: string,
    public soldCents: number,
  ) {
    super(message)
    this.name = "SoldBridgePendingError"
  }
}

// Privy's SolanaChain type resolves to `any` in SDK 3.36.1 (broken dts), so
// TS can't catch a bad env value — clamp at runtime. Valid ids are
// "solana:mainnet" | "solana:devnet" | "solana:testnet" (NOT mainnet-beta).
const RAW_CLUSTER = process.env.NEXT_PUBLIC_SLABZ_CLUSTER ?? "devnet"
const CLUSTER = ["mainnet", "devnet", "testnet"].includes(RAW_CLUSTER) ? RAW_CLUSTER : "devnet"
export const SOLANA_CHAIN = `solana:${CLUSTER}` as const

/** Embedded wallet only — a connected Phantom must never shadow it (every
 *  EVM money surface filters the same way). Duck-typed on the runtime
 *  `isPrivyWallet` getter (Privy's own internal filter uses it); the class
 *  `PrivyStandardWallet` is dts-only in SDK 3.36.1 — importing it breaks the
 *  build, and the plain SolanaStandardWallet type lacks the getter, hence
 *  the cast. External standard wallets read undefined ⇒ falsy. */
export const pickPrivySolWallet = (ws: ConnectedStandardSolanaWallet[]) =>
  ws.find((w) => (w.standardWallet as { isPrivyWallet?: boolean }).isPrivyWallet)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Poll gap for the sellback legs, by how long we've been waiting. Most fills
 *  land in the first few seconds, and a flat 2.5s gap taxed every one of them;
 *  back off after that so a genuinely slow fill isn't hammering the endpoint. */
const pollGap = (elapsedMs: number) => (elapsedMs < 20_000 ? 1000 : 3000)

/** How long to wait for a Slabz buyback to pay the wallet before handing off to
 *  the auto-sweeper. Well under the 20-min money lock, so a stalled sale can
 *  never wedge the next op. */
const SETTLE_MS = 4 * 60_000

/**
 * How long a `none`/`pending` status may persist before we call the sale dead.
 *
 * Must cover the signed buyback transaction's OWN on-chain window, not just a
 * read-after-write lag. Slabz's buyback tx carries a blockhash good for ~50s
 * and Slabz cannot re-sign it, so the sale stays decidable for that whole
 * window — at 10s we were telling users "your card is safe, try again" while
 * their sale was still perfectly capable of landing. Past ~50s the transaction
 * can no longer land at all, so a `pending`/`none` read really is terminal.
 */
const NOT_SOLD_GRACE_MS = 60_000

/** One money op (pull/sell/bridge) per browser at a time — two tabs racing
 *  one wallet balance end with a confusing on-chain failure. Stale after
 *  20 min: the longest legit pull is ~15 min of Relay polling, and a stolen
 *  lock mid-op is worse than a crashed tab blocking for 20. Release is
 *  token-checked so a finished stale op can't free the next op's lock.
 *  Returns a release fn, or null when another op holds the lock.
 *  ponytail: check-then-set isn't atomic across tabs — the window is one JS
 *  tick; switch to the Web Locks API if it ever bites. */
/** Is a money op currently in flight (same staleness rule as takeMoneyLock)? */
export function moneyLockHeld(): boolean {
  try {
    const cur = Number(localStorage.getItem("gacha:busy") ?? 0)
    return !!cur && Date.now() - cur < 20 * 60_000
  } catch {
    return false
  }
}

export function takeMoneyLock(): (() => void) | null {
  try {
    const cur = Number(localStorage.getItem("gacha:busy") ?? 0)
    if (cur && Date.now() - cur < 20 * 60_000) return null
    const token = String(Date.now())
    localStorage.setItem("gacha:busy", token)
    return () => {
      try {
        if (localStorage.getItem("gacha:busy") === token)
          localStorage.removeItem("gacha:busy")
      } catch {}
    }
  } catch {
    return () => {}
  }
}

/** Keyless Relay fill status ("success" | "pending" | "failure" | "refund" |
 *  intermediate strings — treat unknowns as pending). */
export async function relayStatus(checkEndpoint: string): Promise<string> {
  try {
    const res = await fetch(`${RELAY_API}${checkEndpoint}`, { cache: "no-store" })
    return String(((await res.json()) as { status?: string }).status ?? "")
  } catch {
    return "" // transient — caller keeps polling
  }
}

/**
 * Sweep the wallet's whole USDC balance back to the HL trading balance.
 *
 * `delivered` is true ONLY when Relay confirmed the fill. A drained wallet on a
 * poll timeout resolves with delivered:false — the transfer left, but Relay can
 * still refund it (minus gas) or, when the remainder wouldn't cover gas, fail it
 * with no refund at all. Callers must not tell the user the money arrived on a
 * delivered:false result.
 *
 * Failure modes never lose money silently: before the user signs, nothing moved;
 * after, funds are delivered, refunded to the same wallet (where the sweeper
 * finds them), or reported as unresolved.
 */
export async function bridgeBackToBalance(input: {
  solAddress: string
  evmWallet: ConnectedWallet
  sign: SignSolanaTx
}): Promise<{ cents: number; delivered: boolean }> {
  const { quote, amountUnits6 } = await getPayoutQuote(input.solAddress, input.evmWallet.address)
  if (quote.step.kind !== "serialized")
    // never expected: the server assembles instruction-list steps into a
    // serialized tx (gacha-server/svm-tx.ts) — kept as a fail-safe
    throw new Error("Unsupported transfer format — funds are safe, contact support")
  // Server-side gas sponsorship: the tx carries the HOUSE fee payer; the
  // user signs their slot, payout-send co-signs + broadcasts (wallet needs
  // zero SOL). A dropped broadcast surfaces as the timeout below, and the
  // sweep-all retry (RecoverBalance, mounted in the gacha layout) is the
  // recovery.
  const signed = await input.sign(b64ToBytes(quote.step.transaction))
  await sendPayoutTx(bytesToB64(signed))
  const start = Date.now()
  while (Date.now() - start < 180_000) {
    const s = await relayStatus(quote.checkEndpoint)
    if (s === "success") {
      // proceeds credit perps; the app's one-balance policy keeps spot primary
      await sweepPerpsToSpot(input.evmWallet).catch(() => {})
      return { cents: Math.floor(Number(amountUnits6) / 10_000), delivered: true }
    }
    if (s === "failure" || s === "refund")
      throw new Error(
        "Transfer to your balance failed — funds are safe in your pack wallet and we’ll retry automatically.",
      )
    await sleep(pollGap(Date.now() - start))
  }
  // Timeout is not failure. If the wallet actually drained, the transfer IS in
  // flight: Relay either fills it or refunds to this same wallet, where the
  // auto-sweeper picks it up. Reporting that as failed is what made a working
  // bridge read as lost money — and it spends a retry re-quoting an empty
  // wallet, which just answers NOTHING_TO_BRIDGE.
  const left = await usdcUnits6(input.solAddress).catch(() => null)
  if (payoutTimeoutVerdict(left) === "inflight")
    return { cents: Math.floor(Number(amountUnits6) / 10_000), delivered: false }
  throw new Error("Transfer is taking longer than usual — funds are safe, check back shortly.")
}

/** Sale didn't happen and nothing is in flight — a fresh initiate is the
 *  documented recovery, so the card is untouched and the user can just retry. */
const NOT_SOLD = "Sellback didn't go through — your card is safe, try again."

/**
 * Submit the signed buyback and return once the sale is terminal.
 *
 * The happy path is ONE call. `POST buyback/submit` is SYNCHRONOUS: its 200
 * answers `{status:"completed", signature}`, and by then the NFT is burned and
 * the USDC is in the user's wallet (api-docs.slabz.com/buyback). We used to
 * discard that response and then poll `buyback/status` for up to a minute to
 * learn what it had already told us. That poll is a RECOVERY path, not the
 * main one.
 *
 * What the docs actually guarantee — worth stating precisely, because an
 * earlier version of this comment overstated it: settlement "moves the NFT out
 * of the wallet in one atomic transaction" and "only one buyback can ever settle
 * for a given card". At-most-once is documented; what GATES settlement is not.
 * Don't cite a confirmation gate here.
 *
 * Never re-sign or re-initiate on an ambiguous outcome: the broadcast may have
 * landed, and a second offer would sell a card twice.
 */
async function settleBuyback(txId: string, signedB64: string): Promise<void> {
  try {
    // buybackSold reads BOTH field names — submit answers `status`, initiate and
    // buyback/status answer `buybackStatus` (gacha-core.ts, tested).
    if (buybackSold(await buybackSubmit(txId, signedB64))) return
    // 200 but not terminal — Slabz implies submit can answer "submitted" on a
    // slow confirmation, so fall through and poll rather than assume success.
  } catch (e) {
    if (e instanceof SlabzError) {
      // Already bought back is the OPPOSITE of a failure. Surfacing it as one
      // is how a burned, already-paid card ends up with a live Sell button.
      if (e.code === "PARTNER_CARD_BOUGHT_BACK") return
      // Only the codes that PROVE nothing settled may skip the poll.
      if (PROVES_NOT_SOLD.has(e.code)) throw new Error(NOT_SOLD)
    }
    // DENYLIST, NOT ALLOWLIST — everything unrecognised polls. This was
    // backwards: it only forgave 504 and PARTNER_BUYBACK_IN_PROGRESS, so our
    // own proxy's 502 UPSTREAM_UNREACHABLE (it answers that whenever its fetch
    // to Slabz throws — including a socket reset AFTER Slabz burned the NFT and
    // paid the USDC), a Slabz 500 and a 429 all rethrew and painted a completed
    // sale red while the caller re-armed the Sell button. Wrongly polling a
    // genuine failure costs seconds; wrongly reporting failure on a real sale
    // tells someone they still own a card that is gone.
  }
  await pollBuybackSettled(txId)
}

/** Codes that PROVE the submit changed nothing, so the card is provably
 *  untouched and we can say so immediately. Everything else is ambiguous. */
const PROVES_NOT_SOLD = new Set([
  // "Definitive — re-sending will not help", but the buyback table also says to
  // initiate again for a fresh transaction: only the re-SEND is futile, not the
  // re-SELL. NOT_SOLD's copy says "try again" for exactly that reason.
  "PARTNER_SUBMISSION_FAILED",
  "PARTNER_BUYBACK_EXPIRED",
  "PARTNER_BUYBACK_INELIGIBLE", // 72h window from the pack OPEN has lapsed
  // NB the idempotency 409s are scoped to buyback INITIATE only and can never
  // appear here, so there is deliberately no submit-side handler for them.
])

/**
 * Recovery poll for a submit whose outcome we don't know. Keeps THREE outcomes
 * apart that a single loop used to collapse into one:
 *   sold        — `completed`
 *   not sold    — a failure state, or `none` (no buyback on the tx at all)
 *   UNKNOWN     — we never got a readable answer
 *
 * That last one is the important one. `buybackStatus().catch(() => "")` makes
 * "Slabz is unreachable" indistinguishable from "still settling", and "" is
 * neither sold nor dead — so a dead connection used to ride the full timeout
 * and then promise a payout that was never coming, on a card the user still
 * owned. Only promise money when Slabz actually SAID a settlement is in flight.
 */
async function pollBuybackSettled(txId: string): Promise<void> {
  const start = Date.now()
  let sawLive = false
  for (;;) {
    const s = await buybackStatus(txId).catch(() => "")
    if (buybackSold({ buybackStatus: s })) return
    if (buybackDead(s)) throw new Error(NOT_SOLD)
    // `none` (nothing recorded) and `pending` (offer still awaiting a signed tx)
    // both mean our submit did not take effect. Grace window first: a
    // just-accepted submit can read either for a moment.
    if (buybackNotSold(s) && Date.now() - start > NOT_SOLD_GRACE_MS) throw new Error(NOT_SOLD)
    // ONLY `submitted` counts as progress. `pending` used to set this too, which
    // meant a submit that failed with an unrecognised 4xx polled a stuck
    // `pending` for four minutes and then promised a payout that was never
    // coming — the docs put `pending` under "not sold yet", not under progress.
    if (buybackInFlight(s)) sawLive = true
    if (Date.now() - start > SETTLE_MS) {
      // sawLive means Slabz SAID `submitted`. That is good news travelling on a
      // slow path, so it gets its own type — a plain Error lands in the callers'
      // red box next to a live Sell button, which reads as "your sale broke".
      if (sawLive)
        throw new SellSettlingError(
          "Sellback is still settling — your payout lands in your balance on its own, no action needed.",
          0, // filled in by sellToSlabz, which knows the offer
        )
      throw new Error("We couldn’t confirm this sale — check your collection before selling again.")
    }
    await sleep(pollGap(Date.now() - start))
  }
}

/**
 * Sell a pull back to Slabz from the user's own wallet, then bridge the
 * proceeds to their HL balance. Returns the full offer cents (no fee).
 * `minOfferCents` pins the quote the user confirmed — a lower minted offer
 * aborts BEFORE any signature (QUOTE_CHANGED, card untouched).
 */
export async function sellToSlabz(input: {
  txId: string
  solAddress: string
  evmWallet: ConnectedWallet
  sign: SignSolanaTx
  minOfferCents: number
  /** Fires the instant the sale is terminal — NFT burned, USDC already in the
   *  pack wallet. Everything after this is moving the user's OWN money home, so
   *  the UI should commit to "sold" here instead of at the end of the bridge. */
  onSold?: (cents: number) => void
}): Promise<number> {
  const init = await buybackInitiate(input.txId, input.solAddress)
  if (init.offerCents < input.minOfferCents)
    throw new GachaApiError("QUOTE_CHANGED", "the buyback offer changed", 409)
  const signed = await input.sign(b64ToBytes(init.transaction))
  try {
    await settleBuyback(input.txId, bytesToB64(signed))
  } catch (e) {
    // carry the confirmed offer out with it so the UI can name the amount
    if (e instanceof SellSettlingError) throw new SellSettlingError(e.message, init.offerCents)
    throw e
  }
  input.onSold?.(init.offerCents)
  try {
    const { delivered } = await bridgeBackToBalance(input)
    // The payout left the pack wallet but Relay hasn't confirmed the fill. Never
    // render this as "it's in your balance" — Relay may still refund it, or (if
    // the remainder wouldn't cover gas) fail it outright.
    if (!delivered)
      throw new SoldBridgePendingError(
        "Sold! Your payout has left your pack wallet and is still settling — no action needed.",
        init.offerCents,
      )
  } catch (e) {
    if (e instanceof SoldBridgePendingError) throw e
    // sold and paid, only the hop to HL is pending — the recovery surface
    // (the auto-sweeper) picks this up; never report the sale itself as failed
    throw new SoldBridgePendingError(
      "Sold! Moving the payout to your balance is still running — it finishes on its own, no action needed.",
      init.offerCents,
    )
  }
  return init.offerCents
}

// ---- redeem: ship the physical slab ----------------------------------------
// Two phases so the user sees the shipping cost before anything is charged:
//   quoteRedeem — session + address + estimate, spends nothing
//   shipRedeem  — fund the wallet, prepare, sign the burn, ship
//
// ONE session per shipment, opened by quoteRedeem, plus a lazy retry.
//
// This used to open THREE (quote, pre-fund, pre-prepare) on the theory that
// funding could outlive the 14-minute window. It can't: the fund leg is bounded
// by the redeem-fund route's own budget (maxDuration 60) + executeWithdraw's 90s
// fill window + the 5-minute tracking poll, so ~7.5 minutes worst case. What
// actually outlives a session is the USER — deliberating on the quote screen, or
// coming back to a wallet that's already funded. A pre-emptive re-open can't help
// with that anyway (it would be just as stale), so the eager opens bought nothing
// and cost ~1.2-3s and two headless signatures on the confirm click.
//
// Slabz scopes the session to (transaction, wallet). Our browser proxy and our
// server routes share one SLABZ_API_KEY against one SLABZ_API_URL, so the session
// the BROWSER opens is usable from our server routes — the API-key part of the
// scope is our assumption, not something the docs state. The server can never
// open one itself: it needs the wallet's ed25519 signature.

async function openRedeemSession(
  txId: string,
  solAddress: string,
  signMessage: SignSolanaMessage,
): Promise<void> {
  const { messageToSign } = await redeemAuth(txId, solAddress)
  // sign the message bytes verbatim; Slabz verifies ed25519 over them and
  // wants the signature base58-encoded
  const sig = await signMessage(new TextEncoder().encode(messageToSign))
  await redeemVerify(txId, solAddress, b58(sig))
}

/** Last successful verify per (transaction, wallet). Slabz gives the session 14
 *  minutes; we treat it as reusable for 10, leaving headroom for the calls that
 *  follow. Module-level because a shipment is one flow at a time, and a reload
 *  legitimately re-signs. Never a correctness guarantee — Slabz is the arbiter,
 *  and `withSession` re-opens for real when it says the session is gone. */
const sessionOpenedAt = new Map<string, number>()
const SESSION_REUSE_MS = 10 * 60_000

/**
 * Open a redeem session unless a recent one should still be live.
 *
 * `force` skips the freshness check — used by the lazy retry, which KNOWS the
 * session is gone and must not trust our own timestamp. Exported so the UI can
 * pre-warm one while the user fills in the address form: the signature is
 * headless, so there is nothing to confirm and nothing to see.
 */
export async function ensureRedeemSession(
  txId: string,
  solAddress: string,
  signMessage: SignSolanaMessage,
  force = false,
): Promise<void> {
  const k = `${txId}:${solAddress}`
  const at = sessionOpenedAt.get(k)
  if (!force && at && Date.now() - at < SESSION_REUSE_MS) return
  sessionOpenedAt.delete(k) // never leave a stale stamp if the open throws
  await openRedeemSession(txId, solAddress, signMessage)
  sessionOpenedAt.set(k, Date.now())
}

/** The Slabz redeem session lapsed. Matched on CODE, never on status 401: our
 *  OWN Privy gate answers 401 `UNAUTHORIZED`, and that must stay the re-login
 *  path rather than silently re-signing a redeem session. */
const sessionGone = (e: unknown): boolean =>
  (e instanceof SlabzError || e instanceof GachaApiError) && isRedeemSessionGone(e)

/**
 * Run `fn`; if the redeem session has lapsed, re-open it ONCE and run again.
 *
 * Deliberately narrow. Only wrap calls that SPEND NOTHING and are safe to
 * repeat verbatim. Never wrap the funding leg as a whole — re-quoting it
 * double-debits the HL balance — and never anything from the first burn
 * signature onward, where a repeat risks a second shipment.
 */
async function withSession<T>(
  ctx: { txId: string; solAddress: string; signMessage: SignSolanaMessage },
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (!sessionGone(e)) throw e
    // force: Slabz just told us the session is gone, so our own freshness
    // stamp is wrong by definition
    await ensureRedeemSession(ctx.txId, ctx.solAddress, ctx.signMessage, true)
    return fn()
  }
}

/** Claim one pack from a Slabz gift: prove wallet ownership with an ed25519
 *  message signature (same shape as the redeem session) and spend one pack.
 *  Returns a standard transactionId — open it exactly like a purchase.
 *  PARTNER_TURBO_REQUIRED consumes nothing ("no pack is spent" — documented
 *  explicitly for the gift claim), so the retry restarts the whole challenge
 *  with turbo per the docs. */
export async function claimGiftPack(input: {
  giftId: string
  solAddress: string
  signMessage: SignSolanaMessage
}): Promise<string> {
  const attempt = async (turbo: boolean) => {
    const init = await giftClaimInit(input.giftId, input.solAddress)
    const sig = await input.signMessage(new TextEncoder().encode(init.messageToSign))
    const res = await giftClaimComplete(input.giftId, {
      walletAddress: input.solAddress,
      nonce: init.nonce,
      signedMessage: init.messageToSign,
      signature: b58(sig),
      turbo,
    })
    return res.transactionId
  }
  try {
    return await attempt(false)
  } catch (e) {
    if (e instanceof SlabzError && e.code === "PARTNER_TURBO_REQUIRED") return attempt(true)
    throw e
  }
}

/** Register the shipping address and quote the shipment. Nothing is charged
 *  and no card is burned — the returned id feeds shipRedeem. */
export async function quoteRedeem(input: {
  txId: string
  solAddress: string
  address: ShipAddress
  signMessage: SignSolanaMessage
}): Promise<{ shippingAddressId: string; estimate: ShipEstimate }> {
  // reuses a pre-warmed session when the UI opened one while the user typed;
  // re-quoting after "Change address" costs no second signature either
  await ensureRedeemSession(input.txId, input.solAddress, input.signMessage)
  const { id } = await withSession(input, () => redeemAddAddress(input.txId, input.address))
  return { shippingAddressId: id, estimate: await redeemEstimate(input.txId, id) }
}

/** Bridge the shipping cost from the HL balance into the user's own Solana
 *  pack wallet. The server re-reads the amount from Slabz (see the
 *  redeem-fund route) — `estimateTotalCents` only sizes the perps top-up. */
async function fundShipping(input: {
  txId: string
  shippingAddressId: string
  solAddress: string
  evmWallet: ConnectedWallet
  estimateTotalCents: number
  signMessage: SignSolanaMessage
}): Promise<void> {
  // An earlier attempt's fill may STILL BE IN FLIGHT. "Never re-quote" held
  // inside one call, but not across attempts: this function's own 5-minute
  // timeout tells the user to "Try again in a minute", and that next attempt
  // used to quote and sign a SECOND sendAsset for a shipment already paid for.
  // Resume the recorded attempt instead of minting a new one.
  const pending = readFundAttempt(input.txId)
  if (pending) {
    const s = await relayStatus(pending)
    if (s === "success") {
      clearFundAttempt(input.txId)
      return
    }
    if (s !== "failure" && s !== "refund")
      // still working — wait on THIS one, never start a parallel payment
      return awaitFundFill(input.txId, pending)
    clearFundAttempt(input.txId) // refunded/failed: safe to pay again
  }

  // one-balance: Relay draws perps USDC — top up from spot BEFORE quoting, so
  // the cover signature doesn't eat the quote's TTL
  await coverPerpsFromSpot(input.evmWallet, input.estimateTotalCents / 100)
  // The quote spends nothing, so it is safe to re-run after re-opening a lapsed
  // session. Everything BELOW this line is not: executeWithdraw signs.
  const { quote, totalCents } = await withSession(input, () =>
    getRedeemFundQuote({
      transactionId: input.txId,
      shippingAddressId: input.shippingAddressId,
      solAddress: input.solAddress,
      hlAddress: input.evmWallet.address,
    }),
  )
  // The route re-reads the cost from Slabz with our key, so `totalCents` — not
  // the client's estimate — is what actually gets bridged. Discarding it meant
  // an upward reprice between quote and confirm bridged MORE than the user
  // confirmed (bounded only by GACHA_REDEEM_MAX_FUND_CENTS), with the perps
  // top-up above still sized off the stale number. Abort pre-signature.
  if (totalCents > input.estimateTotalCents)
    throw new Error(
      `Shipping repriced to ${usd(totalCents)} — nothing was charged. Start the shipment again to confirm the new price.`,
    )
  // Record BEFORE signing: a response lost in transit is exactly the case a
  // post-hoc write would miss.
  writeFundAttempt(input.txId, quote.deposit.check.endpoint)
  try {
    await executeWithdraw(input.evmWallet, quote, () => {})
    clearFundAttempt(input.txId)
    return // resolves only on a confirmed fill — the USDC is on Solana
  } catch (e) {
    if (!(e instanceof WithdrawTrackableError)) {
      // nothing moved (user rejection / definitive HL rejection) — drop the
      // record so the next attempt isn't blocked waiting on a payment that
      // never happened
      clearFundAttempt(input.txId)
      throw e
    }
  }
  // funds moved (or may have) — an HL→Solana fill can land well past
  // executeWithdraw's own 90s window. Never re-quote here: that double-charges.
  return awaitFundFill(input.txId, quote.deposit.check.endpoint)
}

// One in-flight shipping payment per transaction, remembered across attempts and
// across reloads. ponytail: localStorage, same scope as the pull journal and the
// money lock — a server-side record would need the tab to report in anyway.
const fundKey = (txId: string) => `gacha:redeemFund:${txId}`

/** How long a recorded shipping payment may stay unresolved before we treat it
 *  as abandoned. Without a give-up the record is a PERMANENT block: a tab closed
 *  mid-payment leaves a request that never reaches a terminal status, and every
 *  later attempt then waits out awaitFundFill and rethrows, so that card can
 *  never be shipped again. Comfortably past Relay's own settling window. */
const FUND_ATTEMPT_TTL_MS = 30 * 60_000

const readFundAttempt = (txId: string): string | null => {
  try {
    const raw = localStorage.getItem(fundKey(txId))
    if (!raw) return null
    // legacy rows were a bare endpoint string with no timestamp — treat an
    // unparseable row as abandoned rather than letting it block forever
    const rec = JSON.parse(raw) as { endpoint?: string; at?: number }
    if (!rec?.endpoint || !rec.at || Date.now() - rec.at > FUND_ATTEMPT_TTL_MS) {
      clearFundAttempt(txId)
      return null
    }
    return rec.endpoint
  } catch {
    clearFundAttempt(txId)
    return null
  }
}
const writeFundAttempt = (txId: string, endpoint: string) => {
  try {
    localStorage.setItem(fundKey(txId), JSON.stringify({ endpoint, at: Date.now() }))
  } catch {}
}
const clearFundAttempt = (txId: string) => {
  try {
    localStorage.removeItem(fundKey(txId))
  } catch {}
}

/** Wait out a shipping-payment fill we know is in flight. */
async function awaitFundFill(txId: string, checkEndpoint: string): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < 5 * 60_000) {
    const s = await relayStatus(checkEndpoint)
    if (s === "success") {
      clearFundAttempt(txId)
      return
    }
    if (s === "failure" || s === "refund") {
      clearFundAttempt(txId)
      throw new Error(
        "The shipping payment was refunded to your balance — nothing was charged. Try again.",
      )
    }
    await sleep(pollGap(Date.now() - start))
  }
  // leave the record in place: the next attempt must resume this payment, not
  // start a second one
  throw new Error(
    "Your shipping payment is still processing — nothing has been burned. Try again in a minute.",
  )
}

/**
 * Pay for shipping and burn the card. Order matters and is the whole safety
 * story: the wallet is funded first (a burn tx that can't pay would fail after
 * the card is committed), and the prepared cost is checked against the quote
 * the user confirmed BEFORE any signature. Idempotency is Slabz's — a card
 * already redeemed answers PARTNER_REDEEM_ALREADY_DONE.
 */
export async function shipRedeem(input: {
  txId: string
  solAddress: string
  shippingAddressId: string
  estimateTotalCents: number
  evmWallet: ConnectedWallet
  sign: SignSolanaTx
  signMessage: SignSolanaMessage
  email?: string
  onPhase?: (p: "funding" | "preparing" | "signing" | "shipping") => void
}): Promise<{ shipmentId: string; status: string; transactionUrls: string[] }> {
  const phase = input.onPhase ?? (() => {})
  // fail closed: an RPC hiccup must never read as "unfunded" — re-bridging an
  // already-funded wallet charges the user twice for one shipment
  const units = await usdcUnits6(input.solAddress).catch(() => null)
  if (units == null)
    throw new Error("Couldn't check your pack wallet — nothing was charged. Try again.")
  if (units < BigInt(input.estimateTotalCents) * BigInt(10_000)) {
    phase("funding")
    // No eager session open: fundShipping re-opens lazily around its own quote
    // if quoteRedeem's session has lapsed. The fund route reads the estimate
    // with our key, so it needs a live session — but only when it actually runs.
    await fundShipping(input)
    // Re-read, and FAIL CLOSED. fundShipping's resume path returns on a Relay
    // status of "success", which is a statement about a PAST fill, not about
    // what the wallet holds now — and RecoverBalance is mounted on this very
    // route, so it can legitimately have swept the shipping money home in
    // between. Burning a card whose wallet can't pay is unrecoverable.
    const after = await usdcUnits6(input.solAddress).catch(() => null)
    if (after == null || after < BigInt(input.estimateTotalCents) * BigInt(10_000))
      throw new Error(
        "Your shipping payment isn't in your pack wallet yet — nothing was burned. Try again in a moment.",
      )
  }

  phase("preparing")
  // Start this leg on a DEMONSTRABLY fresh session. withSession covers prepare,
  // but the BURN that follows cannot be blind-retried, so it must not be the
  // thing that discovers the session died. Funding can legitimately eat ~5
  // minutes and SESSION_REUSE_MS is 10 against Slabz's 14, so without this the
  // burn could start on a session with almost no life left.
  await ensureRedeemSession(input.txId, input.solAddress, input.signMessage, true)
  // Prepare CREATES and prices the shipment, so a second one for the same card
  // risks a second charge — the very hole HANDOFF left open. Slabz's answer is
  // `redeem/resume`: when a previous attempt prepared but the burn never
  // landed, it rebuilds THAT shipment's txs with a fresh blockhash. Read the
  // live status and pick, rather than blindly preparing again.
  const step = redeemStep(
    await redeemStatus(input.txId).catch(() => {
      // Fail CLOSED like every other guard on this path: an unreadable status
      // can't tell prepare from resume, and guessing prepare is the double
      // charge. Nothing is burned, the funds stay in the pack wallet, and the
      // sweeper brings them home if the user gives up.
      throw new Error(
        "Couldn't check this card's shipment — nothing was burned. Try again in a moment.",
      )
    }),
  )
  if (step === "existing")
    throw new Error(
      "This card already has a shipment — nothing was burned. Close this and reopen it to see where the shipment is.",
    )
  // "Finish the burn" passes no address: resume ignores it, the shipment
  // already has one. If the status moved out of pending_burn between the
  // button rendering and this read, the prepare branch would POST an empty
  // address and get a bare partner 400 — say what actually happened instead.
  if (step === "prepare" && !input.shippingAddressId)
    throw new Error(
      "This shipment is no longer waiting on a burn — nothing was burned. Close this and reopen the card to start again.",
    )
  // Both legs spend nothing and are safe to repeat verbatim after a session
  // re-open — unlike everything from the first burn signature on.
  const prep = await withSession(input, () =>
    step === "resume"
      ? redeemResume(input.txId)
      : redeemPrepare(input.txId, input.shippingAddressId, { email: input.email }),
  )
  // Never sign a burn that costs more than the quote the user confirmed. The
  // wallet may already hold the funded amount — it's the user's, and the pack
  // wallet sweeper brings it back.
  //
  // This one comparison is the ONLY thing standing between the confirmed quote
  // and an irreversible burn, so it must fail CLOSED. It used to fail OPEN: a
  // missing or non-numeric `totalCost` makes `Math.ceil(Number(...))` NaN, and
  // `NaN > n` is false — so an unreadable price sailed past the guard and every
  // burn got signed at a cost nobody had checked.
  const prepCents = Math.ceil(Number(prep.totalCost) * 100)
  if (!Number.isFinite(prepCents) || prepCents < 1)
    throw new Error(
      "Couldn't read the shipping cost — your card was NOT burned. Try the shipment again.",
    )
  if (prepCents > input.estimateTotalCents)
    throw new Error(
      `Shipping repriced to ${usd(prepCents)} — your card was NOT burned. Start the shipment again to confirm the new price, or leave it — the money returns to your balance on its own.`,
    )

  phase("signing")
  const signed: string[] = []
  for (const tx of prep.transactions)
    signed.push(bytesToB64(await input.sign(b64ToBytes(tx))))

  phase("shipping")
  // ONE session-gone retry, re-POSTing the IDENTICAL signedTransactions and the
  // SAME shipmentId — never a fresh prepare, which would create a second
  // shipment. Safe because a 401 is answered before any work is done, and if the
  // burn actually landed Slabz answers PARTNER_REDEEM_ALREADY_DONE.
  return withSession(input, () => redeemBurn(input.txId, signed, prep.shipmentId))
}
