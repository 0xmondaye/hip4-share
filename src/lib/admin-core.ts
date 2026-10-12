// Pure logic for the admin panel: who a dashboard user IS in the eyes of the
// gacha gate, and validation for the two writes that spend house money.
// No I/O — everything here is unit-tested in admin-core.test.mjs.

import { shortAddr } from "./leaderboard.ts"

/** One row of the hip4 dashboard's GET /api/wallets (shape verified live). */
export type DashUser = {
  privyId?: string
  owner?: { type?: string; id?: string }
  address?: string
  walletSource?: string
  createdAtMs?: number
  totalValue?: number
  tradeCount?: number
  hip4VolumeUSDC?: number
}

/** A gacha_credits row as the admin API returns it. */
export type CreditRow = {
  id: number
  subject: string
  packName: string
  packs: number
  reason: string
  giftId: string | null
  attempts: number
  createdAt: string
}

export type SpendRow = { userId: string; cents: number; pulls: number }

export type AdminUser = {
  privyId: string
  label: string
  ownerType: string
  address: string
  subjects: string[]
  allowlisted: boolean
  /** unredeemed free packs across every subject this user answers to */
  credits: number
  spentCents: number
  pulls: number
  volumeUSDC: number
  createdAtMs: number
}

const lower = (s: unknown): string => (typeof s === "string" ? s.trim().toLowerCase() : "")

/**
 * Every name this user could be allowlisted or credited under. MUST mirror
 * `callerSubjects` in gacha-server/auth.ts (emails + linked wallets + DID,
 * lowercased) — if the two drift, the panel shows an access state the gate
 * does not agree with.
 *
 * A twitter/OAuth handle is deliberately excluded: auth.ts never puts one in
 * the subject list, so a handle-keyed row could never be matched and would sit
 * in the table looking like access nobody actually has. Such users are still
 * reachable by their DID and their embedded wallet, both of which are here.
 */
export function subjectsOf(u: DashUser): string[] {
  const out = [lower(u.privyId), lower(u.address)]
  const owner = lower(u.owner?.id)
  if (owner && u.owner?.type !== "twitter") out.push(owner)
  return [...new Set(out.filter(Boolean))]
}

/** Admin-facing display name. This panel is behind Basic auth and acting on
 *  the wrong person is the failure mode, so emails are shown WHOLE here —
 *  unlike the public leaderboard, which masks them (lib/leaderboard.ts). */
export function labelOf(u: DashUser): string {
  const id = u.owner?.id?.trim()
  if (!id) return u.address ? shortAddr(u.address) : "(no wallet)"
  if (u.owner?.type === "twitter") return `@${id}`
  return id.includes("@") ? id : shortAddr(id)
}

/**
 * Join the dashboard directory to this app's own tables. The dashboard knows
 * identity and HL activity; only Neon knows access and free packs, and only
 * gacha_spend knows pulls — it keys on the Privy DID, which is why the
 * directory's `privyId` is the join column and not the address.
 */
export function mergeUsers(input: {
  wallets: DashUser[]
  allowlist: string[]
  credits: CreditRow[]
  spend: SpendRow[]
}): AdminUser[] {
  const allow = new Set(input.allowlist.map(lower))
  const openToAll = allow.has("*")
  const spendBy = new Map(input.spend.map((s) => [lower(s.userId), s]))
  const creditBy = new Map<string, number>()
  for (const c of input.credits) {
    // gift_id set means redeemed (or mid-mint) — either way it is spent, and
    // showing it as owed would send an admin to grant a replacement
    if (c.giftId) continue
    const k = lower(c.subject)
    creditBy.set(k, (creditBy.get(k) ?? 0) + c.packs)
  }
  return input.wallets.map((u) => {
    const subjects = subjectsOf(u)
    const sp = spendBy.get(lower(u.privyId))
    return {
      privyId: u.privyId ?? "",
      label: labelOf(u),
      ownerType: u.owner?.type ?? "",
      address: lower(u.address),
      subjects,
      allowlisted: openToAll || subjects.some((s) => allow.has(s)),
      credits: subjects.reduce((n, s) => n + (creditBy.get(s) ?? 0), 0),
      spentCents: sp?.cents ?? 0,
      pulls: sp?.pulls ?? 0,
      volumeUSDC: Number(u.hip4VolumeUSDC ?? 0),
      createdAtMs: Number(u.createdAtMs ?? 0),
    }
  })
}

/**
 * A subject string the gate could actually match, or null.
 *
 * Refusing junk matters more here than it looks: an unmatched row is not an
 * error anywhere — it just sits in the table while the person it was meant for
 * keeps getting 403'd, and the admin has no signal that the typo happened.
 * Shapes accepted are exactly the ones auth.ts can produce: an email, an EVM
 * address, a Solana address, a Privy DID. "*" is the documented
 * open-to-everyone allowlist row.
 *
 * Everything is lowercased because both sides of every lookup run through
 * `lower()`. That is lossy for a Solana address but these are only ever
 * compared, never used as a transfer destination (same note as
 * walletsFromLinkedAccounts).
 */
export function validateSubject(raw: unknown, allowWildcard = false): string | null {
  const s = lower(raw)
  if (!s) return null
  if (s === "*") return allowWildcard ? "*" : null
  const ok =
    /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s) || // email
    /^0x[0-9a-f]{40}$/.test(s) || // EVM
    /^[0-9a-z]{32,44}$/.test(s) || // Solana base58, case already folded
    s.startsWith("did:privy:")
  return ok ? s : null
}

export type Grant = { subject: string; packName: string; packs: number; reason: string }

/**
 * Normalize and bound a free-pack grant.
 *
 * `packName` must be the MARKED display name ("Pokemon 30", not the "Pokemon
 * 25" Slabz calls it) because that is what claimCredit compares against — the
 * panel picks from a marked list rather than free text for exactly this
 * reason. `reason` is required and not decoration: UNIQUE (lower(subject),
 * lower(reason)) is what makes re-running a campaign a no-op instead of a
 * second free pack.
 *
 * packs 1-5 is also a DB CHECK; this is here to fail with a readable message
 * rather than a Postgres constraint error.
 */
export function validateGrant(body: unknown): Grant | string {
  const b = (body ?? {}) as Record<string, unknown>
  const subject = validateSubject(b.subject)
  const packName = typeof b.packName === "string" ? b.packName.trim() : ""
  const packs = Number(b.packs)
  const reason = typeof b.reason === "string" ? b.reason.trim() : ""
  if (!subject)
    return "subject must be an email, wallet address or Privy DID"
  if (!packName) return "pick a pack (or '*' for any pack)"
  if (!Number.isInteger(packs) || packs < 1 || packs > 5) return "packs must be 1-5"
  if (!reason) return "reason required — it is what makes the grant idempotent"
  return { subject, packName, packs, reason }
}

// ---- in-house gacha: pack economics ----------------------------------------
// Design preview only so far (admin panel "Inventory" tab) — but the math is
// the part that has to be right, so it lives here and is tested. When we run
// our own inventory the house carries the prize risk: a pack whose expected
// payout exceeds its price loses money on EVERY pull, silently and forever.
// This is the readout that has to sit next to the odds editor.

export type OddsRow = {
  /** rarity tier label, e.g. "Common" / "Chase" */
  tier: string
  /** chance of this tier per card pulled, in whole percent */
  pct: number
  /** average value of a card in this tier, in cents */
  avgValueCents: number
}

export type PackEv = {
  /** must total 100 — anything else means the odds table is unfinished */
  totalPct: number
  oddsValid: boolean
  /** expected payout per pack, in cents */
  evCents: number
  /** price − EV: the house's expected take per pull, in cents */
  marginCents: number
  /** margin as a percentage of price; 0 when the pack is free */
  marginPct: number
}

/** Expected payout and house margin for one pack. `cardsPerPack` multiplies a
 *  per-card odds table — the tiers are the chance for ONE card, so a 5-card
 *  pack pays out five draws' worth. */
export function packEv(
  rows: OddsRow[],
  priceCents: number,
  cardsPerPack = 1,
): PackEv {
  const totalPct = rows.reduce((n, r) => n + (Number(r.pct) || 0), 0)
  const perCard = rows.reduce(
    (n, r) => n + ((Number(r.pct) || 0) / 100) * (Number(r.avgValueCents) || 0),
    0,
  )
  const evCents = perCard * Math.max(1, Math.floor(cardsPerPack))
  const marginCents = priceCents - evCents
  return {
    totalPct,
    // float tolerance, not exact equality: 33.33 × 3 never sums to exactly 100
    oddsValid: Math.abs(totalPct - 100) < 0.01,
    evCents,
    marginCents,
    marginPct: priceCents > 0 ? (marginCents / priceCents) * 100 : 0,
  }
}
