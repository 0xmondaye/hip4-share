// Per-user pack spend, banked by the Slabz proxy (the only server-side view
// of a pull now that custody is gone): the purchase POST response names the
// tx and its Slabz price, the submit POST means the user's wallet actually
// signed and paid. Feeds /api/leaderboard?metric=packs.
//
// ponytail: `paid` means "submitted to Slabz", not "confirmed on-chain" — a tx
// that fails after submit overcounts by one pull. Reconcile against
// GET transactions/{id} in a cron if the numbers ever need to be exact.
// Spend is gross: a sell-back pays the user out but doesn't unspend the pull.

import { db, ensureSchema } from "./db.ts"

const UUID = /^[0-9a-fA-F-]{36}$/

export type Purchase = { txId: string; addr: string; priceCents: number }

/** The bits of a purchase response worth banking, or null when the payload
 *  isn't a usable purchase (error body, missing fields, junk price). */
export function parsePurchase(resJson: unknown, reqBody: unknown): Purchase | null {
  const d = (resJson as { data?: Record<string, unknown> } | null)?.data
  const txId = typeof d?.transactionId === "string" ? d.transactionId : ""
  const addr = (reqBody as { walletAddress?: unknown } | null)?.walletAddress
  const priceCents = Number(d?.priceCents)
  if (!UUID.test(txId)) return null
  if (typeof addr !== "string" || !addr) return null
  if (!Number.isInteger(priceCents) || priceCents <= 0) return null
  return { txId, addr, priceCents }
}

/** Bank the charge the user is about to sign for. Idempotent on tx_id. */
export async function bankPurchase(
  userId: string,
  p: Purchase,
  markupCents: number,
): Promise<void> {
  await ensureSchema()
  await db()`
    INSERT INTO gacha_spend (tx_id, user_id, addr, cents)
    VALUES (${p.txId}, ${userId}, ${p.addr}, ${p.priceCents + markupCents})
    ON CONFLICT (tx_id) DO NOTHING`
}

/** Signed and submitted ⇒ the money moved. Only paid rows count. */
export async function markPaid(txId: string): Promise<void> {
  await ensureSchema()
  await db()`UPDATE gacha_spend SET paid = true WHERE tx_id = ${txId}`
}

export type SpendRow = { addr: string; cents: number; pulls: number }

/** Top spenders by total charged, grouped per Privy user (a user can pull
 *  from more than one wallet — the newest is what we show). */
export async function topSpenders(limit = 50): Promise<SpendRow[]> {
  await ensureSchema()
  const rows = await db()`
    SELECT (array_agg(addr ORDER BY created_at DESC))[1] AS addr,
           sum(cents)::int AS cents,
           count(*)::int AS pulls
    FROM gacha_spend WHERE paid
    GROUP BY user_id
    ORDER BY cents DESC
    LIMIT ${limit}`
  return rows.map((r) => ({
    addr: String(r.addr),
    cents: Number(r.cents),
    pulls: Number(r.pulls),
  }))
}
