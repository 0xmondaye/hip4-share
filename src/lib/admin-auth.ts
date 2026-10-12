// The admin credential check, in one place. Both the proxy (which challenges
// the browser) and the admin API route (which must not depend on the proxy
// having run) call this, so there is exactly one definition of "is an admin"
// and no way for the two to drift apart.
//
// Own module with no "@/" imports so the test runs under plain node.

/** Constant-time compare. Hand-rolled rather than node:crypto's
 *  timingSafeEqual so it runs on any runtime these callers compile for.
 *  Length difference is folded into the accumulator instead of returning
 *  early, so the loop can't be used to measure the key's length. */
export function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

/**
 * Does this request carry the admin password in an HTTP Basic header?
 * The username is ignored — the password is the whole credential.
 *
 * `key` is passed in rather than read from the environment so this stays pure
 * and testable. Callers read GACHA_GIFT_ADMIN_KEY: already the secret that
 * authorizes spending house money on free packs, which is what this panel
 * does. An unset key means NOT authorized — the panel must fail closed.
 */
export function adminOk(req: Request, key: string | undefined): boolean {
  if (!key) return false
  const [scheme, encoded] = (req.headers.get("authorization") ?? "").split(" ")
  if (scheme?.toLowerCase() !== "basic" || !encoded) return false
  try {
    // the password may itself contain ":" — take everything after the first
    return safeEqual(atob(encoded).split(":").slice(1).join(":"), key)
  } catch {
    return false // malformed base64
  }
}

/**
 * The second way in: a signed-in Privy user whose verified email is on this
 * list is an admin, no Basic password needed. The emails must come from
 * requireUserEmails (Privy-verified), never from anything the client typed.
 *
 * ponytail: hardcoded list, no env var and no table — three people, and adding
 * a fourth is a one-line PR. Move to storage when admins churn without deploys.
 */
export const ADMIN_EMAILS = ["admin1@example.com", "admin2@example.com", "admin3@example.com"]

/** The matching admin email, or null. `emails` are lowercased by
 *  emailsFromLinkedAccounts; compare accordingly. Returns the EMAIL rather than
 *  a boolean because the audit log needs to record who acted. */
export function adminEmailOf(emails: string[]): string | null {
  return emails.find((e) => ADMIN_EMAILS.includes(e)) ?? null
}

/**
 * CSRF gate for admin mutations. Cookie-authenticated POSTs (the Privy email
 * path) — and Basic, which browsers also re-send automatically — can be fired
 * by any site the admin visits, so a mutation must prove it came from our own
 * page. Sec-Fetch-Site is the browser's own word and can't be forged from JS;
 * Origin is the fallback for older browsers. A request with neither header is
 * not from a browser (curl + Basic) and has no CSRF surface.
 */
export function sameOriginOk(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site")
  if (site) return site === "same-origin"
  const origin = req.headers.get("origin")
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.get("host")
  } catch {
    return false // malformed Origin proves nothing — refuse
  }
}

// --- Basic brute-force damper -----------------------------------------------
// Counts FAILED Basic attempts per key (caller passes the IP). Pure so it can
// be tested; the proxy owns the Map. ponytail: fixed window, per-edge-instance
// memory, resets on deploy — a damper, not a guarantee. Move to a store (Neon,
// Upstash) if the key ever needs real online-guessing resistance; its length
// is the actual defense.
export const FAIL_LIMIT = 20
export const FAIL_WINDOW_MS = 10 * 60_000

export interface FailRec {
  n: number
  at: number
}

export function tooManyFails(rec: FailRec | undefined, now: number): boolean {
  return !!rec && now - rec.at < FAIL_WINDOW_MS && rec.n >= FAIL_LIMIT
}

/** The record after one more failure. An expired window starts over. */
export function bumpFail(rec: FailRec | undefined, now: number): FailRec {
  return rec && now - rec.at < FAIL_WINDOW_MS ? { n: rec.n + 1, at: rec.at } : { n: 1, at: now }
}
