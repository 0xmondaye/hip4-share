// Quotes a stranded-funds recovery (origin-chain USDC → the user's HL
// account) server-side so the quote can carry our secret x-api-key and the
// relayer fees draw from our Relay app balance — recovery is a deposit, and
// deposits are 1:1 by policy. No key ⇒ keyless quote, user bears the fee.
// The quote JSON is returned verbatim; the client parses and executes it.
//
// ponytail: no rate limit, same reasoning as deposit-address — quotes are
// free and executing one requires a signature only the user can produce.
import { DEPOSIT_CHAINS, recoverQuoteBody } from "@/lib/recover-core"

const RELAY_API = "https://api.relay.link"

export async function POST(req: Request) {
  const { user, chainId, amount } = (await req.json().catch(() => ({}))) as {
    user?: string
    chainId?: number
    amount?: string
  }
  const chain = DEPOSIT_CHAINS.find((c) => c.chainId === chainId)
  if (
    !chain ||
    typeof user !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(user) ||
    typeof amount !== "string" ||
    !/^[1-9]\d{0,14}$/.test(amount) // raw 6-dp units, ≤ ~1e9 USDC
  )
    return Response.json({ message: "Bad request" }, { status: 400 })

  const key = process.env.RELAY_API_KEY
  // Same mandatory-cap rule as deposit-address: absent cap = cap 0 = $0
  // sponsored. Keep well above the ~$1.21 HL execution fee.
  const capUsdc = Math.max(
    1,
    Math.floor(Number(process.env.RELAY_MAX_SUBSIDY_USDC ?? 5)),
  )
  const res = await fetch(`${RELAY_API}/quote`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "x-api-key": key } : {}),
    },
    body: JSON.stringify(
      recoverQuoteBody(
        user,
        chain,
        amount,
        key ? String(capUsdc * 1_000_000) : undefined,
      ),
    ),
  })
  const data = (await res.json().catch(() => ({}))) as { message?: string }
  if (!res.ok)
    return Response.json(
      { message: data.message ?? `Relay quote failed (${res.status})` },
      { status: 502 },
    )
  return Response.json(data)
}
