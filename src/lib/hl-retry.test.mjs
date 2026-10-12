// hlInfo retries 429s with backoff, fails fast on other statuses.
import assert from "node:assert/strict"
import { hlInfo } from "./hyperliquid.ts"

let calls = 0

// two 429s then success → resolves after 3 calls
globalThis.fetch = async () =>
  ++calls < 3 ? new Response("null", { status: 429 }) : Response.json({ ok: true })
assert.deepEqual(await hlInfo({ type: "x" }), { ok: true })
assert.equal(calls, 3)

// non-429 throws immediately, no retry
calls = 0
globalThis.fetch = async () => (calls++, new Response("boom", { status: 500 }))
await assert.rejects(() => hlInfo({ type: "x" }), /Hyperliquid 500: boom/)
assert.equal(calls, 1)

// persistent 429 gives up after 3 attempts
calls = 0
globalThis.fetch = async () => (calls++, new Response("null", { status: 429 }))
await assert.rejects(() => hlInfo({ type: "x" }), /Hyperliquid 429/)
assert.equal(calls, 3)

console.log("hl-retry ok")
