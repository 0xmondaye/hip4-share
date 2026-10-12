// Proxies the hip4 dashboard leaderboard so the client can fetch it without
// ever seeing the dashboard API key (server-only env, same rule as
// RELAY_API_KEY). The dashboard returns raw login emails, so identity is
// masked here before it ever crosses to the browser.
//
// Caching: upstream is ~7s cold, and fetches with an Authorization header can
// opt out of Next's data cache — so the result is cached via unstable_cache
// (same pattern as hl-cached.ts: background revalidate, a failed refresh
// keeps serving the last good value). Cache-Control lets Vercel's CDN serve
// repeat hits without invoking this function at all.
import { unstable_cache } from "next/cache"
import {
  maskOwner,
  shortAddr,
  type LeaderboardRow,
} from "@/lib/leaderboard"
import { topSpenders } from "@/lib/gacha-server/spend"

const DASHBOARD_URL =
  process.env.HIP4_DASHBOARD_URL ?? "https://hip4-dashboard-phi.vercel.app"

async function fetchRows() {
  const res = await fetch(
    `${DASHBOARD_URL}/api/leaderboard?metric=volume&limit=50`,
    {
      // Server-to-server API key auth (120 req/min tier); we make ~1 call
      // per 5 min thanks to unstable_cache, so rate limits are a non-issue.
      headers: { "X-API-Key": process.env.HIP4_DASHBOARD_API_KEY ?? "" },
      cache: "no-store", // unstable_cache owns caching; don't double-cache
    },
  )
  const data = (await res.json().catch(() => null)) as {
    leaderboard?: LeaderboardRow[]
  } | null
  if (!res.ok || !Array.isArray(data?.leaderboard))
    throw new Error(`dashboard leaderboard failed (${res.status})`)
  // Mask server-side: raw emails must never cross to the browser at all.
  return data.leaderboard.map((r) => ({
    rank: r.rank,
    name: maskOwner(r.owner, r.address),
    address: shortAddr(r.address),
    tradeCount: r.tradeCount,
    hip4VolumeUSDC: r.hip4VolumeUSDC,
  }))
}

const cachedRows = unstable_cache(fetchRows, ["hip4-leaderboard"], {
  revalidate: 300, // dashboard itself revalidates every 5 min
})

// ?metric=packs — gacha spend, straight out of Neon (gacha-server/spend.ts).
// Own branch rather than a dashboard metric: the dashboard has no view of pack
// purchases, they only exist in this app's DB. Same Row shape as volume so the
// page renders both with one component.
async function packRows() {
  const rows = await topSpenders(50)
  return rows.map((r, i) => ({
    rank: i + 1,
    // no owner identity available: gacha rows key on the Privy DID and this
    // app has no Privy app secret to resolve it (see gacha-server/gate.ts).
    // ponytail: bank the HL address at payin-quote if masked emails matter.
    name: shortAddr(r.addr),
    address: "",
    tradeCount: r.pulls,
    hip4VolumeUSDC: r.cents / 100,
  }))
}

export async function GET(req: Request) {
  if (new URL(req.url).searchParams.get("metric") === "packs") {
    if (!process.env.DATABASE_URL)
      return Response.json({ message: "Leaderboard not configured" }, { status: 503 })
    const rows = await packRows().catch(() => null)
    if (!rows)
      return Response.json({ message: "Leaderboard unavailable" }, { status: 502 })
    return Response.json(
      { rows },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
    )
  }
  if (!process.env.HIP4_DASHBOARD_API_KEY)
    return Response.json({ message: "Leaderboard not configured" }, { status: 503 })
  const rows = await cachedRows().catch(() => null)
  if (!rows)
    return Response.json({ message: "Leaderboard unavailable" }, { status: 502 })
  return Response.json(
    { rows },
    {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=86400",
      },
    },
  )
}
