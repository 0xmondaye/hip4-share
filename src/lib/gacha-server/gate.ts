// Shared trust-boundary gate for every gacha purchase/money route: who is
// calling (Privy JWT), closed-beta allowlist, kill switch, devnet foot-gun.
// The Slabz proxy's POST paths run through this too — without it anyone with
// curl could pull packs at the un-marked-up price on our API key.

import { requireUserEmails } from "./auth"
import { db, ensureSchema } from "./db"
import { GachaError } from "./http"

/**
 * Throws unless the request may touch the gacha money paths. Allowlist lives
 * in Neon (gacha_allowlist, one row per subject; a "*" row opens to everyone
 * post-beta) and is matched against every name the verified Privy identity
 * token gives us — email, linked wallet address, or DID — so a wallet-only
 * signup is allowlistable by the address they log in with. All server-verified,
 * unlike the old client-supplied address matching. The column is still called
 * `email` because renaming it buys nothing; it is a text key.
 */
/**
 * The product-agnostic half of the gate: verified Privy identity, kill
 * switch, closed-beta allowlist. The wine (Cellar) money route uses this
 * directly — it settles on HyperEVM and must not be coupled to the
 * Slabz-specific config checks below.
 */
export async function requireGachaAllowlist(
  req: Request,
): Promise<{ userId: string; emails: string[]; subjects: string[] }> {
  const { userId, emails, subjects } = await requireUserEmails(req)
  if (process.env.GACHA_PAUSED === "1") throw new GachaError("PAUSED", "packs are paused", 503)
  await ensureSchema()
  // ponytail: one SELECT per money-route call; cache if Neon latency ever hurts
  const hit = await db()`
    SELECT 1 FROM gacha_allowlist WHERE lower(email) = ANY(${[...subjects, "*"]}) LIMIT 1`
  if (hit.length === 0)
    throw new GachaError("NOT_ALLOWLISTED", "packs are in limited testing", 403)
  return { userId, emails, subjects }
}

export async function requireGachaAccess(
  req: Request,
): Promise<{ userId: string; emails: string[]; subjects: string[] }> {
  const ids = await requireGachaAllowlist(req)
  // devnet/staging Slabz + real HL money is a real-money-for-test-packs
  // foot-gun: refuse unless BOTH the cluster is mainnet AND SLABZ_API_URL is
  // explicitly set (unset falls back to Slabz's staging URL in
  // gacha-server/slabz.ts — mainnet cluster alone won't save you), or the
  // test-only override is on.
  if (
    ((process.env.NEXT_PUBLIC_SLABZ_CLUSTER ?? "devnet") !== "mainnet" ||
      !process.env.SLABZ_API_URL) &&
    process.env.GACHA_ALLOW_DEVNET !== "1"
  )
    throw new GachaError(
      "NOT_CONFIGURED",
      "packs need NEXT_PUBLIC_SLABZ_CLUSTER=mainnet and SLABZ_API_URL set (or GACHA_ALLOW_DEVNET=1 for testing)",
      503,
    )
  return ids
}
