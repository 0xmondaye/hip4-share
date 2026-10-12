// Server-side Relay calls for the gacha legs. Quotes carry the secret
// RELAY_API_KEY (fee sponsorship — never NEXT_PUBLIC, per the deposit route).
// Status polling is keyless.

import {
  RELAY_API,
  parseWithdrawQuote,
  type WithdrawQuote,
} from "@/lib/relay-withdraw-core"
import {
  buildPayinQuoteBody,
  buildPayoutQuoteBody,
  parseSolanaQuote,
  quoteCovers,
  type SolanaQuoteStep,
} from "@/lib/gacha-relay-core"
import { displayCents, markupBps, payinQuoteOk } from "@/lib/gacha-core"
import { assembleInstructionsTxB64 } from "./svm-tx"
import { executorSigner } from "./gas-sponsor"

const SUBSIDY_CAP_USDC = Math.max(
  1,
  Math.floor(Number(process.env.RELAY_MAX_SUBSIDY_USDC ?? 5)),
)

async function relayQuote(body: unknown): Promise<unknown> {
  const key = process.env.RELAY_API_KEY
  if (!key)
    throw Object.assign(new Error("RELAY_API_KEY not set (gacha legs are sponsored)"), {
      code: "NOT_CONFIGURED",
    })
  const res = await fetch(`${RELAY_API}/quote/v2`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as { message?: string } | null
  if (!res.ok || !data)
    throw new Error(data?.message ?? `Relay quote failed (${res.status})`)
  return data
}

/**
 * Sponsored pay-in quote: user HL → user's OWN Solana wallet, charging
 * price + markup and clawing the markup back as an appFee. The client
 * executes it with the existing executeWithdraw machinery.
 */
export async function payinQuote(input: {
  userHlAddr: string
  userSolAddr: string
  priceCents: number
  /** this pack's markup (gacha-core.markedPack) — 0 outside the marked
   *  collection, which quotes with no appFee at all */
  markupCents: number
}): Promise<{ quote: WithdrawQuote; totalCents: number }> {
  // hard-fail when the fee recipient is unset: without an appFee the quote
  // delivers the full total to the user's wallet and the markup is silently
  // gifted — payinQuoteOk below would catch it, but this error is clearer
  const feeRecipient = process.env.NEXT_PUBLIC_RELAY_FEE_RECIPIENT
  if (input.markupCents > 0 && !feeRecipient)
    throw Object.assign(
      new Error("NEXT_PUBLIC_RELAY_FEE_RECIPIENT not set (collects the pack markup)"),
      { code: "NOT_CONFIGURED" },
    )
  const totalCents = displayCents(input)
  const data = await relayQuote(
    buildPayinQuoteBody({
      userHlAddr: input.userHlAddr,
      userSolAddr: input.userSolAddr,
      totalCents,
      appFeeRecipient: feeRecipient,
      appFeeBps: markupBps(input.priceCents, input.markupCents),
      subsidyCapUsdc: SUBSIDY_CAP_USDC,
    }),
  )
  const quote = parseWithdrawQuote(data)
  // trust boundary, both directions: short ⇒ the Slabz buy fails AFTER the
  // user's money moved (a cap-hit quote once delivered 24.85 for a $25 pack);
  // over ⇒ Relay dropped/ignored the appFee and the markup leaks to the user.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appFeeUsd = Number((data as any)?.fees?.app?.amountUsd ?? 0)
  if (
    !payinQuoteOk({
      receiveRaw: quote.receiveRaw,
      appFeeUsd,
      priceCents: input.priceCents,
      markupCents: input.markupCents,
    })
  )
    throw Object.assign(
      new Error(
        `Relay pay-in quote delivers ${quote.receiveUsd} USDC with app fee $${appFeeUsd} — expected ~${(input.priceCents / 100).toFixed(2)} delivered + ${(input.markupCents / 100).toFixed(2)} fee; check appFees support and sponsorship`,
      ),
      { code: "QUOTE_SHORT" },
    )
  return { quote, totalCents }
}

/**
 * Sponsored payout quote: user's Solana wallet → user's HL account,
 * sweep-all. `amountUnits6` must be the wallet's on-chain USDC balance in
 * raw 6dp units, read server-side.
 */
export async function payoutQuote(input: {
  userSolAddr: string
  userHlAddr: string
  amountUnits6: string
}): Promise<{ requestId: string; step: SolanaQuoteStep; checkEndpoint: string }> {
  const data = await relayQuote(
    buildPayoutQuoteBody({ ...input, subsidyCapUsdc: SUBSIDY_CAP_USDC }),
  )
  const quote = parseSolanaQuote(data)
  // same trust boundary on the way out: sponsored, so HL must receive the
  // full swept amount (6dp origin → 8dp destination = ×100), 1¢ slack for
  // Relay's own rounding
  const required = BigInt(input.amountUnits6) * BigInt(100) - BigInt(1_000_000)
  if (!quoteCovers(quote.receiveRaw, String(required > BigInt(0) ? required : BigInt(0))))
    throw Object.assign(
      new Error(
        `Relay payout quote delivers short of ${(Number(input.amountUnits6) / 1e6).toFixed(2)} USDC — check fee sponsorship`,
      ),
      { code: "QUOTE_SHORT" },
    )
  // Live 2026-08-01: SVM-origin steps arrive as an instruction list —
  // assemble the unsigned v0 tx here with the HOUSE fee payer (server-side
  // gas sponsorship: the user signs their slot, /api/gacha/payout-send
  // verifies + co-signs + broadcasts; the user wallet needs zero SOL).
  if (quote.step.kind === "instructions") {
    const feePayer = (await executorSigner()).address
    return {
      ...quote,
      step: {
        kind: "serialized",
        transaction: await assembleInstructionsTxB64(feePayer, quote.step),
      },
    }
  }
  // a Relay-serialized tx would carry the user's zero-SOL wallet as fee
  // payer and die on-chain — fail before anyone signs (never seen live)
  throw new Error("Relay payout returned a pre-serialized tx — unsupported with house sponsorship")
}

export type RelayStatus = "success" | "pending" | "failure" | "refund" | "unknown"

/** Keyless request status — the oracle for both legs. */
export async function relayRequestStatus(requestId: string): Promise<RelayStatus> {
  const res = await fetch(
    `${RELAY_API}/intents/status/v3?requestId=${encodeURIComponent(requestId)}`,
    { cache: "no-store" },
  )
  if (!res.ok) return "unknown"
  const s = String(((await res.json().catch(() => ({}))) as { status?: string }).status ?? "")
  if (s === "success" || s === "failure" || s === "refund" || s === "pending") return s
  // documented intermediates "waiting"/"submitted" (status v3) — treat as pending
  return s ? "pending" : "unknown"
}
