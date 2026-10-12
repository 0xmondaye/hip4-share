// One gate for the whole admin surface. Two ways in, checked in this order:
// HTTP Basic (the break-glass credential — browser owns the prompt, no login
// page, no key in JS) and a signed-in Privy session whose verified email is on
// the admin list (the everyday path — no password at all).
//
// The credential checks live in lib/admin-auth.ts because the admin API route
// runs them too: a route that only trusts a proxy is one config typo (or one
// middleware-bypass CVE) away from being open.
//
// Also enforced here, for every /admin response:
//  - host isolation: with ADMIN_HOST set, the admin surface exists ONLY on
//    that host and 404s everywhere else, so the user-facing domain simply has
//    no admin attack surface. Unset = same-domain (current deploy).
//  - a brute-force damper on failed Basic attempts (per IP, in-memory).
//  - CSRF: mutations must originate from our own page (see sameOriginOk).
//  - cache/embed/index hardening headers on everything under /admin.

import { NextResponse, type NextRequest } from "next/server"
import {
  adminEmailOf,
  adminOk,
  bumpFail,
  sameOriginOk,
  tooManyFails,
  type FailRec,
} from "@/lib/admin-auth"
import { requireUserEmails } from "@/lib/gacha-server/auth"

// One prefix covers the page AND its API (/admin/api) — see the route file:
// that is what keeps the browser re-sending Basic credentials on fetches.
export const config = { matcher: ["/admin", "/admin/:path*"] }

const harden = (res: NextResponse) => {
  // The panel shows every user's unmasked email — it must never be cached,
  // framed (clickjacking) or indexed, and must not leak URLs via Referer.
  res.headers.set("Cache-Control", "no-store")
  res.headers.set("X-Frame-Options", "DENY")
  res.headers.set("Referrer-Policy", "no-referrer")
  res.headers.set("X-Robots-Tag", "noindex, nofollow")
  return res
}

const challenge = () =>
  harden(
    new NextResponse("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="hip4 admin", charset="UTF-8"' },
    }),
  )

// ponytail: per-edge-instance Map — see admin-auth.ts on why that's enough here
const fails = new Map<string, FailRec>()
const ipOf = (req: NextRequest) =>
  req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"

export async function proxy(req: NextRequest) {
  // Host isolation: when an admin host is configured, /admin does not exist
  // anywhere else — not 401, GONE. 404 matches what any other unknown path
  // on the user-facing domain returns, so there is nothing to probe.
  const adminHost = process.env.ADMIN_HOST
  if (adminHost && req.headers.get("host") !== adminHost)
    return new NextResponse("Not found", { status: 404 })

  const key = process.env.GACHA_GIFT_ADMIN_KEY
  // Fail CLOSED. An unset key locks the panel; it never opens it.
  if (!key)
    return new NextResponse("Admin not configured (GACHA_GIFT_ADMIN_KEY unset)", {
      status: 503,
    })

  // Mutations must come from our own page, whoever the caller is — cookies and
  // Basic both ride cross-site, so authentication alone can't prove intent.
  if (req.method !== "GET" && req.method !== "HEAD" && !sameOriginOk(req))
    return harden(new NextResponse("Cross-site request refused", { status: 403 }))

  const ip = ipOf(req)
  const presentedBasic = (req.headers.get("authorization") ?? "")
    .toLowerCase()
    .startsWith("basic ")
  if (presentedBasic && tooManyFails(fails.get(ip), Date.now()))
    return harden(new NextResponse("Too many attempts — try later", { status: 429 }))

  if (adminOk(req, key)) return harden(NextResponse.next())
  // Only a WRONG password feeds the damper; a signed-out page load (no header,
  // browser about to show the prompt) is not an attack.
  if (presentedBasic) {
    if (fails.size > 10_000) fails.clear() // an IP-spray must not grow memory forever
    fails.set(ip, bumpFail(fails.get(ip), Date.now()))
  }

  // The everyday path: a signed-in Privy user with a verified admin email. The
  // Privy cookies ride along on same-origin requests, so an admin who is
  // already logged into the app never sees the Basic prompt at all.
  try {
    if (adminEmailOf((await requireUserEmails(req)).emails))
      return harden(NextResponse.next())
  } catch {
    /* not signed in, or token unusable — fall back to the Basic prompt */
  }
  return challenge()
}
