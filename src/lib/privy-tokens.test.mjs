// The whole point of this cache is calling Privy LESS — a regression here
// re-creates the 429 storm that makes gated routes fail with "missing
// identity token". Assert the call count, not just the values.
// Run: node --experimental-strip-types src/lib/privy-tokens.test.mjs

import assert from "node:assert/strict"
import { makeTokenCache, privyAuthHeaders } from "./privy-tokens.ts"

const T = { token: "a", idToken: "b" }
let calls = 0
let now = 1_000_000
const clock = () => now
const get = makeTokenCache(async () => {
  calls++
  return T
}, 60_000)

// five parallel callers (a pack page's rarity fan-out) = ONE lookup
const first = await Promise.all([get(false, clock), get(false, clock), get(false, clock), get(false, clock), get(false, clock)])
assert.equal(calls, 1)
assert.deepEqual(first[0], T)

// repeat callers inside the TTL reuse it
now += 59_000
await get(false, clock)
assert.equal(calls, 1)

// past the TTL, one fresh lookup
now += 2_000
await get(false, clock)
assert.equal(calls, 2)

// force bypasses the TTL — this is the 401-recovery path
await get(true, clock)
assert.equal(calls, 3)

// concurrent forces still coalesce: a stampede of refreshes is what the rate
// limit punishes
await Promise.all([get(true, clock), get(true, clock), get(true, clock)])
assert.equal(calls, 4)

// a failing loader resolves to nulls rather than rejecting, so an API call
// goes out unauthenticated (and gets a clean 401) instead of throwing
const bad = makeTokenCache(async () => {
  throw new Error("privy 429")
})
assert.deepEqual(await bad(), { token: null, idToken: null })

// SIGN-IN RECOVERY: a signed-out lookup must NOT be cached, or signing in
// changes nothing until the TTL expires and every route says "missing access
// token". Same clock throughout — the point is that time did not move.
let signedIn = false
let flips = 0
const flip = makeTokenCache(async () => {
  flips++
  return signedIn ? T : { token: null, idToken: null }
}, 60_000)
assert.deepEqual(await flip(false, clock), { token: null, idToken: null })
assert.equal(flips, 1)
signedIn = true
// no force, no clock advance: the very next caller must see the new token
assert.deepEqual(await flip(false, clock), T)
assert.equal(flips, 2)
// ...and now that there IS a token, it caches
await flip(false, clock)
assert.equal(flips, 2)

// no window (server render): no headers, and Privy is never imported
assert.deepEqual(await privyAuthHeaders(), {})

console.log("privy-tokens ok")
