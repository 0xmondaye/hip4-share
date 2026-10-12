// Quotes a HYPE-out bridge (native HYPE on HyperEVM → the picked chain/token) server-side so
// the quote carries our secret x-api-key and Relay draws the relayer fee from our app balance —
// the deposit-address recipe (subsidizeFees + mandatory cap). The app fee stays on the user, as
// on every withdrawal. No key ⇒ keyless quote, the user bears the network fee. The quote JSON
// is returned verbatim; the client parses and executes it.
import { requireUser } from "@/lib/gacha-server/auth"
import { errorResponse } from "@/lib/gacha-server/http"
import { buildHypeQuoteBody, HYPE_DESTINATIONS, RELAY_API } from "@/lib/relay-withdraw-core"
import { appFees } from "@/lib/relay-deposit-core"

const ADDR = /^0x[0-9a-fA-F]{40}$/

export async function POST(req: Request) {
  try {
    await requireUser(req)
    const { user, recipient, amountWei, destinationId } = (await req.json().catch(() => ({}))) as {
      user?: string
      recipient?: string
      amountWei?: string
      destinationId?: string
    }
    if (
      typeof user !== "string" || !ADDR.test(user) ||
      typeof recipient !== "string" || !ADDR.test(recipient) ||
      typeof amountWei !== "string" || !/^[1-9]\d{0,30}$/.test(amountWei) ||
      !HYPE_DESTINATIONS.some((d) => d.id === destinationId)
    )
      return Response.json({ message: "Bad request" }, { status: 400 })

    const key = process.env.RELAY_API_KEY
    const capUsdc = Math.max(1, Math.floor(Number(process.env.RELAY_MAX_SUBSIDY_USDC ?? 5)))
    const res = await fetch(`${RELAY_API}/quote/v2`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { "x-api-key": key } : {}) },
      body: JSON.stringify(
        buildHypeQuoteBody({
          user,
          recipient,
          amountWei,
          destinationId: destinationId as string,
          appFees: appFees(),
          subsidyCapUsdc: key ? capUsdc : undefined,
        }),
      ),
    })
    const data = (await res.json().catch(() => ({}))) as { message?: string }
    if (!res.ok)
      return Response.json(
        { message: data.message ?? `Relay quote failed (${res.status})` },
        { status: res.status >= 500 ? 502 : 400 },
      )
    return Response.json(data)
  } catch (e) {
    return errorResponse(e)
  }
}
