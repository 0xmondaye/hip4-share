// Free-pack entitlements (gacha_credits): who is owed a free open, on which
// pack, and why. The ledger is the ONLY thing that varies between campaigns —
// `reason` is the extension point, so a new use case is an INSERT, not code:
//
//   -- whitelist beta: 2 free Pokemon 30 opens for every allowlisted email
//   INSERT INTO gacha_credits (subject, pack_name, packs, reason)
//   SELECT lower(email), 'Pokemon 30', 2, 'beta-2026-08'
//   FROM gacha_allowlist WHERE email <> '*' ON CONFLICT DO NOTHING;
//
//   -- referral: one open for the referrer, once per referee
//   INSERT INTO gacha_credits (subject, pack_name, packs, reason)
//   VALUES ('did:privy:abc…', 'Pokemon 30', 1, 'referral:did:privy:xyz…');
//
//   -- goodwill: any pack, one open, tied to the ticket that justified it
//   INSERT INTO gacha_credits (subject, pack_name, packs, reason)
//   VALUES ('someone@example.com', '*', 1, 'goodwill:ZD-1042');
//
//   -- wallet-only signup (no email on the account): key on the address they
//   -- log in with, lowercased, and allowlist the same string
//   INSERT INTO gacha_allowlist (email) VALUES ('0xabc…') ON CONFLICT DO NOTHING;
//   INSERT INTO gacha_credits (subject, pack_name, packs, reason)
//   VALUES ('0xabc…', 'Pokemon 30', 2, 'beta-2026-08');
//
// `subject` is a lowercased email, wallet address, OR Privy DID — all three are
// matched (auth.ts builds the list), so an email-keyed campaign, a wallet grant
// and a DID-keyed referral need no branch. Lowercase the address you insert:
// the match runs through lower() on both sides. UNIQUE
// (subject, reason) makes every grant idempotent: re-running a campaign
// INSERT is a no-op, never a second free pack.

import { db, ensureSchema } from "./db"

export type Credit = { id: number; packName: string; packs: number; reason: string }

/** `attempts` is monotonic — it makes each retry's gift idempotency key
 *  unique, so a released row's next attempt gets a WORKING gift instead of
 *  Slabz's IDEMPOTENCY_KEY_REUSED. The cap only bounds how many unfunded Slabz
 *  reservations one row can create (each costs $0 — nothing is signed — but
 *  they burn our 60/min key quota); it is deliberately NOT applied to
 *  `listCredits`, because a broken funder wallet would otherwise make people's
 *  entitlements silently disappear instead of failing loudly and recoverably.
 *  A row sitting at the cap is an ops signal: SELECT * WHERE attempts >= 10. */
const MAX_ATTEMPTS = 10

/** Unredeemed credits for these subjects (emails + wallets + DID, lowercased
 *  by the caller). Rows mid-mint ('pending') and redeemed rows are excluded. */
export async function listCredits(subjects: string[]): Promise<Credit[]> {
  await ensureSchema()
  const rows = await db()`
    SELECT id, pack_name, packs, reason
    FROM gacha_credits
    WHERE lower(subject) = ANY(${subjects})
      AND gift_id IS NULL
    ORDER BY id`
  return rows.map((r) => ({
    id: Number(r.id),
    packName: String(r.pack_name),
    packs: Number(r.packs),
    reason: String(r.reason),
  }))
}

/**
 * Take exactly one matching credit, atomically. The row is marked 'pending'
 * in the SAME statement that selects it (Neon HTTP runs each statement in its
 * own transaction), so two concurrent claims can never both mint — the loser
 * gets null. Returns the attempt number, which pins the gift's idempotency
 * key: same attempt ⇒ same key ⇒ Slabz refuses a duplicate.
 *
 * `AND gift_id IS NULL` is repeated on the OUTER where clause and that is
 * load-bearing, not redundant: with the predicate only inside the sub-select,
 * two concurrent claims both resolve id=N, the loser blocks on the row lock,
 * and Postgres then re-checks only the outer qual (`id = N`) — which still
 * matches, so BOTH updates commit and the house mints two gifts for one row.
 * Re-stating the guard outside makes the loser's re-check fail and return
 * zero rows. (Deliberately no SKIP LOCKED: a double-click should collide into
 * one mint, not skip ahead to the user's next entitlement.)
 *
 * The pack predicate here MUST stay in lockstep with `creditMatches` in
 * gacha-core.ts (used for display) — '*' is any pack, otherwise the marked
 * display name must match case-insensitively. Family matching would leak a
 * "Pokemon 30" credit onto "Pokemon 2500".
 */
export async function claimCredit(
  subjects: string[],
  packName: string,
): Promise<{ id: number; packs: number; attempts: number } | null> {
  await ensureSchema()
  const rows = await db()`
    UPDATE gacha_credits SET gift_id = 'pending', attempts = attempts + 1
    WHERE id = (
      SELECT id FROM gacha_credits
      WHERE lower(subject) = ANY(${subjects})
        AND lower(trim(pack_name)) = ANY(${[packName.trim().toLowerCase(), "*"]})
        AND gift_id IS NULL
        AND attempts < ${MAX_ATTEMPTS}
      ORDER BY id
      LIMIT 1
    )
      AND gift_id IS NULL
    RETURNING id, packs, attempts`
  const r = rows[0]
  return r
    ? { id: Number(r.id), packs: Number(r.packs), attempts: Number(r.attempts) }
    : null
}

/** The grant threw, so nothing was funded (see grantGift's failure contract)
 *  — hand the row back so the user can click again. The next attempt carries
 *  a higher attempt number, hence a fresh idempotency key, hence a fresh
 *  gift; the abandoned unfunded one cost nothing. */
export async function releaseCredit(id: number): Promise<void> {
  await ensureSchema()
  await db()`UPDATE gacha_credits SET gift_id = NULL WHERE id = ${id} AND gift_id = 'pending'`
}

/** The funding tx was submitted — consume the credit for good, even if the
 *  gift has not reached `confirmed` yet: resubmitting could double-spend the
 *  funder, and a gift that confirms late still reaches the user through the
 *  /gacha banner (it lists Slabz gifts by receiver address, not by this row).
 *  A crash in the window between submit and here leaves the row 'pending' —
 *  same outcome, the banner is the recovery. */
export async function attachGift(id: number, giftId: string): Promise<void> {
  await ensureSchema()
  await db()`UPDATE gacha_credits SET gift_id = ${giftId} WHERE id = ${id}`
}
