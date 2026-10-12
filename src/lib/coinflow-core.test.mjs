// Money-path checks for the Coinflow card checkout split.
// Run: node --experimental-strip-types src/lib/coinflow-core.test.mjs

import assert from "node:assert/strict"
import { cardCart, COINFLOW_API, COINFLOW_ENV, coinflowEnabled } from "./coinflow-core.ts"

// env unset in tests: feature off, sandbox clamp
assert.equal(coinflowEnabled, false)
assert.equal(COINFLOW_ENV, "sandbox")
assert.ok(COINFLOW_API.includes("api-sandbox.coinflow.cash"))

// the split: delivered USDC = bare price, card fee = markup — exactly the
// Relay pay-in economics (delivered must cover the Slabz buy, house keeps markup)
assert.deepEqual(cardCart({ priceCents: 2500, markupCents: 500 }, 1), {
  subtotalCents: 2500,
  feeCents: 500,
  totalCents: 3000,
})
// bulk is linear, same as payin-quote
assert.deepEqual(cardCart({ priceCents: 2500, markupCents: 500 }, 10), {
  subtotalCents: 25000,
  feeCents: 5000,
  totalCents: 30000,
})
// unmarked packs sell at the Slabz price — no fee line item
assert.deepEqual(cardCart({ priceCents: 9900 }, 2), {
  subtotalCents: 19800,
  feeCents: 0,
  totalCents: 19800,
})

// fail closed on garbage — a silent clamp could charge for the wrong pull
for (const bad of [0, -1, 11, 1.5, NaN]) {
  assert.throws(() => cardCart({ priceCents: 2500, markupCents: 500 }, bad))
}
assert.throws(() => cardCart({ priceCents: 0 }, 1))
assert.throws(() => cardCart({ priceCents: 2500.5 }, 1))
assert.throws(() => cardCart({ priceCents: 2500, markupCents: -1 }, 1))

console.log("coinflow-core ok")
