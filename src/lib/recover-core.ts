// Pure helpers for the stranded-funds recovery flow — no browser APIs, no
// network — testable under node (see recover.test.mjs).
//
// "Stranded" = USDC sitting at the user's own wallet address on an origin
// chain instead of inside their Hyperliquid account. The two ways this
// happens in the field:
//   1. User copies their HL address from the direct-deposit dialog, then
//      withdraws from a CEX on Arbitrum/Base/... to it (wrong network).
//   2. A failed/too-small Relay deposit refunds to the user's address on the
//      origin chain (refundTo), which the app otherwise never shows.
// Recovery = a normal Relay bridge quote from that chain back into the HL
// account, with `usePermit: true` so USDC moves via an EIP-3009 signature —
// no origin-chain gas needed, which matters because embedded wallets hold
// zero ETH/POL. If Relay returns transaction steps instead (permit
// unavailable), execution still works but needs origin gas.

import {
  DEPOSIT_CHAINS,
  HL_CHAIN_ID,
  HL_USDC,
  type DepositChain,
} from "./relay-deposit-core.ts"

export { DEPOSIT_CHAINS, HL_CHAIN_ID, HL_USDC }
export type { DepositChain }

/** Ignore dust below this (raw 6-dp USDC units): quoting it fails or eats
 * more in fees than it recovers. $1. */
export const MIN_RECOVER_RAW = BigInt(1_000_000)

/** Body for POST /quote bridging stranded origin-chain USDC → the user's HL
 * account. Mirrors depositQuoteBody's sponsorship rules: the cap MUST
 * accompany subsidizeFees (absent cap = cap 0 = zero sponsorship), and both
 * are omitted entirely when not sponsoring. */
export function recoverQuoteBody(
  user: string,
  chain: DepositChain,
  amountRaw: string,
  subsidyCapUsdc?: string,
) {
  return {
    user,
    recipient: user,
    originChainId: chain.chainId,
    destinationChainId: HL_CHAIN_ID,
    originCurrency: chain.usdc,
    destinationCurrency: HL_USDC,
    amount: amountRaw,
    tradeType: "EXACT_INPUT" as const,
    // EIP-3009 signature instead of an on-chain transfer — gasless origin.
    usePermit: true,
    // Failed fills refund back to the user on the origin chain (where the
    // scanner will simply find them again).
    refundTo: user,
    ...(subsidyCapUsdc
      ? { subsidizeFees: true, maxSubsidizationAmount: subsidyCapUsdc }
      : {}),
  }
}

export interface RecoverSignatureItem {
  kind: "signature"
  sign: {
    domain: Record<string, unknown>
    types: Record<string, unknown>
    value: Record<string, unknown>
    primaryType: string
  }
  post: { endpoint: string; method: string; body: Record<string, unknown> }
  check?: { endpoint: string; method: string }
}

export interface RecoverTransactionItem {
  kind: "transaction"
  tx: {
    to: string
    data?: string
    value?: string
    chainId?: number
  }
  check?: { endpoint: string; method: string }
}

export type RecoverItem = RecoverSignatureItem | RecoverTransactionItem

export interface RecoverQuote {
  requestId: string
  items: RecoverItem[]
  /** USDC arriving on Hyperliquid, formatted (e.g. "99.98"). */
  receiveUsd: string
}

/** Parse a /quote response into an ordered list of executable items.
 * Tolerates both step kinds; throws on anything it can't execute so the
 * caller never half-runs a quote. */
export function parseRecoverQuote(data: unknown): RecoverQuote {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as any
  const steps: any[] = Array.isArray(d?.steps) ? d.steps : []
  const items: RecoverItem[] = []
  let requestId = ""
  for (const step of steps) {
    if (step?.requestId && !requestId) requestId = String(step.requestId)
    for (const item of step?.items ?? []) {
      if (item?.status === "complete") continue
      const kind = String(step?.kind ?? item?.kind ?? "")
      if (kind === "signature") {
        if (!item?.data?.sign || !item?.data?.post)
          throw new Error("Relay signature step missing sign/post")
        items.push({
          kind,
          sign: item.data.sign,
          post: item.data.post,
          check: item.check,
        })
      } else if (kind === "transaction") {
        if (!item?.data?.to)
          throw new Error("Relay transaction step missing tx data")
        items.push({
          kind,
          tx: {
            to: String(item.data.to),
            data: item.data.data ? String(item.data.data) : undefined,
            value: item.data.value ? String(item.data.value) : undefined,
            chainId: item.data.chainId ? Number(item.data.chainId) : undefined,
          },
          check: item.check,
        })
      } else {
        throw new Error(`Unsupported Relay step kind "${kind}"`)
      }
    }
  }
  if (items.length === 0) throw new Error("Relay quote has no executable steps")
  if (!requestId) throw new Error("Relay quote missing requestId")
  return {
    requestId,
    items,
    receiveUsd: String(d?.details?.currencyOut?.amountFormatted ?? "?"),
  }
}
