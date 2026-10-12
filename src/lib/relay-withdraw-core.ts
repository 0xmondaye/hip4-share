// Pure helpers for the Relay HyperCore→Arbitrum withdrawal flow: quote body
// construction and quote-response parsing. No browser/React imports so the
// file is unit-testable in node (see relay-withdraw.test.mjs).
//
// Flow reference: https://docs.relay.link/references/api/api_guides/hyperliquid-support.md

import { parseRecoverQuote, type RecoverItem } from "./recover-core.ts"

export const RELAY_API = "https://api.relay.link"
export const HL_CHAIN_ID = 1337
/** HyperCore perps USDC pseudo-address — 8 decimals on Relay. */
export const HL_USDC = "0x00000000000000000000000000000000"
export const ARB_CHAIN_ID = 42161
export const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"

/** USD decimal string → integer string in perps-USDC units (8 dp), no floats. */
export function toUnits8(usd: string): string {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(usd.trim())
  if (!m) throw new Error("Invalid amount")
  const units =
    BigInt(m[1]) * BigInt(100_000_000) + BigInt((m[2] ?? "").padEnd(8, "0"))
  if (units <= BigInt(0)) throw new Error("Invalid amount")
  return units.toString()
}

/** The deposit-address recipe, verbatim: subsidizeFees plus the MANDATORY cap (omitting it =
 *  cap 0 = sponsored $0, the 2026-07-18 incident), always USDC 6dp whatever the leg. Every fee
 *  component EXCEPT "app" — subsidizeFees alone refunds our own appFee to the user (29.79
 *  incident). Only honoured when the quote carries our x-api-key; keyless quotes ignore it. */
export const sponsorship = (capUsdc: number) => ({
  subsidizeFees: true,
  sponsoredFeeComponents: ["execution", "swap", "relay"],
  maxSubsidizationAmount: String(Math.max(1, Math.floor(capUsdc)) * 1_000_000),
})

export interface WithdrawQuoteInput {
  user: string
  recipient: string
  amountUsd: string
  appFees?: { recipient: string; fee: string }[]
  /** Whole USDC. Set only on the server, next to our x-api-key: Relay draws the relayer fee
   *  from our app balance instead of the user's payout. Every component EXCEPT "app" — the
   *  same list gacha-relay-core learned the hard way (subsidizeFees alone refunds our own
   *  appFee to the user). Keyless quotes ignore the whole block. */
  subsidyCapUsdc?: number
}

export function buildWithdrawQuoteBody(input: WithdrawQuoteInput) {
  return {
    user: input.user,
    recipient: input.recipient,
    originChainId: HL_CHAIN_ID,
    destinationChainId: ARB_CHAIN_ID,
    originCurrency: HL_USDC,
    destinationCurrency: ARB_USDC,
    amount: toUnits8(input.amountUsd),
    tradeType: "EXACT_INPUT",
    protocolVersion: "v2",
    // Failed fills refund the perps USDC back to the user's HL account.
    refundTo: input.user,
    ...(input.appFees?.length ? { appFees: input.appFees } : {}),
    ...(input.subsidyCapUsdc ? sponsorship(input.subsidyCapUsdc) : {}),
  }
}

// ── HYPE out: native HYPE on HyperEVM (999) → another chain, via Relay ────────
export const HYPEREVM_CHAIN_ID = 999
export const NATIVE = "0x0000000000000000000000000000000000000000"

export interface HypeDestination {
  id: string
  label: string
  chainId: number
  currency: string
  symbol: string
}

/** Where a guest can send HYPE with Relay. USDC on the chains the deposit flow already knows,
 *  plus ETH on mainnet. HyperEVM-native HYPE is handled outside Relay (a plain transfer). */
export const HYPE_DESTINATIONS: HypeDestination[] = [
  { id: "arb-usdc", label: "Arbitrum · USDC", chainId: 42161, currency: ARB_USDC, symbol: "USDC" },
  { id: "base-usdc", label: "Base · USDC", chainId: 8453, currency: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC" },
  { id: "eth-usdc", label: "Ethereum · USDC", chainId: 1, currency: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC" },
  { id: "eth-eth", label: "Ethereum · ETH", chainId: 1, currency: NATIVE, symbol: "ETH" },
]

export interface HypeQuoteInput {
  user: string
  recipient: string
  /** wei, integer string */
  amountWei: string
  destinationId: string
  appFees?: { recipient: string; fee: string }[]
  subsidyCapUsdc?: number
}

export function buildHypeQuoteBody(input: HypeQuoteInput) {
  const dest = HYPE_DESTINATIONS.find((d) => d.id === input.destinationId)
  if (!dest) throw new Error("Unknown destination")
  if (!/^[1-9]\d{0,30}$/.test(input.amountWei)) throw new Error("Invalid amount")
  return {
    user: input.user,
    recipient: input.recipient,
    originChainId: HYPEREVM_CHAIN_ID,
    destinationChainId: dest.chainId,
    originCurrency: NATIVE,
    destinationCurrency: dest.currency,
    amount: input.amountWei,
    tradeType: "EXACT_INPUT",
    // A failed fill refunds the HYPE to the user's own HyperEVM wallet, where the dialog sees it.
    refundTo: input.user,
    ...(input.appFees?.length ? { appFees: input.appFees } : {}),
    ...(input.subsidyCapUsdc ? sponsorship(input.subsidyCapUsdc) : {}),
  }
}

export interface HypeQuote {
  requestId: string
  items: RecoverItem[]
  /** e.g. "85.37" — in the destination token */
  receive: string
  /** What the user pays after our subsidy, USD to cents. */
  totalFeeUsd: string
  /** Relay's origin-gas estimate in USD (paid in HYPE by the sender, not sponsorable). */
  gasUsd: string
}

/** A HYPE-out quote is a recover-shaped quote (one transaction step on 999) with fee lines. */
export function parseHypeQuote(data: unknown): HypeQuote {
  const q = parseRecoverQuote(data)
  if (q.items.some((i) => i.kind === "transaction" && i.tx.chainId !== undefined && i.tx.chainId !== HYPEREVM_CHAIN_ID))
    throw new Error("Relay quote is not a HyperEVM transaction")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as any
  const feeUsd = Math.max(
    0,
    Number(d?.fees?.relayer?.amountUsd ?? 0) +
      Number(d?.fees?.app?.amountUsd ?? 0) -
      Number(d?.fees?.subsidized?.amountUsd ?? 0),
  )
  return {
    requestId: q.requestId,
    items: q.items,
    receive: q.receiveUsd,
    totalFeeUsd: feeUsd.toFixed(2),
    gasUsd: Number(d?.fees?.gas?.amountUsd ?? 0).toFixed(2),
  }
}

export interface RelayAuthorizeItem {
  sign: {
    domain: Record<string, unknown>
    types: Record<string, unknown>
    value: Record<string, unknown>
    primaryType: string
  }
  post: { endpoint: string; method: string; body: Record<string, unknown> }
}

export interface RelayDepositItem {
  parameters: {
    destination: string
    sourceDex: string
    destinationDex: string
    token: string
    amount: string
    fromSubAccount?: string
  }
  nonce: number
  check: { endpoint: string; method: string }
}

export interface WithdrawQuote {
  authorize: RelayAuthorizeItem
  deposit: RelayDepositItem
  requestId: string
  /** USDC arriving on Arbitrum, formatted (e.g. "19.793015"). */
  receiveUsd: string
  /** Raw destination amount in base units ("" when Relay omits it). */
  receiveRaw: string
  /** Relayer + app fee in USD, rounded to cents (e.g. "0.21"). */
  totalFeeUsd: string
  /** Relay's fill estimate in seconds. */
  timeEstimate: number
}

/** Parse a /quote/v2 response, validating the two-step HyperCore shape. */
export function parseWithdrawQuote(data: unknown): WithdrawQuote {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as any
  const authStep = d?.steps?.find((s: any) => s.id === "authorize")
  const depStep = d?.steps?.find((s: any) => s.id === "deposit")
  const auth = authStep?.items?.[0]
  const dep = depStep?.items?.[0]
  if (!auth?.data?.sign || !auth?.data?.post || !dep?.data?.action?.parameters || !dep?.check)
    throw new Error("Unexpected Relay quote shape")
  const nonce = Number(dep.data.nonce)
  if (
    !Number.isSafeInteger(nonce) ||
    Number(auth.data.sign.value?.nonce) !== nonce ||
    Number(dep.data.action.parameters?.nonce) !== nonce
  )
    throw new Error("Relay quote nonce mismatch")
  const requestId = String(authStep.requestId ?? "")
  if (!requestId) throw new Error("Relay quote missing requestId")
  if (String(depStep.requestId ?? requestId) !== requestId)
    throw new Error("Relay quote requestId mismatch between steps")
  // What the user actually pays: relayer + app, minus whatever our sponsorship absorbed.
  const feeUsd = Math.max(
    0,
    Number(d.fees?.relayer?.amountUsd ?? 0) +
      Number(d.fees?.app?.amountUsd ?? 0) -
      Number(d.fees?.subsidized?.amountUsd ?? 0),
  )
  return {
    authorize: { sign: auth.data.sign, post: auth.data.post },
    deposit: { parameters: dep.data.action.parameters, nonce, check: dep.check },
    requestId,
    receiveUsd: String(d.details?.currencyOut?.amountFormatted ?? "?"),
    receiveRaw: String(d.details?.currencyOut?.amount ?? ""),
    totalFeeUsd: feeUsd.toFixed(2),
    timeEstimate: Number(d.details?.timeEstimate ?? 0),
  }
}
