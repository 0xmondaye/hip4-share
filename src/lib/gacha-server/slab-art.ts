// Slab art for the home-page packs teaser, read straight out of the catalog
// snapshots the proxy already writes (proxy-core.ts) — no Slabz call, so the
// teaser costs nothing against the 60 req/min key quota and renders even when
// Slabz is down. Server-only (neon + unstable_cache).

import { unstable_cache } from "next/cache"
import { db, ensureSchema } from "./db.ts"

/** Top-value card images, round-robin across packs: rank 1 of every pack, then
 *  rank 2, and so on. A plain global top-N came back all Pokemon (their insured
 *  values dwarf the rest), so the teaser never showed sports or One Piece.
 *  Empty on any failure (no DATABASE_URL, cold cache) — caller falls back. */
async function slabArt(limit: number): Promise<string[]> {
  try {
    await ensureSchema()
    // key filter + jsonb_typeof guard first: only the /cards snapshots hold an
    // array in payload->'data' (a packs/{id} row holds an object). DISTINCT ON
    // keeps one row per image (packs share cards) at its dearest pack.
    const rows = await db()`
      SELECT url FROM (
        SELECT DISTINCT ON (url)
               c->>'imageUrl' AS url,
               split_part(s.key, '/', 2) AS pack,
               COALESCE(NULLIF(c->>'insuredValueCents', '')::int, 0) AS cents
        FROM slabz_cache s, jsonb_array_elements(s.payload->'data') c
        WHERE s.key LIKE 'packs/%/cards%'
          AND jsonb_typeof(s.payload->'data') = 'array'
          AND c->>'imageUrl' <> ''
        ORDER BY url, cents DESC
      ) u
      ORDER BY row_number() OVER (PARTITION BY pack ORDER BY cents DESC), cents DESC
      LIMIT ${limit}`
    return rows.map((r) => String(r.url))
  } catch {
    return []
  }
}

export const cachedSlabArt = unstable_cache(slabArt, ["gacha-slab-art"], {
  revalidate: 3600,
})
