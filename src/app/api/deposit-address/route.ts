// Mints the user's Relay deposit address server-side so the quote can carry
// our secret x-api-key (fee sponsorship: user deposits 100 USDC, receives
// 100 USDC on Hyperliquid; relayer fees draw from our Relay app balance).
// No RELAY_API_KEY set ⇒ keyless quote, user bears relayer fees (dev default).
//
// ponytail: no rate limit — worst case an attacker mints addresses (free) or
// makes real deposits costing us ~$0.03 relayer fee each; add per-IP limiting
// if app-balance drain ever shows up in the Relay dashboard.
import { DEPOSIT_CHAINS, depositQuoteBody } from "@/lib/relay-deposit-core"

const RELAY_API = "https://api.relay.link"

export async function POST(req: Request) {
  const { user, chainId } = (await req.json().catch(() => ({}))) as {
    user?: string
    chainId?: number
  }
  const chain = DEPOSIT_CHAINS.find((c) => c.chainId === chainId)
  if (!chain || typeof user !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(user))
    return Response.json({ message: "Bad request" }, { status: 400 })

  const key = process.env.RELAY_API_KEY
  // Per-deposit sponsorship cap, in whole USDC (default 5). Required: an
  // absent maxSubsidizationAmount is treated as cap 0 → sponsored $0 and the
  // user pays everything (real HL execution fee is ~$1.21/deposit). If fees
  // ever exceed the cap, deposit-address semantics dump ALL fees on the
  // user — keep it comfortably above the observed fee.
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
    // No appFees on deposits: app fees are deducted from the deposit and are
    // NOT sponsorable, so any app fee breaks the 1:1 promise (100 in = 100
    // out). Withdraw keeps its app fee (relay-withdraw.ts).
    body: JSON.stringify(
      depositQuoteBody(
        user,
        chain,
        undefined,
        key ? String(capUsdc * 1_000_000) : undefined,
      ),
    ),
  })
  const data = (await res.json().catch(() => ({}))) as {
    steps?: { depositAddress?: string }[]
    fees?: { subsidized?: { amount?: string } }
    message?: string
  }
  if (!res.ok)
    return Response.json(
      { message: data.message ?? `Relay quote failed (${res.status})` },
      { status: 502 },
    )
  const address = data.steps?.[0]?.depositAddress
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address))
    return Response.json(
      { message: "Relay did not return a deposit address" },
      { status: 502 },
    )
  // Trust the quote, not our intent: keyless quotes silently ignore
  // subsidizeFees, so only claim sponsorship if Relay actually subsidized.
  const subsidized = data.fees?.subsidized?.amount
  const sponsored = Boolean(key) && Boolean(subsidized) && subsidized !== "0"
  return Response.json({ address, sponsored })
}
