"use client"

// Withdrawal: HyperCore perps USDC → Arbitrum USDC via Relay. Two EIP-712
// signatures from the MASTER wallet (never the agent key — it must stay
// withdrawal-incapable), zero on-chain transactions:
//   1. RelayNonceMapping "authorize" → POSTed to Relay
//   2. sendAsset (perps USDC → Relay's HyperCore depository) → POSTed to the
//      HL exchange endpoint by the SDK, nonce pinned to match step 1
// Relay's solver then fills on Arbitrum (~2 s).
// Guide: https://docs.relay.link/references/api/api_guides/hyperliquid-support.md

import * as hl from "@nktkas/hyperliquid"
import type { ConnectedWallet } from "@privy-io/react-auth"
import { makeSigner, walletChainIdHex } from "./privy-signer"
import { privyAuthHeaders } from "./privy-tokens"
import { appFees, APP_FEE_BPS, MIN_DEPOSIT_USD } from "./relay"
import {
  RELAY_API,
  buildWithdrawQuoteBody,
  parseWithdrawQuote,
  type WithdrawQuote,
} from "./relay-withdraw-core"

export type { WithdrawQuote }
export const WITHDRAW_FEE_BPS = APP_FEE_BPS
export const MIN_WITHDRAW_USD = MIN_DEPOSIT_USD

export type WithdrawPhase = "authorizing" | "sending" | "filling" | "done"

/** Signatures were submitted — funds moved on HyperCore. The user can track
 * the fill on Relay by requestId; never surface this as a plain failure. */
export class WithdrawTrackableError extends Error {
  constructor(
    message: string,
    public requestId: string,
  ) {
    super(message)
    this.name = "WithdrawTrackableError"
  }
}

/** User declined a wallet signature — nothing was submitted anywhere. */
export function isUserRejection(e: unknown): boolean {
  const code = (e as { code?: number } | null)?.code
  if (code === 4001) return true // EIP-1193 userRejectedRequest
  return e instanceof Error && /reject|denied|cancell?ed/i.test(e.message)
}

export async function getWithdrawQuote(input: {
  user: string
  recipient: string
  amountUsd: string
}): Promise<WithdrawQuote> {
  // Our route carries the secret x-api-key so the relayer fee is sponsored (the user pays the
  // app fee only). If the route itself is down, quote Relay directly — the user then bears the
  // ~$1 network fee, which beats not being able to withdraw at all.
  let res = await fetch("/api/withdraw-quote", {
    method: "POST",
    headers: { ...(await privyAuthHeaders()), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).catch(() => null)
  if (!res || res.status === 401 || res.status >= 500)
    res = await fetch(`${RELAY_API}/quote/v2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildWithdrawQuoteBody({ ...input, appFees: appFees() })),
    })
  const data = (await res.json().catch(() => null)) as { message?: string } | null
  if (!res.ok || !data)
    throw new Error(data?.message ?? `Relay quote failed (${res.status})`)
  return parseWithdrawQuote(data)
}

export async function executeWithdraw(
  wallet: ConnectedWallet,
  quote: WithdrawQuote,
  onProgress: (p: WithdrawPhase) => void,
): Promise<{ requestId: string }> {
  // 1. Authorize. Relay verifies the signature against the EXACT domain it
  // provided (its post.body already carries the matching signatureChainId) —
  // re-domaining to the wallet's active chain 400s for every wallet type.
  // External wallets sign any domain as-is; the Privy embedded wallet only
  // signs at its active chain, so switch it to Relay's domain chain first
  // (headless — showWalletUIs:false — so no UI flash).
  onProgress("authorizing")
  const isEmbedded = wallet.walletClientType === "privy"
  const { sign, post } = quote.authorize
  const relayChainId = Number((sign.domain as { chainId?: number }).chainId)
  const switched = isEmbedded && Number.isFinite(relayChainId)
  if (switched) await wallet.switchChain(relayChainId)
  const signer = await makeSigner(wallet)
  // wallet.chainId can be stale right after switchChain — derive, don't read.
  const chainHex = switched
    ? (`0x${relayChainId.toString(16)}` as `0x${string}`)
    : walletChainIdHex(wallet)
  // Both signer flavors (embedded LocalAccount, external WalletClient) take
  // this shape at runtime; their generic signatures just don't unify.
  const signTyped = signer.signTypedData as (args: {
    domain: Record<string, unknown>
    types: Record<string, unknown>
    primaryType: string
    message: Record<string, unknown>
  }) => Promise<`0x${string}`>
  const signature = await signTyped({
    domain: sign.domain,
    types: sign.types,
    primaryType: sign.primaryType,
    message: sign.value,
  })
  // The signature rides as a QUERY PARAM, not a body field (Relay HL guide;
  // body-field variant 400s "Bad Request" — verified against the live API).
  const authRes = await fetch(
    `${RELAY_API}${post.endpoint}?signature=${signature}`,
    {
      method: post.method || "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(post.body),
    },
  )
  if (!authRes.ok) {
    // Keep Relay's raw body in the error — a bare "(400)" told us nothing
    // when Rabby users hit this in the field.
    const text = await authRes.text().catch(() => "")
    let msg: string | undefined
    try {
      msg = (JSON.parse(text) as { message?: string }).message
    } catch {}
    throw new Error(
      msg ?? `Relay authorize failed (${authRes.status}): ${text.slice(0, 300)}`,
    )
  }

  // 2. sendAsset with the SAME nonce (or Relay can't match the transfer).
  // The SDK signs HyperliquidSignTransaction typed data and submits the
  // correct wire format; nonceManager pins the nonce from the quote.
  onProgress("sending")
  const p = quote.deposit.parameters
  const exchange = new hl.ExchangeClient({
    transport: new hl.HttpTransport(),
    wallet: signer,
    signatureChainId: chainHex,
    nonceManager: () => quote.deposit.nonce,
  })
  try {
    await exchange.sendAsset({
      destination: p.destination as `0x${string}`,
      sourceDex: p.sourceDex,
      destinationDex: p.destinationDex,
      token: p.token,
      amount: p.amount,
      fromSubAccount: p.fromSubAccount ?? "",
    })
  } catch (e) {
    // Only two outcomes leave the funds untouched for certain: the user
    // declined the signature, or HL definitively rejected the action. Any
    // other failure (transport drop, timeout) is ambiguous — the transfer may
    // have been accepted, so the user must get the Relay tracking link.
    if (isUserRejection(e) || e instanceof hl.ApiRequestError) throw e
    throw new WithdrawTrackableError(
      "Connection lost while submitting — the transfer may still be processing. Track it on Relay.",
      quote.requestId,
    )
  }

  // 3. Funds moved — from here every failure must carry the requestId.
  onProgress("filling")
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    let status = ""
    try {
      const res = await fetch(`${RELAY_API}${quote.deposit.check.endpoint}`, {
        cache: "no-store",
      })
      status = String(((await res.json()) as { status?: string }).status ?? "")
    } catch {
      /* transient poll error — keep trying until the deadline */
    }
    if (status === "success") {
      onProgress("done")
      return { requestId: quote.requestId }
    }
    if (status === "failure" || status === "refund")
      throw new WithdrawTrackableError(
        status === "refund"
          ? "Relay refunded the transfer to your Hyperliquid account."
          : "Relay reported the fill failed.",
        quote.requestId,
      )
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new WithdrawTrackableError(
    "Still processing — track the withdrawal on Relay.",
    quote.requestId,
  )
}
