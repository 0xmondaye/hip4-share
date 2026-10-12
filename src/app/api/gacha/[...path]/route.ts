import { after, NextRequest, NextResponse } from "next/server"
import { isAllowed, UUID } from "@/lib/slabz-proxy"
import { CDN_OK, proxyCatalogGet, SLABZ_BASE } from "@/lib/gacha-server/proxy-core"
import { requireGachaAccess } from "@/lib/gacha-server/gate"
import { AuthError } from "@/lib/gacha-server/auth"
import { GachaError } from "@/lib/gacha-server/http"
import { bankPurchase, markPaid, parsePurchase } from "@/lib/gacha-server/spend"
import { getPack } from "@/lib/gacha-server/slabz"

// Server-side proxy to the Slabz partner API. SLABZ_API_KEY is a secret —
// never NEXT_PUBLIC, never sent to the browser. Unset key ⇒ 503 so the UI
// can show a "not configured" state instead of breaking.
//
// Catalog GETs (packs*) are public — browsing is open to everyone. POSTs
// (purchase/submit/open/buyback) and transaction GETs run through the gacha
// gate: they spend our Slabz quota and, ungated, would let anyone pull packs
// at the raw price on our API key, skipping auth, allowlist and markup.
// Accepted write-down (whitelist beta): the wallet address in the body is
// NOT bound to the caller's Privy account — signing keeps funds safe, and a
// self-funded wallet can pull without the markup; revisit before opening up.

// buyback/submit is SYNCHRONOUS and gated on Solana confirmation — the one POST
// through here that legitimately blocks for many seconds. At the platform
// default (~10-15s) the invocation is killed under congestion, the browser sees
// a 504, and the client is pushed down its ambiguous-outcome recovery path for a
// sale that actually succeeded. Every other money route pins its own budget
// (payout-quote 60, payout-send 30, redeem-fund 60, payin-quote 60); this one
// carries submit, purchase and open and pinned nothing.
export const maxDuration = 60

async function proxy(req: NextRequest, path: string[]) {
  const key = process.env.SLABZ_API_KEY
  if (!key) {
    return NextResponse.json(
      { success: false, error: { code: "NOT_CONFIGURED", message: "SLABZ_API_KEY not set" } },
      { status: 503 },
    )
  }
  const joined = path.join("/")
  if (!isAllowed(req.method, joined)) {
    return NextResponse.json(
      { success: false, error: { code: "FORBIDDEN_PATH", message: "Path not allowed" } },
      { status: 403 },
    )
  }
  let userId = ""
  if (req.method === "POST" || joined.startsWith("transactions") || joined.startsWith("gifts")) {
    try {
      ;({ userId } = await requireGachaAccess(req))
    } catch (e) {
      const [code, message, status] =
        e instanceof GachaError
          ? [e.code, e.message, e.status]
          : e instanceof AuthError
            ? ["UNAUTHORIZED", e.message, 401]
            : ["INTERNAL", "gate check failed", 500]
      return NextResponse.json({ success: false, error: { code, message } }, { status })
    }
  }

  // Pack-catalog GETs go through the Neon snapshot pipeline (see proxy-core):
  // Slabz flakiness (random 500s, 60 req/min key limit) never reaches users
  // once a key has succeeded once.
  if (req.method === "GET" && joined.startsWith("packs")) {
    const out = await proxyCatalogGet(joined, req.nextUrl.search)
    if (out.kind === "hit")
      return NextResponse.json(out.json, {
        headers: { "Cache-Control": CDN_OK, "X-Slabz-Cache": "hit" },
      })
    if (out.kind === "stale")
      return NextResponse.json(out.json, {
        headers: { "Cache-Control": CDN_OK, "X-Slabz-Cache": "stale" },
      })
    // after() keeps the snapshot write alive past the response (Vercel
    // freezes fire-and-forget promises — a bare floating write would die)
    const persist = out.persist
    if (persist) after(() => persist())
    return NextResponse.json(out.json, {
      status: out.status,
      headers: {
        // Cache successes only, so a failure never gets served from the CDN.
        "Cache-Control": out.status >= 200 && out.status < 300 ? CDN_OK : "no-store",
      },
    })
  }

  const url = `${SLABZ_BASE}/${joined}${req.nextUrl.search}`
  const headers = {
    "X-API-Key": key,
    ...(req.method === "POST" ? { "Content-Type": "application/json" } : {}),
  }
  const body = req.method === "POST" ? await req.text() : undefined

  // Non-catalog GETs + POSTs pass straight through. A cold load can trip the
  // rate limit and Slabz also 500s at random, so GETs retry here (one server
  // round-trip absorbs both instead of the tile stalling on its skeleton).
  // POSTs never retry — a replayed purchase/open could double-charge. The
  // redeem-session POSTs before prepare/burn spend nothing, so they get the
  // same retry as GETs.
  const retryable = req.method === "GET" || SAFE_POST.test(joined)
  let res: Response | null = null
  for (let i = 0; ; i++) {
    try {
      res = await fetch(url, { method: req.method, headers, body, cache: "no-store" })
      if (!retryable || res.status < 500 || i >= 2) break
    } catch {
      res = null // network-level failure — Slabz hard-down
      if (!retryable || i >= 2) break
    }
    await new Promise((r) => setTimeout(r, 400 * (i + 1) + Math.random() * 400))
  }
  if (res == null) {
    return NextResponse.json(
      { success: false, error: { code: "UPSTREAM_UNREACHABLE", message: "Slabz unreachable" } },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    )
  }
  const text = await res.text().catch(() => "")
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = {}
  }
  // Slabz 5xxs carry the diagnosis (often a non-JSON gateway page) but the
  // client only ever sees "Request failed (n)" — keep the evidence server-side.
  if (res.status >= 500)
    console.error(`[slabz] ${req.method} ${joined} -> ${res.status}: ${text.slice(0, 300)}`)
  if (req.method === "POST" && res.ok && userId) bankSpend(joined, userId, body, json)
  // Pass the rate-limit headers through, and log the budget once we're near it.
  //
  // These were being dropped on the floor, which is why our real limit is still
  // unknown: the docs contradict themselves (getting-started says 600/min total
  // + 300/min purchases, the bulk-purchase page says 60/min) and ground truth
  // can only come from a live X-RateLimit-Limit. Nothing in the app could see
  // one. Retry-After matters too — a 429 is documented to carry the real wait
  // in seconds, and the client was backing off on a hardcoded guess instead.
  const passthrough: Record<string, string> = { "Cache-Control": "no-store" }
  for (const h of ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "Retry-After"]) {
    const v = res.headers.get(h)
    if (v) passthrough[h] = v
  }
  // One line whenever the budget is actually tight or we got limited — enough to
  // settle the 600-vs-60 question from real traffic without logging every call.
  const remaining = Number(passthrough["X-RateLimit-Remaining"] ?? NaN)
  if (res.status === 429 || (Number.isFinite(remaining) && remaining < 30))
    console.warn(
      `[slabz] rate budget ${joined} -> ${res.status} limit=${passthrough["X-RateLimit-Limit"] ?? "?"} remaining=${passthrough["X-RateLimit-Remaining"] ?? "?"} retryAfter=${passthrough["Retry-After"] ?? "-"}`,
    )
  return NextResponse.json(json, { status: res.status, headers: passthrough })
}

// POSTs that spend nothing (redeem-session steps, gift claim challenge) —
// safe to retry like GETs. claim/complete stays no-retry: it consumes a pack.
const SAFE_POST = new RegExp(
  `^transactions/${UUID}/redeem/(auth|auth/verify|addresses|estimate)$|^gifts/${UUID}/claim/init$`,
)
const PURCHASE = new RegExp(`^packs/(${UUID})/purchase$`)
const BULK = new RegExp(`^packs/(${UUID})/bulk-purchase$`)
const SUBMIT = new RegExp(`^transactions/(${UUID})/submit$`)

// Per-user spend for the packs leaderboard (spend.ts). Everything runs in
// after() and swallows its errors: banking a number must never fail a
// purchase, and a floating promise would be frozen by Vercel.
function bankSpend(joined: string, userId: string, body: string | undefined, json: unknown) {
  const purchase = PURCHASE.exec(joined)
  if (purchase) {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(body ?? "")
    } catch {
      /* no body ⇒ no wallet ⇒ parsePurchase returns null */
    }
    const p = parsePurchase(json, parsed)
    if (p)
      after(async () => {
        // the pack's own markup — priceCents is Slabz's raw price, the user
        // pays price + markup (gacha-core.displayCents)
        const markupCents = await getPack(purchase[1]).then(
          (pk) => pk.markupCents,
          () => 0,
        )
        await bankPurchase(userId, p, markupCents).catch(() => {})
      })
    return
  }
  // bulk purchase: one response, N txs — bank each like a single purchase
  // (markPaid flips them per-tx as their submits land, same as singles)
  const bulk = BULK.exec(joined)
  if (bulk) {
    const wallet = (() => {
      try {
        return (JSON.parse(body ?? "") as { walletAddress?: string }).walletAddress ?? ""
      } catch {
        return ""
      }
    })()
    const txs = (json as { data?: { transactions?: unknown } } | null)?.data?.transactions
    if (!wallet || !Array.isArray(txs)) return
    after(async () => {
      const markupCents = await getPack(bulk[1]).then(
        (pk) => pk.markupCents,
        () => 0,
      )
      for (const t of txs) {
        const p = parsePurchase({ data: t }, { walletAddress: wallet })
        if (p) await bankPurchase(userId, p, markupCents).catch(() => {})
      }
    })
    return
  }
  // buyback/submit deliberately excluded — selling back isn't spending
  const submit = SUBMIT.exec(joined)
  if (submit) after(() => markPaid(submit[1]).catch(() => {}))
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return proxy(req, (await params).path)
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return proxy(req, (await params).path)
}
