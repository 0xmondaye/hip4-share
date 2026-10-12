// The admin panel's only backend. One route, one action switch: everything it
// does is a handful of statements against tables that already exist
// (gacha_allowlist, gacha_credits, gacha_spend) plus a read of the hip4
// dashboard user directory.
//
// Auth: HTTP Basic OR a Privy-verified admin email, checked HERE as well as in
// src/proxy.ts. The duplication is deliberate — a money route that trusts only
// a proxy matcher is one config typo (or one middleware-bypass CVE) away from
// being open to the internet. Both call the same lib/admin-auth.ts functions,
// so they cannot disagree about who is an admin. Every mutation is written to
// gacha_admin_audit with the actor that performed it.
//
// It lives at /admin/api rather than /api/admin on purpose: a browser re-sends
// Basic credentials to URLs at or below the path where it authenticated, so
// keeping the page and its API under one prefix means the page's own fetches
// are authenticated without any credential handling in JS.
//
// ponytail: no pagination, no server-side search — the directory is ~70 users
// and the whole thing fits in one response. Paginate past a few thousand.

import { after, NextResponse } from "next/server"
import { adminEmailOf, adminOk, sameOriginOk } from "@/lib/admin-auth"
import { validateGrant, validateSubject } from "@/lib/admin-core"
import type { CreditRow, DashUser, SpendRow } from "@/lib/admin-core"
import { requireUserEmails } from "@/lib/gacha-server/auth"
import { db, ensureSchema } from "@/lib/gacha-server/db"

// The directory refresh below can outlive the response; everything else here
// is a handful of Neon round trips.
export const maxDuration = 60
export const dynamic = "force-dynamic" // an admin panel showing cached truth is a bug

const DASHBOARD_URL =
  process.env.HIP4_DASHBOARD_URL ?? "https://hip4-dashboard-phi.vercel.app"

const fail = (code: string, message: string, status: number) =>
  NextResponse.json({ error: { code, message } }, { status })

/** Who is calling: their admin email, "basic-key" for the shared password, or
 *  null. Same two ways in as src/proxy.ts, checked here too so the route never
 *  trusts the proxy alone. */
const actorOf = async (req: Request): Promise<string | null> => {
  if (adminOk(req, process.env.GACHA_GIFT_ADMIN_KEY)) return "basic-key"
  try {
    return adminEmailOf((await requireUserEmails(req)).emails)
  } catch {
    return null // not signed in
  }
}

const audit = async (actor: string, action: string, detail: Record<string, unknown>) => {
  // ponytail: an audit INSERT failing must not roll back or hide the action it
  // records — for a three-admin panel, availability wins. Log loudly instead.
  await db()`INSERT INTO gacha_admin_audit (actor, action, detail)
             VALUES (${actor}, ${action}, ${JSON.stringify(detail)})`.catch((e) =>
    console.error("[admin] audit write failed", action, e),
  )
}

/** The user directory. Identity + HL activity live in the sibling dashboard
 *  repo, never in this app's DB — see CLAUDE.md's cross-repo rule. */
async function fetchWallets(): Promise<DashUser[]> {
  const key = process.env.HIP4_DASHBOARD_API_KEY
  if (!key) throw new Error("HIP4_DASHBOARD_API_KEY not set")
  const res = await fetch(`${DASHBOARD_URL}/api/wallets?limit=500&sort=total`, {
    headers: { "X-API-Key": key },
    cache: "no-store", // the snapshot below owns caching; don't double-cache
  })
  const json = (await res.json().catch(() => null)) as { wallets?: DashUser[] } | null
  if (!res.ok || !Array.isArray(json?.wallets))
    throw new Error(`dashboard /api/wallets failed (${res.status})`)
  return json.wallets
}

// The dashboard recomputes live HL positions per wallet and takes 40-70s on
// every call, tuning params doesn't help, and its own caching doesn't save us.
// That is longer than this function is allowed to run, so it can never be on
// the panel's critical path: we keep a snapshot and ALWAYS serve it, refreshing
// behind the response. Same stale-if-error shape as the Slabz catalog, in the
// same generic snapshot table (key/payload/updated_at) — reused rather than
// adding a second one for two columns of the same thing.
const DIR_KEY = "admin:wallets"
const DIR_FRESH_MS = 5 * 60_000 // matches the dashboard's own revalidate window

async function saveDirectory(wallets: DashUser[]): Promise<void> {
  await db()`
    INSERT INTO slabz_cache (key, payload, updated_at)
    VALUES (${DIR_KEY}, ${JSON.stringify(wallets)}, now())
    ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`
}

async function directory(): Promise<{
  wallets: DashUser[]
  fetchedAt: string | null
  refreshing: boolean
}> {
  await ensureSchema()
  const rows = await db()`SELECT payload, updated_at FROM slabz_cache WHERE key = ${DIR_KEY}`
  const row = rows[0]
  if (row) {
    const fetchedAt = new Date(String(row.updated_at)).toISOString()
    const stale = Date.now() - new Date(String(row.updated_at)).getTime() > DIR_FRESH_MS
    // after() keeps the refresh alive past the response — a bare floating
    // promise gets frozen on Vercel. If the refresh is itself cut short, the
    // next load just tries again; the panel never waits either way.
    // ponytail: no lock, so two concurrent stale loads can both refresh. Both
    // write the same snapshot, so the cost is a wasted upstream call.
    if (stale)
      after(() =>
        fetchWallets()
          .then(saveDirectory)
          .catch((e) => console.error("[admin] directory refresh", e)),
      )
    return { wallets: row.payload as DashUser[], fetchedAt, refreshing: stale }
  }
  // Nothing banked yet: this one call has to wait, and may exceed the function
  // budget on a bad day. A retry lands once any refresh has completed.
  const wallets = await fetchWallets()
  await saveDirectory(wallets).catch((e) => console.error("[admin] directory save", e))
  return { wallets, fetchedAt: new Date().toISOString(), refreshing: false }
}

async function readNeon() {
  await ensureSchema()
  const sql = db()
  const [allow, credits, spend] = await Promise.all([
    sql`SELECT email FROM gacha_allowlist ORDER BY email`,
    sql`SELECT id, subject, pack_name, packs, reason, gift_id, attempts, created_at
        FROM gacha_credits ORDER BY id DESC`,
    // grouped here rather than reusing spend.ts's topSpenders: that one returns
    // the wallet address, and the join to the directory is on the Privy DID
    sql`SELECT user_id, sum(cents)::int AS cents, count(*)::int AS pulls
        FROM gacha_spend WHERE paid GROUP BY user_id`,
  ])
  return {
    allowlist: allow.map((r) => String(r.email)),
    credits: credits.map(
      (r): CreditRow => ({
        id: Number(r.id),
        subject: String(r.subject),
        packName: String(r.pack_name),
        packs: Number(r.packs),
        reason: String(r.reason),
        giftId: r.gift_id == null ? null : String(r.gift_id),
        attempts: Number(r.attempts),
        createdAt: new Date(String(r.created_at)).toISOString(),
      }),
    ),
    spend: spend.map(
      (r): SpendRow => ({
        userId: String(r.user_id),
        cents: Number(r.cents),
        pulls: Number(r.pulls),
      }),
    ),
  }
}

async function readAudit() {
  await ensureSchema()
  const rows = await db()`
    SELECT id, actor, action, detail, created_at
    FROM gacha_admin_audit ORDER BY id DESC LIMIT 200`
  return {
    entries: rows.map((r) => ({
      id: Number(r.id),
      actor: String(r.actor),
      action: String(r.action),
      detail: r.detail as Record<string, unknown>,
      at: new Date(String(r.created_at)).toISOString(),
    })),
  }
}

export async function GET(req: Request) {
  const actor = await actorOf(req)
  if (!actor) return fail("UNAUTHORIZED", "admin only", 401)
  if (!process.env.DATABASE_URL)
    return fail("NOT_CONFIGURED", "DATABASE_URL not set — nothing to manage", 503)

  // Three reads, deliberately not one. Access and grants come out of Neon in
  // milliseconds and are the half an admin acts on; the directory is a slow,
  // failure-prone read of another service. Bundling them would make the whole
  // panel as slow and as fragile as its least important part.
  try {
    const view = new URL(req.url).searchParams
    if (view.get("directory") === "1") return NextResponse.json(await directory())
    if (view.get("audit") === "1") return NextResponse.json(await readAudit())
    return NextResponse.json({
      ...(await readNeon()),
      // the header shows who you are; the panel greys out gift actions when
      // the funder isn't wired up
      actor,
      giftConfigured: Boolean(process.env.GACHA_GIFT_FUNDER_SOLANA_KEY),
    })
  } catch (e) {
    console.error("[admin] GET", e)
    return fail("INTERNAL", e instanceof Error ? e.message : "read failed", 500)
  }
}

export async function POST(req: Request) {
  // CSRF before anything else: cookies and Basic both ride cross-site, so a
  // mutation must prove it came from our own page. Also enforced in the proxy;
  // duplicated here for the same reason the auth check is.
  if (!sameOriginOk(req)) return fail("FORBIDDEN", "cross-site request refused", 403)
  const actor = await actorOf(req)
  if (!actor) return fail("UNAUTHORIZED", "admin only", 401)
  if (!process.env.DATABASE_URL) return fail("NOT_CONFIGURED", "DATABASE_URL not set", 503)

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  const action = String(body?.action ?? "")
  try {
    await ensureSchema()
    const sql = db()

    if (action === "allow" || action === "revoke") {
      // '*' is the documented open-to-everyone row, so it is accepted here and
      // nowhere else — an admin opening the beta up is a real operation.
      const subject = validateSubject(body?.subject, true)
      if (!subject)
        return fail("BAD_REQUEST", "subject must be an email, wallet address, Privy DID or '*'", 400)
      if (action === "allow")
        await sql`INSERT INTO gacha_allowlist (email) VALUES (${subject}) ON CONFLICT DO NOTHING`
      else await sql`DELETE FROM gacha_allowlist WHERE lower(email) = ${subject}`
      await audit(actor, action, { subject })
      return NextResponse.json({ ok: true, subject })
    }

    if (action === "grant") {
      const g = validateGrant(body)
      if (typeof g === "string") return fail("BAD_REQUEST", g, 400)
      // ON CONFLICT DO NOTHING honours the (lower(subject), lower(reason))
      // unique index, so re-submitting the form is a no-op rather than a second
      // free pack. `inserted:false` is how the UI says "already granted".
      const rows = await sql`
        INSERT INTO gacha_credits (subject, pack_name, packs, reason)
        VALUES (${g.subject}, ${g.packName}, ${g.packs}, ${g.reason})
        ON CONFLICT DO NOTHING
        RETURNING id`
      if (rows.length > 0) await audit(actor, "grant", { ...g })
      return NextResponse.json({ ok: true, inserted: rows.length > 0, ...g })
    }

    if (action === "ungrant") {
      const id = Number(body?.id)
      if (!Number.isInteger(id)) return fail("BAD_REQUEST", "id must be an integer", 400)
      // `gift_id IS NULL` is the whole safety of this action: a redeemed row is
      // a receipt for money the funder already spent. Deleting it would let the
      // same campaign grant the same person a second free pack.
      const rows = await sql`DELETE FROM gacha_credits WHERE id = ${id} AND gift_id IS NULL RETURNING id`
      if (rows.length === 0)
        // Covers both "already claimed" and "already deleted": either way there
        // is nothing to revoke, and the panel reloads to show the truth.
        return fail("NOT_REVOCABLE", "that grant is already claimed or gone — nothing to revoke", 409)
      await audit(actor, "ungrant", { id })
      return NextResponse.json({ ok: true })
    }

    return fail("BAD_REQUEST", `unknown action '${action}'`, 400)
  } catch (e) {
    console.error("[admin] POST", action, e)
    return fail("INTERNAL", e instanceof Error ? e.message : "write failed", 500)
  }
}
