// Retry/cache-fallback behavior of the Slabz catalog pipeline (snapshot
// layer off — no DATABASE_URL — so this is pure pass-through logic).
// Run: node --experimental-strip-types src/lib/gacha-server/proxy-core.test.mjs

import assert from "node:assert/strict"

process.env.SLABZ_API_KEY = "test-key"
process.env.SLABZ_API_URL = "https://slabz.test/api"
delete process.env.DATABASE_URL

// env is read at module load (SLABZ_BASE) — import after setting it
const { proxyCatalogGet } = await import("./proxy-core.ts")

let calls
let script
globalThis.fetch = async (url, init) => {
  calls.push({ url, init })
  const step = script.shift()
  if (step.throw) throw new Error("connect reset")
  return {
    status: step.status,
    ok: step.status >= 200 && step.status < 300,
    json: async () => step.body,
  }
}
const run = (steps) => {
  calls = []
  script = [...steps]
  return proxyCatalogGet("packs", "")
}

// happy path: one upstream call, pass-through, nothing to persist (no DB)
{
  const out = await run([{ status: 200, body: { success: true, data: [] } }])
  assert.equal(out.kind, "live")
  assert.equal(out.status, 200)
  assert.equal(out.persist, null)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "https://slabz.test/api/packs")
}

// 429: never retried — the quota is exhausted, spending more keeps it pinned
{
  const out = await run([
    { status: 429, body: { success: false, error: { code: "PARTNER_RATE_LIMITED" } } },
  ])
  assert.equal(out.status, 429)
  assert.equal(calls.length, 1)
}

// 500s: retried with backoff until one succeeds
{
  const out = await run([
    { status: 500, body: {} },
    { status: 502, body: {} },
    { status: 200, body: { success: true, data: [1] } },
  ])
  assert.equal(out.status, 200)
  assert.equal(calls.length, 3)
}

// network throws: same retry treatment, then a clean 502 — no crash
{
  const out = await run([{ throw: true }, { throw: true }, { throw: true }])
  assert.equal(out.kind, "live")
  assert.equal(out.status, 502)
  assert.equal(out.json.error.code, "UPSTREAM_UNREACHABLE")
  assert.equal(calls.length, 3)
}

// no API key: 503 NOT_CONFIGURED, zero upstream calls
{
  delete process.env.SLABZ_API_KEY
  const out = await run([{ status: 200, body: {} }])
  assert.equal(out.status, 503)
  assert.equal(out.json.error.code, "NOT_CONFIGURED")
  assert.equal(calls.length, 0)
  process.env.SLABZ_API_KEY = "test-key"
}

console.log("proxy-core.test.mjs OK")
