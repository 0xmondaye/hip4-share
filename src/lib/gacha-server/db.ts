// Neon Postgres over HTTP (stateless, serverless-safe). Schema is created
// idempotently on first use — no migration tooling for two tables.
// The custodial-era tables (gacha_orders, gacha_addr_claims, gacha_locks,
// gacha_house_events) are no longer created or touched here; drop them
// manually once the drained ledger is archived.

import { neon } from "@neondatabase/serverless"

export const NOT_CONFIGURED = "NOT_CONFIGURED"

// narrow neon's arrayMode/fullResults union to what we actually use: rows
export type Sql = {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<Record<string, unknown>[]>
  query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>
}

let _sql: Sql | null = null
let _schema: Promise<void> | null = null

export function db(): Sql {
  if (_sql) return _sql
  const url = process.env.DATABASE_URL
  if (!url) throw Object.assign(new Error("DATABASE_URL not set"), { code: NOT_CONFIGURED })
  _sql = neon(url) as unknown as Sql
  return _sql
}

export async function ensureSchema(): Promise<void> {
  if (!_schema) {
    const sql = db()
    _schema = (async () => {
      // last-known-good snapshots of Slabz catalog GETs. The proxy serves a
      // fresh row without touching Slabz, and serves a stale row when Slabz
      // is down (stale-if-error) — flaky upstream never reaches users.
      await sql`CREATE TABLE IF NOT EXISTS slabz_cache (
        key text PRIMARY KEY,
        payload jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`
      // gacha_gas_topups (per-user daily sponsored-send counter) is GONE as of
      // 2026-08-25 — the cap it enforced defended ~$0.90/user/day and throttled
      // real users, see payout-send/route.ts. Deployments that ran the old
      // schema still have the table; it is orphaned and safe to drop by hand.
      // Its RLS entry below went with it: enabling RLS on a table we no longer
      // create would fail a fresh deploy.
      // per-user pack spend (spend.ts) — the packs leaderboard's only source
      await sql`CREATE TABLE IF NOT EXISTS gacha_spend (
        tx_id text PRIMARY KEY,
        user_id text NOT NULL,
        addr text NOT NULL,
        cents int NOT NULL,
        paid boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      )`
      // closed-beta allowlist (gate.ts) — one subject per row: an email, a
      // lowercased wallet address (for signups with no email), or a Privy DID.
      // "*" = open to everyone. Column name is historical; it is a text key.
      // Managed by hand in the Neon console; empty table = nobody.
      await sql`CREATE TABLE IF NOT EXISTS gacha_allowlist (
        email text PRIMARY KEY
      )`
      // free-pack entitlements (credits.ts) — one row per (who, why). packs is
      // clamped in the schema, not just in code: an over-generous campaign
      // INSERT is house money, and the DB is the last line that a bug in our
      // own SQL can't talk its way past.
      await sql`CREATE TABLE IF NOT EXISTS gacha_credits (
        id bigserial PRIMARY KEY,
        subject text NOT NULL,
        pack_name text NOT NULL,
        packs int NOT NULL CHECK (packs BETWEEN 1 AND 5),
        reason text NOT NULL,
        gift_id text,
        attempts int NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      )`
      // "one row per (who, why)" has to be case-INSENSITIVE to be true: lookups
      // match on lower(subject), so a plain UNIQUE(subject, reason) would let
      // 'Foo@x.com' and 'foo@x.com' both sit in the table and both redeem —
      // two free packs from one campaign run. A functional unique index is the
      // only way to state it, and bare ON CONFLICT DO NOTHING still honours it.
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS gacha_credits_subject_reason
        ON gacha_credits (lower(subject), lower(reason))`
      // who did what on the admin panel. Append-only from the app's side:
      // nothing ever updates or deletes here, and the panel only reads it.
      await sql`CREATE TABLE IF NOT EXISTS gacha_admin_audit (
        id bigserial PRIMARY KEY,
        actor text NOT NULL,
        action text NOT NULL,
        detail jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now()
      )`
      // wine gacha prize index (gacha-server/wine.ts). Both HyperEVM RPCs cap
      // eth_getLogs at 1000 blocks, so the Pulled log can't be replayed from a
      // browser; the settle route writes what it handed out and
      // /api/wine/bottles filters by ownerOf(). Append-only.
      await sql`CREATE TABLE IF NOT EXISTS wine_prizes (
        tx_hash text NOT NULL,
        collection text NOT NULL,
        token_id text NOT NULL,
        user_addr text NOT NULL,
        deferred boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tx_hash, collection, token_id)
      )`
      await sql`CREATE INDEX IF NOT EXISTS wine_prizes_user ON wine_prizes (user_addr)`
      // Neon's Data API (PostgREST) exposes the whole public schema to its
      // anonymous/authenticated roles. RLS with no policies is deny-all for
      // them; our connection role owns these tables and bypasses RLS.
      for (const t of [
        "slabz_cache",
        "gacha_spend",
        "gacha_allowlist",
        "gacha_credits",
        "gacha_admin_audit",
        "wine_prizes",
      ]) {
        await sql.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`)
      }
    })()
    _schema = _schema.catch((e) => {
      _schema = null
      throw e
    })
  }
  return _schema
}
