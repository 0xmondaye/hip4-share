import assert from "node:assert/strict"
import { isAllowed } from "./slabz-proxy.ts"

const uuid = "16f82952-c255-47bb-a73f-7b47c2205cc7"
const mint = "4JrCXhEqRxVCgx8ovFeQFyzS2PSmDmGpGcR4NVNti5La"

// every endpoint the UI needs passes
assert.ok(isAllowed("POST", `packs/${"0".repeat(36)}/bulk-purchase`))
assert.ok(!isAllowed("GET", `packs/${"0".repeat(36)}/bulk-purchase`))
assert.ok(isAllowed("GET", "packs"))
assert.ok(isAllowed("GET", `packs/${uuid}`))
assert.ok(isAllowed("GET", `packs/${uuid}/cards`))
assert.ok(isAllowed("GET", "transactions"))
assert.ok(isAllowed("GET", `transactions/${uuid}`))
assert.ok(isAllowed("GET", `transactions/${uuid}/buyback/quote`))
assert.ok(isAllowed("GET", `transactions/${uuid}/buyback/status`))
assert.ok(isAllowed("GET", `cards/${mint}/buyback/quote`))
assert.ok(isAllowed("POST", `packs/${uuid}/purchase`))
assert.ok(isAllowed("POST", `transactions/${uuid}/submit`))
assert.ok(isAllowed("POST", `transactions/${uuid}/open`))
assert.ok(isAllowed("POST", `transactions/${uuid}/buyback`))
assert.ok(isAllowed("POST", `transactions/${uuid}/buyback/submit`))
assert.ok(isAllowed("GET", `transactions/${uuid}/redeem/status`))
for (const p of ["auth", "auth/verify", "addresses", "estimate", "prepare", "burn", "resume"])
  assert.ok(isAllowed("POST", `transactions/${uuid}/redeem/${p}`))
assert.ok(!isAllowed("GET", `transactions/${uuid}/redeem/resume`)) // POST only

// gifting: browse + claim only — create/submit never ride the proxy
assert.ok(isAllowed("GET", "gifts"))
assert.ok(isAllowed("GET", `gifts/${uuid}`))
assert.ok(isAllowed("POST", `gifts/${uuid}/claim/init`))
assert.ok(isAllowed("POST", `gifts/${uuid}/claim/complete`))
assert.ok(!isAllowed("POST", "gifts"))
assert.ok(!isAllowed("POST", `gifts/${uuid}/submit`))
assert.ok(!isAllowed("GET", `gifts/${uuid}/claim/init`))

// arbitrary / sneaky paths do not
assert.ok(!isAllowed("GET", "admin"))
assert.ok(!isAllowed("GET", "packs/../admin"))
assert.ok(!isAllowed("GET", `packs/${uuid}/cards/extra`))
assert.ok(!isAllowed("POST", "packs")) // method matters
assert.ok(!isAllowed("GET", `packs/${uuid}/purchase`))
assert.ok(!isAllowed("DELETE", `transactions/${uuid}`))
assert.ok(!isAllowed("POST", `transactions/${uuid}/buyback/submit/extra`))
assert.ok(!isAllowed("GET", "cards/notbase58!/buyback/quote"))
// redeem: no address book, and no method the proxy can't forward
assert.ok(!isAllowed("GET", `transactions/${uuid}/redeem/addresses`))
assert.ok(!isAllowed("PATCH", `transactions/${uuid}/redeem/addresses/abc`))
assert.ok(!isAllowed("DELETE", `transactions/${uuid}/redeem/addresses/abc`))
assert.ok(!isAllowed("POST", `transactions/${uuid}/redeem/addresses/abc`))

console.log("slabz-proxy.test.mjs ok")
