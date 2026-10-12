// Verify Privy access tokens (ES256 JWTs) against Privy's public JWKS — no
// app secret needed. Returns the user's DID. Spec gap #1: every order route
// must know WHO is calling; payouts are additionally locked to the address
// that paid in, so a forged/missing token can never redirect funds.

import { createRemoteJWKSet, jwtVerify } from "jose"
import { emailsFromLinkedAccounts, walletsFromLinkedAccounts } from "@/lib/gacha-core"
import { cookieValue } from "./auth-cookie"

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? ""
const APP_SECRET = process.env.PRIVY_APP_SECRET ?? ""

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null

export class AuthError extends Error {
  status = 401
}

export async function requireUser(req: Request): Promise<{ userId: string }> {
  if (!APP_ID) throw new AuthError("auth not configured")
  const token =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    cookieValue(req, "privy-token")
  if (!token) throw new AuthError("missing access token")
  jwks ??= createRemoteJWKSet(
    new URL(`https://auth.privy.io/api/v1/apps/${APP_ID}/jwks.json`),
  )
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: "privy.io",
      audience: APP_ID,
    })
    if (!payload.sub) throw new Error("no sub")
    return { userId: payload.sub }
  } catch {
    throw new AuthError("invalid access token")
  }
}

/**
 * Privy's own user record is the authority on who a DID is. We ask it whenever
 * the identity token can't answer, which is not an edge case: the token rides
 * as a cookie scoped to the custom auth domain, so it never reaches a
 * localhost dev origin at all, and in production the SDK can fail to refresh
 * it (rate limit, PWA storage rules) leaving users locked out of their own
 * packs. The access token already proved the DID — this only resolves what
 * that DID owns.
 */
const subjectCache = new Map<string, { at: number; v: CallerSubjects }>()
const SUBJECT_TTL_MS = 5 * 60_000

interface CallerSubjects {
  emails: string[]
  subjects: string[]
}

/** emails, linked wallets and the DID itself — see requireUserEmails. */
function callerSubjects(userId: string, linkedAccountsJson: string): CallerSubjects {
  const emails = emailsFromLinkedAccounts(linkedAccountsJson)
  return {
    emails,
    subjects: [
      ...emails,
      ...walletsFromLinkedAccounts(linkedAccountsJson),
      userId.toLowerCase(),
    ],
  }
}

async function subjectsFromPrivyApi(userId: string): Promise<CallerSubjects> {
  const hit = subjectCache.get(userId)
  if (hit && Date.now() - hit.at < SUBJECT_TTL_MS) return hit.v
  if (!APP_SECRET) throw new AuthError("missing identity token")

  const res = await fetch(
    `https://auth.privy.io/api/v1/users/${encodeURIComponent(userId)}`,
    {
      headers: {
        // btoa, not Buffer: works on the edge runtime too
        Authorization: `Basic ${btoa(`${APP_ID}:${APP_SECRET}`)}`,
        "privy-app-id": APP_ID,
      },
    },
  )
  if (!res.ok) {
    console.error("[privy] user lookup failed", res.status)
    throw new AuthError("couldn't verify your account — try again")
  }
  const json = (await res.json().catch(() => ({}))) as { linked_accounts?: unknown[] }
  // the REST record carries the same account shapes as the identity token, so
  // one extractor serves both paths
  const v = callerSubjects(userId, JSON.stringify(json.linked_accounts ?? []))
  // ponytail: unbounded map, so dump it wholesale rather than tracking LRU —
  // it is a latency cache, not state
  if (subjectCache.size > 500) subjectCache.clear()
  subjectCache.set(userId, { at: Date.now(), v })
  return v
}

/**
 * Access token proves WHO (DID); what that DID owns comes from the identity
 * token when it's usable (same JWKS, same audience, sub must match) and from
 * Privy's API when it isn't. Either way the allowlist is matched against
 * accounts Privy verified, never anything the client supplied.
 *
 * `subjects` is every name this caller could have been allowlisted or credited
 * under — emails, linked wallet addresses, and the DID — lowercased. It exists
 * as ONE list because the allowlist and the credits ledger must agree on who
 * the caller is: when they were built separately the gate matched emails only
 * while credits matched emails+DID, so a wallet-only signup was unreachable by
 * either and a DID-keyed credit was 403'd before it could be redeemed.
 * `emails` stays split out for the callers that need a real mailbox (Crossmint
 * receipts), which a wallet-only user legitimately does not have.
 */
export async function requireUserEmails(
  req: Request,
): Promise<{ userId: string; emails: string[]; subjects: string[] }> {
  const { userId } = await requireUser(req)
  const idToken =
    req.headers.get("privy-id-token") ?? cookieValue(req, "privy-id-token")
  if (idToken) {
    try {
      const { payload } = await jwtVerify(idToken, jwks!, {
        issuer: "privy.io",
        audience: APP_ID,
      })
      // a token for a different DID is not this caller's — ignore it and ask
      // Privy about the DID the access token actually proved
      if (payload.sub === userId)
        return { userId, ...callerSubjects(userId, String(payload.linked_accounts ?? "")) }
    } catch {
      /* unusable token — Privy's record is the better answer anyway */
    }
  }
  return { userId, ...(await subjectsFromPrivyApi(userId)) }
}
