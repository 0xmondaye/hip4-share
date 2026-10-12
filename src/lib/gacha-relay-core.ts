// Pure helpers for the direct gacha flow's two Relay legs (v3, no custody):
//   pay-in : user's Hyperliquid USDC ──Relay──▶ user's OWN Solana wallet
//            (carries the markup as an appFee — the house revenue)
//   payout : user's Solana USDC ──Relay──▶ user's Hyperliquid account
//            (sell-back proceeds / stranded-balance recovery, sweep-all)
// Both legs are fee-sponsored from our Relay app balance (user sees clean
// numbers). No browser imports — unit-tested in gacha-core.test.mjs.

import { HL_CHAIN_ID, HL_USDC, toUnits8 } from "./relay-withdraw-core.ts"

export const SOLANA_CHAIN_ID = 792703809
export const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

const sponsorship = (capUsdc: number) => ({
  subsidizeFees: true,
  // subsidizeFees alone sponsors EVERY fee component — including our own
  // appFee. Live 2026-08-01: a $30 pay-in quoted 29.79 delivered because the
  // $5 cap was consumed refunding the $4.998 markup to the user, leaving the
  // relayer fee on them. This list is every component EXCEPT "app" (the
  // Relay-documented way to sponsor fees while still collecting appFees).
  sponsoredFeeComponents: ["execution", "swap", "relay", "rent"],
  // Solana ATA rent is NOT covered by subsidizeFees — Relay requires this
  // explicit opt-in (anti-exploit) and otherwise deducts rent from the
  // delivered amount. That was the live 24.8496-for-$25 short fill on
  // 2026-07-31: the executor's USDC ATA creation rent (~$0.15-0.18, shows
  // up as relayerGas). Now a deprecated alias for adding "rent" to
  // sponsoredFeeComponents — kept belt-and-braces. Ignored on non-Solana legs.
  subsidizeRent: true,
  // cap is MANDATORY (omitting it = cap 0 = sponsored $0; a real deposit
  // lost $1.21 that way, see relay-deposit-core.ts) and always USDC 6dp
  // regardless of leg (Relay fee-sponsorship docs).
  maxSubsidizationAmount: String(Math.max(1, Math.floor(capUsdc)) * 1_000_000),
})

/** cents → USD decimal string for toUnits8 / USDC 6dp amounts. */
export const centsToUsdStr = (cents: number): string => (Math.floor(cents) / 100).toFixed(2)

/** cents → integer string in USDC 6dp units (Solana-side amounts). */
export const centsToUnits6 = (cents: number): string => String(Math.floor(cents) * 10_000)

/** True when a quote's raw destination amount covers `requiredUnits` (both
 *  integer strings in the destination token's base units). Fail closed:
 *  a missing or garbled amount is "no" — never let an unverifiable quote
 *  move money (a sponsored pay-in once filled 24.85 for a $25 pack because
 *  nothing checked the quote's output; decimals verified live 2026-07-31:
 *  HL perps USDC 8dp, Solana USDC 6dp). */
export function quoteCovers(receiveRaw: string, requiredUnits: string): boolean {
  if (!/^\d+$/.test(receiveRaw)) return false
  return BigInt(receiveRaw) >= BigInt(requiredUnits)
}

/** Pay-in leg quote body: user HL → user's own Solana wallet, sponsored.
 *  `totalCents` = pack price + markup; the appFee claws the markup back to
 *  the house (accrues on Relay, claimable by signature — same mechanism as
 *  withdrawals). Caller floors the bps (gacha-core.markupBps). */
export function buildPayinQuoteBody(input: {
  userHlAddr: string
  userSolAddr: string
  totalCents: number
  appFeeRecipient?: string
  /** 0 for packs outside the marked collection — no appFees key at all */
  appFeeBps: number
  subsidyCapUsdc: number
}) {
  return {
    user: input.userHlAddr,
    recipient: input.userSolAddr,
    originChainId: HL_CHAIN_ID,
    destinationChainId: SOLANA_CHAIN_ID,
    originCurrency: HL_USDC,
    destinationCurrency: SOLANA_USDC,
    amount: toUnits8(centsToUsdStr(input.totalCents)),
    tradeType: "EXACT_INPUT",
    protocolVersion: "v2",
    refundTo: input.userHlAddr, // failed fills bounce back to the user on HL
    ...(input.appFeeBps > 0 && input.appFeeRecipient
      ? { appFees: [{ recipient: input.appFeeRecipient, fee: String(input.appFeeBps) }] }
      : {}),
    ...sponsorship(input.subsidyCapUsdc),
  }
}

/** Payout leg quote body: user Solana → user HL, sponsored. Sweep-all
 *  semantics — `amountUnits6` is the wallet's on-chain USDC balance in raw
 *  6dp units, read server-side (never a client-supplied number). */
export function buildPayoutQuoteBody(input: {
  userSolAddr: string
  userHlAddr: string
  amountUnits6: string
  subsidyCapUsdc: number
}) {
  if (!/^\d+$/.test(input.amountUnits6)) throw new Error("Invalid payout amount")
  return {
    user: input.userSolAddr,
    recipient: input.userHlAddr,
    originChainId: SOLANA_CHAIN_ID,
    destinationChainId: HL_CHAIN_ID,
    originCurrency: SOLANA_USDC,
    destinationCurrency: HL_USDC,
    amount: input.amountUnits6,
    tradeType: "EXACT_INPUT",
    protocolVersion: "v2",
    refundTo: input.userSolAddr, // failed fills bounce back to the user's wallet
    ...sponsorship(input.subsidyCapUsdc),
  }
}

// A Solana-origin quote's executable content. Relay's docs don't pin the SVM
// step shape, so we accept both observed encodings and fail loudly otherwise
// (VERIFY against one live quote before launch — same drill as the authorize
// signature-as-query-param discovery, HANDOFF 2026-07-16).
export type SolanaQuoteStep =
  | { kind: "serialized"; transaction: string } // base64 tx to sign & send
  | {
      kind: "instructions"
      instructions: {
        programId: string
        keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]
        data: string // base64 or hex per Relay
      }[]
      addressLookupTableAddresses: string[]
    }

export function parseSolanaQuote(data: unknown): {
  requestId: string
  step: SolanaQuoteStep
  checkEndpoint: string
  /** Raw destination amount in base units ("" when Relay omits it). */
  receiveRaw: string
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as any
  const step = d?.steps?.find(
    (s: any) => s?.items?.[0]?.data && (s.kind === "transaction" || s.id !== "authorize"),
  )
  const item = step?.items?.[0]
  const requestId = String(step?.requestId ?? d?.steps?.[0]?.requestId ?? "")
  if (!item?.data || !requestId) throw new Error("Unexpected Relay Solana quote shape")
  const checkEndpoint = String(item.check?.endpoint ?? `/intents/status/v3?requestId=${requestId}`)
  const receiveRaw = String(d?.details?.currencyOut?.amount ?? "")
  const data_ = item.data
  if (typeof data_.transaction === "string")
    return {
      requestId,
      step: { kind: "serialized", transaction: data_.transaction },
      checkEndpoint,
      receiveRaw,
    }
  if (Array.isArray(data_.instructions))
    return {
      requestId,
      step: {
        kind: "instructions",
        instructions: data_.instructions,
        addressLookupTableAddresses: data_.addressLookupTableAddresses ?? [],
      },
      checkEndpoint,
      receiveRaw,
    }
  throw new Error("Relay Solana quote has neither transaction nor instructions")
}
