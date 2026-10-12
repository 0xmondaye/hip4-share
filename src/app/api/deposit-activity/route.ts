// Live deposit status for the Deposit dialog, read from Relay's
// GET /requests/v3 and filtered to one deposit address.
//
// This exists ONLY because v3 made auth mandatory: "x-api-key is now required.
// Every v3 request authenticates against an active API key." v2 allowed the
// keyless browser fetch this replaces; v3 answers a keyless call with
// 400 FST_ERR_VALIDATION and a bogus key with 401, so the call has to sit
// server-side where RELAY_API_KEY lives. The key is a secret — never
// NEXT_PUBLIC (see the deposit-address route, same rule).
//
// v2 is deprecated (2026-07-22), staged-throttled from 2026-09-01, and retired
// 2026-11-24.
//
// ponytail: no cache and no rate limit. The response is a public, per-address
// read the caller could get from Relay themselves with their own key, and the
// dialog polls it every 5s only while open.

import { NextResponse } from "next/server"
import { RELAY_API } from "@/lib/relay-withdraw-core"
import { parseDepositActivity } from "@/lib/relay-activity"

export const maxDuration = 20

export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get("address") ?? ""
  // EVM deposit addresses only — this is the Relay-minted Arbitrum address
  if (!/^0x[0-9a-fA-F]{40}$/.test(address))
    return NextResponse.json({ activity: [] }, { headers: { "Cache-Control": "no-store" } })

  const key = process.env.RELAY_API_KEY
  // No key ⇒ no live status. Deliberately not an error: the deposit itself is
  // keyless and works fine, the dialog just can't narrate it. Logged once so a
  // missing prod key doesn't read as "Relay is quiet".
  if (!key) {
    console.warn("[relay] RELAY_API_KEY unset — /requests/v3 needs it, deposit status unavailable")
    return NextResponse.json({ activity: [] }, { headers: { "Cache-Control": "no-store" } })
  }

  try {
    const url =
      `${RELAY_API}/requests/v3?depositAddress=${address}` +
      `&sortBy=createdAt&sortDirection=desc&limit=5`
    const res = await fetch(url, { headers: { "x-api-key": key }, cache: "no-store" })
    if (!res.ok) {
      // Loud on the server. The old client-side version swallowed every failure,
      // which is precisely how a year-long deprecation went unnoticed.
      console.error(`[relay] requests/v3 -> ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return NextResponse.json({ activity: [] }, { headers: { "Cache-Control": "no-store" } })
    }
    return NextResponse.json(
      { activity: parseDepositActivity(await res.json()) },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (e) {
    console.error("[relay] requests/v3 fetch failed:", e)
    return NextResponse.json({ activity: [] }, { headers: { "Cache-Control": "no-store" } })
  }
}
