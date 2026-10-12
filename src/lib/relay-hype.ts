"use client"

// HYPE out via Relay: native HYPE on HyperEVM → USDC/ETH on another chain. One transaction on
// HyperEVM (Relay's deposit call, gas from the HYPE itself), then Relay fills on the
// destination. Quote through our route so the relayer fee is sponsored; keyless fallback so
// a broken route costs the user the fee, not the exit.

import type { ConnectedWallet } from "@privy-io/react-auth"
import { sendTxOnHyperEvm } from "./hyperevm-funds"
import { privyAuthHeaders } from "./privy-tokens"
import { pollCheck } from "./recover"
import { appFees } from "./relay-deposit-core"
import { isUserRejection, WithdrawTrackableError } from "./relay-withdraw"
import { buildHypeQuoteBody, parseHypeQuote, RELAY_API, type HypeQuote } from "./relay-withdraw-core"

export type { HypeQuote }

export async function getHypeQuote(input: {
  user: string
  recipient: string
  amountWei: string
  destinationId: string
}): Promise<HypeQuote> {
  let res = await fetch("/api/hype-quote", {
    method: "POST",
    headers: { ...(await privyAuthHeaders()), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).catch(() => null)
  if (!res || res.status === 401 || res.status >= 500)
    res = await fetch(`${RELAY_API}/quote/v2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildHypeQuoteBody({ ...input, appFees: appFees() })),
    })
  const data = (await res.json().catch(() => null)) as { message?: string } | null
  if (!res.ok || !data) throw new Error(data?.message ?? `Relay quote failed (${res.status})`)
  return parseHypeQuote(data)
}

export type HypePhase = "sending" | "filling"

/** Execute a HYPE-out quote. Throws WithdrawTrackableError once the deposit tx is out — from
 *  then on the HYPE is moving and the user gets the Relay link, never a plain failure. */
export async function executeHypeBridge(
  wallet: ConnectedWallet,
  quote: HypeQuote,
  onProgress: (p: HypePhase) => void,
): Promise<{ requestId: string }> {
  let submitted = false
  try {
    for (const item of quote.items) {
      if (item.kind !== "transaction") throw new Error("Unexpected Relay step for a HYPE bridge")
      onProgress("sending")
      await sendTxOnHyperEvm(wallet, {
        to: item.tx.to as `0x${string}`,
        data: item.tx.data as `0x${string}` | undefined,
        value: item.tx.value ? BigInt(item.tx.value) : undefined,
      })
      submitted = true
      if (item.check) {
        onProgress("filling")
        await pollCheck(item.check.endpoint, quote.requestId, "transfer")
      }
    }
  } catch (e) {
    if (submitted && !(e instanceof WithdrawTrackableError) && !isUserRejection(e))
      throw new WithdrawTrackableError(
        "Connection lost mid-transfer — it may still be processing. Track it on Relay.",
        quote.requestId,
      )
    throw e
  }
  return { requestId: quote.requestId }
}
