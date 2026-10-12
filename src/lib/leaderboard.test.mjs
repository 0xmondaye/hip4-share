import assert from "node:assert/strict"
import { maskOwner, shortAddr, formatVolume, nextGoal } from "./leaderboard.ts"

const addr = "0x5e1f00000000000000000000000000000000c0de"

// emails (google/email login) are masked, never shown whole
assert.equal(
  maskOwner({ type: "google", id: "sophie.test@gmail.com" }, addr),
  "so•••@gmail.com",
)
assert.equal(
  maskOwner({ type: "email", id: "a@b.co" }, addr),
  "a•••@b.co",
)
// twitter handles masked
assert.equal(maskOwner({ type: "twitter", id: "someguy" }, addr), "@so•••")
// wallet logins fall back to short address
assert.equal(
  maskOwner({ type: "wallet", id: "0xA11cE00000000000000000000000000000000001" }, addr),
  "0x5e1f…c0de",
)
// missing owner falls back too
assert.equal(maskOwner(undefined, addr), "0x5e1f…c0de")

assert.equal(shortAddr(addr), "0x5e1f…c0de")
assert.equal(formatVolume(8412.91017), "$8,413")

// progress bar goal: next 1/2/5 round number above top spend
assert.equal(nextGoal(0), 100)
assert.equal(nextGoal(100), 200) // strictly above: at goal → next goal
assert.equal(nextGoal(150), 200)
assert.equal(nextGoal(450), 500)
assert.equal(nextGoal(8000), 10000)
assert.equal(nextGoal(12000), 20000)
assert.equal(nextGoal(50001), 100000)

console.log("leaderboard.test.mjs ok")
