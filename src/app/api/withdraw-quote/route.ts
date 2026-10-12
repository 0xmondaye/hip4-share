// Quotes a withdrawal (HyperCore USDC → Arbitrum) server-side so the quote can carry our
// secret x-api-key and the relayer fee draws from our Relay app balance. The app fee stays on
// the user (see sponsoredFeeComponents in relay-withdraw-core). No key ⇒ keyless quote, the
// user bears the network fee. The quote JSON is returned verbatim; the client parses it.
//
// Signed-in users only: sponsorship is spent when the quote executes, and executing needs
// the user's own signature, but the cap is our money — no reason to hand quotes to curl.
import { requireUser } from "@/lib/gacha-server/auth"
import { errorResponse } from "@/lib/gacha-server/http"
import { buildWithdrawQuoteBody, RELAY_API } from "@/lib/relay-withdraw-core"
import { appFees } from "@/lib/relay-deposit-core"

const ADDR = /^0x[0-9a-fA-F]{40}$/

export async function POST(req: Request) {
  try {
    await requireUser(req)
    const { user, recipient, amountUsd } = (await req.json().catch(() => ({}))) as {
      user?: string
      recipient?: string
      amountUsd?: string
    }
    if (
      typeof user !== "string" || !ADDR.test(user) ||
      typeof recipient !== "string" || !ADDR.test(recipient) ||
      typeof amountUsd !== "string" || !/^\d{1,12}(\.\d{1,8})?$/.test(amountUsd.trim())
    )
      return Response.json({ message: "Bad request" }, { status: 400 })

    const key = process.env.RELAY_API_KEY
    // Same mandatory-cap rule as deposit-address. Keep well above the ~$1.21 HL execution fee.
    const capUsdc = Math.max(1, Math.floor(Number(process.env.RELAY_MAX_SUBSIDY_USDC ?? 5)))
    const res = await fetch(`${RELAY_API}/quote/v2`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { "x-api-key": key } : {}) },
      body: JSON.stringify(
        buildWithdrawQuoteBody({
          user,
          recipient,
          amountUsd: amountUsd.trim(),
          appFees: appFees(),
          subsidyCapUsdc: key ? capUsdc : undefined,
        }),
      ),
    })
    const data = (await res.json().catch(() => ({}))) as { message?: string }
    if (!res.ok)
      return Response.json(
        { message: data.message ?? `Relay quote failed (${res.status})` },
        // 4xx from Relay is the user's input (bad recipient, below minimum): pass it through so
        // the client shows it instead of falling back to a keyless quote.
        { status: res.status >= 500 ? 502 : 400 },
      )
    return Response.json(data)
  } catch (e) {
    return errorResponse(e)
  }
}
