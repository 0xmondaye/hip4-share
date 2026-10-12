// Pack-catalog GET pipeline shared by the /api/gacha route and the cron
// warmer: a Neon snapshot cache (last-known-good, RFC 5861 semantics) in
// front of Slabz's 60 req/min-per-key limit — a quota shared across every
// user, deployment, and dev machine on the key. A cold /gacha load fans out
// to 1 + N packs upstream calls, so a handful of cold visitors exhausts it.
// Fresh row → serve without touching Slabz; stale row → try upstream, fall
// back to the row on error (stale-if-error); success → caller persists via
// the returned persist(). No DATABASE_URL → Next's data cache alone.

import { db, ensureSchema } from "./db.ts"

export const SLABZ_BASE =
  process.env.SLABZ_API_URL ?? "https://api-staging-3e2d.up.railway.app/api/partner/v1" // devnet default
// swr=24h: next-day first visitor gets instant stale from CDN while it
// revalidates in the background (cold-start stack otherwise: CDN miss +
// function cold start + Neon wake + live Slabz fan-out)
export const CDN_OK = "public, s-maxage=3600, stale-while-revalidate=86400"

export type CatalogOutcome =
  // fresh snapshot served, zero upstream calls
  | { kind: "hit"; json: unknown }
  // upstream down/limited/unreachable, last-known-good served (stale-if-error)
  | { kind: "stale"; json: unknown }
  // upstream answered (or is unreachable); persist() writes the snapshot —
  // null unless this was a cacheable success
  | { kind: "live"; status: number; json: unknown; persist: (() => Promise<void>) | null }

export async function proxyCatalogGet(joined: string, search: string): Promise<CatalogOutcome> {
  const key = process.env.SLABZ_API_KEY
  if (!key)
    return {
      kind: "live",
      status: 503,
      json: {
        success: false,
        error: { code: "NOT_CONFIGURED", message: "SLABZ_API_KEY not set" },
      },
      persist: null,
    }

  const cacheKey = `${joined}${search}`
  const snapshots = !!process.env.DATABASE_URL
  let stale: unknown | null = null
  if (snapshots) {
    try {
      await ensureSchema()
      const rows = await db()`
        SELECT payload, updated_at > now() - interval '1 hour' AS fresh
        FROM slabz_cache WHERE key = ${cacheKey}`
      if (rows[0]?.fresh) return { kind: "hit", json: rows[0].payload }
      stale = rows[0]?.payload ?? null
    } catch {
      /* db hiccup → plain proxy path */
    }
  }

  // Retry absorbs Slabz's random 500s and connection flaps (a null response
  // = network-level failure, Slabz hard-down). 500s/throws only — retrying
  // a 429 spends more of the very quota that's exhausted and keeps the key
  // pinned at the limit; stale snapshots absorb 429s instead.
  const url = `${SLABZ_BASE}/${joined}${search}`
  const headers = { "X-API-Key": key }
  let res: Response | null = null
  for (let i = 0; ; i++) {
    try {
      res = await fetch(url, {
        headers,
        // with snapshots the DB is the cache; without, lean on Next's data cache
        ...(i === 0 && !snapshots
          ? { next: { revalidate: 3600 } }
          : { cache: "no-store" as const }),
      })
      if (res.status < 500 || i >= 2) break
    } catch {
      res = null
      if (i >= 2) break
    }
    await new Promise((r) => setTimeout(r, 400 * (i + 1) + Math.random() * 400))
  }

  if (res == null) {
    if (stale != null) return { kind: "stale", json: stale }
    return {
      kind: "live",
      status: 502,
      json: {
        success: false,
        error: { code: "UPSTREAM_UNREACHABLE", message: "Slabz unreachable" },
      },
      persist: null,
    }
  }

  // res.json() failure → {} → never treated as success, never cached
  const json = (await res.json().catch(() => ({}))) as { success?: boolean }
  const ok = res.ok && json.success !== false && Object.keys(json).length > 0

  if (snapshots) {
    if (ok) {
      const payload = JSON.stringify(json)
      return {
        kind: "live",
        status: res.status,
        json,
        persist: () =>
          db()`
            INSERT INTO slabz_cache (key, payload, updated_at)
            VALUES (${cacheKey}, ${payload}::jsonb, now())
            ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()
          `.then(
            () => undefined,
            () => undefined,
          ),
      }
    }
    if (stale != null) return { kind: "stale", json: stale }
  }

  return { kind: "live", status: res.status, json, persist: null }
}
