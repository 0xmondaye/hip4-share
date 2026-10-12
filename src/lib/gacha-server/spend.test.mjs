// What the proxy is allowed to bank as spend. Junk in ⇒ null, never a row
// with a bogus amount or a wallet we didn't see.
// Run: node --experimental-strip-types src/lib/gacha-server/spend.test.mjs

import assert from "node:assert/strict"

const { parsePurchase } = await import("./spend.ts")

const TX = "0f8c2a1e-4d3b-4c7a-9e21-8b6f5d4c3a2b"
const ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
const ok = { data: { transactionId: TX, priceCents: 2500 } }

// happy path: Slabz price banked verbatim, markup added by the caller
assert.deepEqual(parsePurchase(ok, { walletAddress: ADDR }), {
  txId: TX,
  addr: ADDR,
  priceCents: 2500,
})

// no wallet in the body ⇒ nothing to attribute the pull to
assert.equal(parsePurchase(ok, {}), null)
assert.equal(parsePurchase(ok, null), null)

// error/garbage responses never become rows
assert.equal(parsePurchase({ success: false }, { walletAddress: ADDR }), null)
assert.equal(parsePurchase(null, { walletAddress: ADDR }), null)
assert.equal(parsePurchase({ data: { transactionId: "nope", priceCents: 2500 } }, { walletAddress: ADDR }), null)

// bad prices: free, negative, fractional, missing
for (const priceCents of [0, -2500, 25.5, undefined, null, "lots"])
  assert.equal(
    parsePurchase({ data: { transactionId: TX, priceCents } }, { walletAddress: ADDR }),
    null,
    `priceCents ${priceCents} must not bank`,
  )

// a stringified price still banks — Slabz payloads drift (cf. normalizeOdds)
assert.equal(
  parsePurchase({ data: { transactionId: TX, priceCents: "2500" } }, { walletAddress: ADDR })
    ?.priceCents,
  2500,
)

console.log("spend: ok")
