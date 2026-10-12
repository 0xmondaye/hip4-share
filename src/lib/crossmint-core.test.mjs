// Money-path checks for the Crossmint onramp coverage math.
// Run: node --experimental-strip-types src/lib/crossmint-core.test.mjs

import assert from "node:assert/strict"
import {
  centsToUsd,
  coversPull,
  CROSSMINT_API,
  CROSSMINT_ENV,
  CROSSMINT_USDC_LOCATOR,
  crossmintEnabled,
  usdcStrToUnits6,
} from "./crossmint-core.ts"

// env unset in tests: feature off, staging clamp, devnet USDC
assert.equal(crossmintEnabled, false)
assert.equal(CROSSMINT_ENV, "staging")
assert.ok(CROSSMINT_API.includes("staging.crossmint.com"))
assert.ok(CROSSMINT_USDC_LOCATOR.startsWith("solana:4zMM"))

// USDC string parsing — 6dp, truncation, integers
assert.equal(usdcStrToUnits6("12.34"), 12_340_000n)
assert.equal(usdcStrToUnits6("5"), 5_000_000n)
assert.equal(usdcStrToUnits6("0.000001"), 1n)
assert.equal(usdcStrToUnits6("1.9999999"), 1_999_999n) // truncates, never rounds up
for (const bad of ["", "-1", "1.2.3", "abc", "1e3"]) {
  assert.throws(() => usdcStrToUnits6(bad), `should throw: ${bad}`)
}

// cents → USD amount string for the exact-in charge
assert.equal(centsToUsd(3000), "30.00")
assert.equal(centsToUsd(2505), "25.05")
assert.equal(centsToUsd(99), "0.99")
for (const bad of [0, -100, 1.5, NaN]) assert.throws(() => centsToUsd(bad))

// coverage check: guaranteed delivery must cover the bare Slabz price —
// same threshold as doPull's skip-bridge check (subtotal × 10_000 units)
assert.equal(coversPull("25.00", 2500), true)
assert.equal(coversPull("25.000001", 2500), true)
assert.equal(coversPull("24.999999", 2500), false) // one micro-dollar short = refuse
assert.throws(() => coversPull("garbage", 2500)) // malformed quote fails closed

console.log("crossmint-core ok")
