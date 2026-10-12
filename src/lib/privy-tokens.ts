// One Privy token lookup shared by every API client.
//
// Privy's SDK refreshes tokens by calling auth.privy.io/api/v1/users/me, and
// asking for a token is not free: a pack page fires five Slabz calls in
// parallel (four rarity filters + the pack), each of which used to ask on its
// own, and React StrictMode doubles that in dev. That alone trips Privy's
// rate limit, and once 429'd the identity token can never refresh — which is
// why gated routes start answering "missing identity token" out of nowhere.
//
// So: single-flight (concurrent callers share one lookup) plus a short TTL
// (repeat callers reuse the result). Callers that get a 401 pass force=true,
// which is what recovers a genuinely stale token.

export interface PrivyTokens {
  /** access token — proves WHO (the DID) */
  token: string | null
  /** identity token — carries linked accounts, needed by the allowlist gate */
  idToken: string | null
}

const NONE: PrivyTokens = { token: null, idToken: null }

/** Cache + single-flight around any token loader. Exported for the test;
 *  production uses the `privyTokens` instance below. */
export function makeTokenCache(load: () => Promise<PrivyTokens>, ttlMs = 60_000) {
  let cache: { at: number; p: Promise<PrivyTokens> } | null = null
  let inflight: Promise<PrivyTokens> | null = null

  return function get(force = false, now = () => Date.now()): Promise<PrivyTokens> {
    if (!force && cache && now() - cache.at < ttlMs) return cache.p
    // a lookup already running serves everyone, forced or not — a stampede of
    // forced refreshes is exactly what the rate limit punishes
    if (inflight) return inflight
    const p = load().catch(() => NONE)
    inflight = p
    // Cache the RESULT only when there is one. A signed-out page load used to
    // park {token:null} here for the full TTL, so signing in changed nothing
    // for a minute and every route answered "missing access token". Concurrent
    // callers still coalesce on `inflight`, which is what the rate limit cares
    // about; a signed-out lookup is local to the SDK and costs no request.
    // both attached to `p` directly, NOT chained: a chained .finally clears
    // `inflight` one microtask late, and a force() landing in that gap joins
    // the lookup it meant to bypass
    void p.then((t) => {
      if (t.token) cache = { at: now(), p }
    })
    void p.finally(() => {
      if (inflight === p) inflight = null
    })
    return p
  }
}

/** Dynamic import: this module is reachable from code that also runs on the
 *  server (slabz.ts), where @privy-io/react-auth must never be pulled in. */
async function loadFromPrivy(): Promise<PrivyTokens> {
  if (typeof window === "undefined") return NONE
  const { getAccessToken, getIdentityToken } = await import("@privy-io/react-auth")
  // allSettled: one failing lookup must not discard the other, or a working
  // access token gets thrown away with the rate-limited identity token
  const [a, b] = await Promise.allSettled([getAccessToken(), getIdentityToken()])
  return {
    token: a.status === "fulfilled" ? (a.value ?? null) : null,
    idToken: b.status === "fulfilled" ? (b.value ?? null) : null,
  }
}

export const privyTokens = makeTokenCache(loadFromPrivy)

/** Ready-made headers for our own API routes. */
export async function privyAuthHeaders(force = false): Promise<Record<string, string>> {
  const { token, idToken } = await privyTokens(force)
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(idToken ? { "privy-id-token": idToken } : {}),
  }
}
