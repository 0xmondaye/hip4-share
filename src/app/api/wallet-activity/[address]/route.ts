// Proxies the hip4 dashboard wallet deep-dive for the portfolio page's
// app-specific extras: HIP-4 bet stats (tradeCount, hip4VolumeUSDC — computed
// from builder_fills CSVs, not available from HL directly) and the ledger
// (deposits / transfers). Balances, positions and fills stay HL-direct in
// Portfolio.tsx — fresher and free.
//
// The API key is server-only (same rule as RELAY_API_KEY) and the dashboard
// response carries the user's Privy identity (email, privyId) — stripped here,
// only anonymous activity crosses to the browser. X-API-Key is a custom
// header, so Next's data cache applies (the Authorization-header opt-out
// doesn't); revalidate 60s matches the upstream per-wallet cache.
//
// ponytail: no per-IP rate limit — worst case an attacker enumerates
// addresses' public on-chain activity through our 120 req/min upstream quota;
// add limiting if the dashboard ever 429s us.
const DASHBOARD_URL =
  process.env.HIP4_DASHBOARD_URL ?? "https://hip4-dashboard-phi.vercel.app"

type LedgerEntry = { time: number; type: string; usdc: number | null }

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  if (!/^0x[0-9a-fA-F]{40}$/.test(address))
    return Response.json({ message: "Bad address" }, { status: 400 })
  if (!process.env.HIP4_DASHBOARD_API_KEY)
    return Response.json({ message: "Not configured" }, { status: 503 })

  const res = await fetch(`${DASHBOARD_URL}/api/wallets/${address}`, {
    headers: { "X-API-Key": process.env.HIP4_DASHBOARD_API_KEY },
    next: { revalidate: 60 },
  }).catch(() => null)
  if (!res?.ok)
    return Response.json({ message: "Activity unavailable" }, { status: 502 })
  const data = (await res.json().catch(() => null)) as {
    notInPrivy?: boolean
    wallet?: { tradeCount?: number }
    trades?: { appFills?: { price?: number; size?: number }[] }
    ledger?: LedgerEntry[]
  } | null
  if (!data)
    return Response.json({ message: "Activity unavailable" }, { status: 502 })

  // Not an app user (or no data): empty activity, not an error.
  // Volume isn't on the detail endpoint — derive it the way the doc defines
  // hip4VolumeUSDC: sum of size × price across the app's HIP-4 fills.
  const body = data.notInPrivy
    ? { tradeCount: 0, hip4VolumeUSDC: 0, ledger: [] }
    : {
        tradeCount: data.wallet?.tradeCount ?? 0,
        hip4VolumeUSDC: (data.trades?.appFills ?? []).reduce(
          (sum, f) => sum + (f.size ?? 0) * (f.price ?? 0),
          0,
        ),
        // identity (privyId, owner email) deliberately dropped
        ledger: (data.ledger ?? []).map((l) => ({
          time: l.time,
          type: l.type,
          usdc: l.usdc,
        })),
      }
  return Response.json(body, {
    headers: {
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600",
    },
  })
}
