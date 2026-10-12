// cookieValue is the fallback auth path for Privy's server-cookie mode — a
// parse miss silently 401s every signed-in user on the custom auth domain.
import assert from "node:assert/strict"
import { cookieValue } from "./auth-cookie.ts"

const req = (cookie) => new Request("http://x", cookie ? { headers: { cookie } } : {})

assert.equal(cookieValue(req(null), "privy-token"), null)
assert.equal(cookieValue(req("privy-token=abc"), "privy-token"), "abc")
// picks the right cookie among several, ignores name-suffix collisions
assert.equal(
  cookieValue(req("a=1; privy-id-token=eyJ.x_y-z; privy-token=t"), "privy-id-token"),
  "eyJ.x_y-z",
)
assert.equal(cookieValue(req("xprivy-token=evil; privy-token=good"), "privy-token"), "good")
// value may contain '='; split on the first only
assert.equal(cookieValue(req("privy-token=a=b=c"), "privy-token"), "a=b=c")
// URL-encoded values decode
assert.equal(cookieValue(req("privy-token=a%2Fb"), "privy-token"), "a/b")
// missing cookie among others
assert.equal(cookieValue(req("a=1; b=2"), "privy-token"), null)
// empty value comes back "" — falsy, so requireUser still says missing
assert.equal(cookieValue(req("privy-token="), "privy-token"), "")

console.log("auth-cookie ok")
