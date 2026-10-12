// explainSignError maps known signer failures to actionable messages.
import assert from "node:assert/strict"
import { explainSignError, SessionExpiredError } from "./sign-error.ts"

// Privy stale-session cause buried under nktkas wrapper → sessionExpired
const wrapped = new Error("Failed to sign the typed data using the wallet", {
  cause: new Error(
    "User must be authenticated and have a Privy wallet before it can be connected",
  ),
})
let r = explainSignError(wrapped)
assert.equal(r.sessionExpired, true)
assert.match(r.message, /log in again/)

// SessionExpiredError thrown directly by makeSigner
r = explainSignError(new SessionExpiredError())
assert.equal(r.sessionExpired, true)

// External wallet on the wrong account
r = explainSignError(
  new Error("sign failed", {
    cause: new Error(
      "The requested account and/or method has not been authorized by the user",
    ),
  }),
)
assert.equal(r.sessionExpired, false)
assert.match(r.message, /different account/)

// Mid-signing network switch
r = explainSignError(new Error("Provided chainId must match the active chainId"))
assert.match(r.message, /switched networks/)

// Privy 429 — upstream copy replaced, never surfaced raw
r = explainSignError(new Error("Too many requests. Please wait to try again."))
assert.equal(r.sessionExpired, false)
assert.match(r.message, /wait a few seconds and retry/)

// Privy iframe redeployed under an open page — viem wraps the iframe's
// ChunkLoadError as an "unknown RPC error"; user must reload
r = explainSignError(
  new Error(
    "An unknown RPC error occurred. Request Arguments: from: 0x536C… Details: Loading chunk 2743 failed. (error: https://privy.gambitapp.io/_next/static/chunks/2743.js) Version: viem@2.56.3",
  ),
)
assert.equal(r.reload, true)
assert.equal(r.sessionExpired, false)
assert.match(r.message, /reload the page/)
assert.doesNotMatch(r.message, /Request Arguments/)

// Unknown error keeps the full cause chain
r = explainSignError(new Error("outer", { cause: new Error("inner") }))
assert.equal(r.message, "outer — inner")
assert.equal(r.sessionExpired, false)

// Privy iframe/modal flows reject with plain objects — keep the payload
r = explainSignError(
  new Error("Failed to sign the typed data using the wallet", {
    cause: { code: 4900, message: "Disconnected" },
  }),
)
assert.equal(
  r.message,
  'Failed to sign the typed data using the wallet — {"code":4900,"message":"Disconnected"}',
)

// Non-Error thrown directly is still shown, not swallowed
r = explainSignError("boom", "Withdrawal failed")
assert.equal(r.message, "boom")

// null/undefined fall back
r = explainSignError(null, "Withdrawal failed")
assert.equal(r.message, "Withdrawal failed")

console.log("sign-error ok")
