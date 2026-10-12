// The admin panel's two claims that can be wrong silently: "this user has
// access" (must agree with the gate) and "this grant is well-formed" (a bad
// row never errors, it just never redeems).
// Run: node --experimental-strip-types src/lib/admin-core.test.mjs

import assert from "node:assert/strict"

const { subjectsOf, labelOf, mergeUsers, packEv, validateGrant, validateSubject } =
  await import("./admin-core.ts")
const {
  adminOk,
  safeEqual,
  adminEmailOf,
  ADMIN_EMAILS,
  sameOriginOk,
  tooManyFails,
  bumpFail,
  FAIL_LIMIT,
  FAIL_WINDOW_MS,
} = await import("./admin-auth.ts")

// ---- subjectsOf mirrors gacha-server/auth.ts callerSubjects ----------------
assert.deepEqual(
  subjectsOf({ privyId: "did:privy:ABC", address: "0xAbC", owner: { type: "email", id: "A@x.io" } }),
  ["did:privy:abc", "0xabc", "a@x.io"],
  "DID + wallet + email, all lowercased",
)
assert.deepEqual(
  subjectsOf({ privyId: "did:privy:a", address: "0xa", owner: { type: "twitter", id: "handle" } }),
  ["did:privy:a", "0xa"],
  "twitter handle is never a subject — the gate can't match one",
)
// a wallet-login user's owner.id IS their address: must not double up
assert.deepEqual(
  subjectsOf({ privyId: "did:privy:a", address: "0xB", owner: { type: "wallet", id: "0xb" } }),
  ["did:privy:a", "0xb"],
)

// ---- labelOf ---------------------------------------------------------------
assert.equal(labelOf({ owner: { type: "email", id: "who@x.io" } }), "who@x.io", "unmasked: admin-only")
assert.equal(labelOf({ owner: { type: "twitter", id: "bob" } }), "@bob")
assert.equal(labelOf({ address: "0x1234567890abcdef1234" }), "0x1234…1234")
assert.equal(labelOf({}), "(no wallet)")

// ---- mergeUsers ------------------------------------------------------------
const wallets = [
  { privyId: "did:privy:1", address: "0xAAA", owner: { type: "email", id: "a@x.io" }, hip4VolumeUSDC: 12 },
  { privyId: "did:privy:2", address: "0xBBB", owner: { type: "wallet", id: "0xBBB" } },
]
const base = { wallets, allowlist: [], credits: [], spend: [] }

let [u1, u2] = mergeUsers(base)
assert.equal(u1.allowlisted, false)
assert.equal(u2.allowlisted, false)

// allowlisted by ANY subject, not just the one the panel would have written
assert.equal(mergeUsers({ ...base, allowlist: ["a@x.io"] })[0].allowlisted, true, "by email")
assert.equal(mergeUsers({ ...base, allowlist: ["DID:PRIVY:1"] })[0].allowlisted, true, "by DID, case-insensitive")
assert.equal(mergeUsers({ ...base, allowlist: ["0xbbb"] })[1].allowlisted, true, "by wallet")
const [w1, w2] = mergeUsers({ ...base, allowlist: ["*"] })
assert.ok(w1.allowlisted && w2.allowlisted, "'*' opens the gate to everyone")

// credits sum across subjects, and a redeemed row is NOT still owed
const credits = [
  { id: 1, subject: "a@x.io", packName: "Pokemon 30", packs: 2, reason: "beta", giftId: null, attempts: 0, createdAt: "" },
  { id: 2, subject: "did:privy:1", packName: "*", packs: 1, reason: "goodwill", giftId: null, attempts: 0, createdAt: "" },
  { id: 3, subject: "a@x.io", packName: "Pokemon 30", packs: 5, reason: "old", giftId: "g_1", attempts: 1, createdAt: "" },
  { id: 4, subject: "a@x.io", packName: "*", packs: 5, reason: "midmint", giftId: "pending", attempts: 1, createdAt: "" },
]
assert.equal(mergeUsers({ ...base, credits })[0].credits, 3, "2 + 1 owed; redeemed and pending excluded")
assert.equal(mergeUsers({ ...base, credits })[1].credits, 0)

// spend joins on the DID, not the address (gacha_spend keys on user_id)
const spend = [{ userId: "did:privy:1", cents: 3000, pulls: 1 }]
;[u1, u2] = mergeUsers({ ...base, spend })
assert.equal(u1.spentCents, 3000)
assert.equal(u1.pulls, 1)
assert.equal(u2.spentCents, 0)

// ---- validateSubject -------------------------------------------------------
assert.equal(validateSubject(" A@X.io "), "a@x.io")
assert.equal(validateSubject("0x" + "A".repeat(40)), "0x" + "a".repeat(40))
assert.equal(validateSubject("did:privy:cm0000000000000000000test1"), "did:privy:cm0000000000000000000test1")
const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
assert.equal(validateSubject(SOL), SOL.toLowerCase(), "Solana base58, case folded for lookup")
assert.equal(validateSubject("not an address"), null, "junk is refused, not written")
assert.equal(validateSubject("bob"), null)
assert.equal(validateSubject(""), null)
assert.equal(validateSubject("*"), null, "wildcard is opt-in only")
assert.equal(validateSubject("*", true), "*", "…and allowed for the allowlist")

// ---- validateGrant ---------------------------------------------------------
const good = { subject: " A@X.io ", packName: " Pokemon 30 ", packs: 2, reason: " beta-2026-08 " }
assert.deepEqual(validateGrant(good), {
  subject: "a@x.io",
  packName: "Pokemon 30",
  packs: 2,
  reason: "beta-2026-08",
})
assert.equal(typeof validateGrant({ ...good, packs: 6 }), "string", "over the DB CHECK ceiling")
assert.equal(typeof validateGrant({ ...good, packs: 0 }), "string")
assert.equal(typeof validateGrant({ ...good, packs: 1.5 }), "string")
assert.equal(typeof validateGrant({ ...good, reason: "  " }), "string", "no reason ⇒ no idempotency")
assert.equal(typeof validateGrant({ ...good, packName: "" }), "string")
assert.equal(typeof validateGrant({ ...good, subject: "nope" }), "string")
assert.equal(typeof validateGrant({ ...good, subject: "*" }), "string", "can't grant to everyone")
assert.equal(typeof validateGrant(null), "string")
// '*' as a PACK is legitimate (any pack) — only the SUBJECT wildcard is refused
assert.deepEqual(validateGrant({ ...good, packName: "*" }).packName, "*")

// ---- admin-auth ------------------------------------------------------------
// The whole admin surface hangs off this one boolean.
const basic = (u, p) => new Request("https://x/admin", {
  headers: { authorization: `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}` },
})
assert.equal(adminOk(basic("admin", "s3cret"), "s3cret"), true)
assert.equal(adminOk(basic("", "s3cret"), "s3cret"), true, "username is ignored")
assert.equal(adminOk(basic("admin", "s3cret:with:colons"), "s3cret:with:colons"), true)
assert.equal(adminOk(basic("admin", "wrong"), "s3cret"), false)
assert.equal(adminOk(basic("admin", "s3cre"), "s3cret"), false, "prefix is not a match")
assert.equal(adminOk(basic("admin", "s3crett"), "s3cret"), false)
assert.equal(adminOk(basic("admin", "s3cret"), undefined), false, "unset key fails CLOSED")
assert.equal(adminOk(basic("admin", "s3cret"), ""), false)
assert.equal(adminOk(new Request("https://x/admin"), "s3cret"), false, "no header")
assert.equal(
  adminOk(new Request("https://x/admin", { headers: { authorization: "Bearer s3cret" } }), "s3cret"),
  false,
  "wrong scheme",
)
assert.equal(
  adminOk(new Request("https://x/admin", { headers: { authorization: "Basic !!!not-base64" } }), "s3cret"),
  false,
  "malformed base64 must not throw",
)
assert.equal(safeEqual("", ""), true)
assert.equal(safeEqual("a", ""), false)

// ---- adminEmailOf: the email side of the gate -------------------------------
for (const e of ADMIN_EMAILS) assert.equal(adminEmailOf([e]), e)
assert.equal(adminEmailOf(["other@x.io", "admin2@example.com"]), "admin2@example.com")
assert.equal(adminEmailOf(["other@x.io"]), null)
assert.equal(adminEmailOf([]), null, "no emails fails CLOSED")
assert.equal(adminEmailOf(["ADMIN2@EXAMPLE.COM"]), null, "caller must lowercase (extractor does)")
assert.ok(ADMIN_EMAILS.every((e) => e === e.toLowerCase()), "list itself is lowercase")

// ---- sameOriginOk: the CSRF gate on admin mutations --------------------------
const csrfReq = (headers) => new Request("https://x/admin/api", { method: "POST", headers })
assert.equal(sameOriginOk(csrfReq({ "sec-fetch-site": "same-origin" })), true)
assert.equal(sameOriginOk(csrfReq({ "sec-fetch-site": "cross-site" })), false)
assert.equal(sameOriginOk(csrfReq({ "sec-fetch-site": "same-site" })), false, "subdomains are not us")
assert.equal(
  sameOriginOk(csrfReq({ origin: "https://app.example.com", host: "app.example.com" })),
  true,
  "Origin fallback for browsers without Sec-Fetch-Site",
)
assert.equal(
  sameOriginOk(csrfReq({ origin: "https://evil.example.com", host: "app.example.com" })),
  false,
)
assert.equal(sameOriginOk(csrfReq({ origin: "not a url", host: "app.example.com" })), false)
assert.equal(sameOriginOk(csrfReq({})), true, "no browser headers = not a browser (curl + Basic)")
assert.equal(
  sameOriginOk(csrfReq({ "sec-fetch-site": "cross-site", origin: "https://x" })),
  false,
  "Sec-Fetch-Site wins over a matching Origin",
)

// ---- Basic brute-force damper ------------------------------------------------
let rec
for (let i = 0; i < FAIL_LIMIT; i++) {
  assert.equal(tooManyFails(rec, 1000), false, `attempt ${i} still allowed`)
  rec = bumpFail(rec, 1000)
}
assert.equal(tooManyFails(rec, 1000), true, "limit reached inside the window")
assert.equal(tooManyFails(rec, 1000 + FAIL_WINDOW_MS), false, "window expired")
assert.deepEqual(bumpFail(rec, 1000 + FAIL_WINDOW_MS), { n: 1, at: 1000 + FAIL_WINDOW_MS })
assert.equal(tooManyFails(undefined, 0), false, "no record, no block")

// ---- packEv: the readout that stops us selling a pack at a loss ------------
const odds = [
  { tier: "Common", pct: 90, avgValueCents: 200 },
  { tier: "Chase", pct: 10, avgValueCents: 20_000 },
]
let ev = packEv(odds, 3000)
assert.equal(ev.totalPct, 100)
assert.equal(ev.oddsValid, true)
assert.equal(ev.evCents, 2180, "0.9*200 + 0.1*20000")
assert.equal(ev.marginCents, 820)
assert.ok(Math.abs(ev.marginPct - 27.333) < 0.01)

// a pack that loses money must report it as negative, not clamp to zero
ev = packEv(odds, 1000)
assert.equal(ev.marginCents, -1180)
assert.ok(ev.marginPct < 0)

// multi-card packs pay out per card
assert.equal(packEv(odds, 3000, 5).evCents, 2180 * 5)
assert.equal(packEv(odds, 3000, 0).evCents, 2180, "cardsPerPack floors at 1")

// odds that don't total 100 are flagged, and thirds still count as valid
assert.equal(packEv([{ tier: "a", pct: 90, avgValueCents: 1 }], 100).oddsValid, false)
assert.equal(packEv([{ tier: "a", pct: 110, avgValueCents: 1 }], 100).oddsValid, false)
assert.equal(
  packEv([1, 2, 3].map((i) => ({ tier: String(i), pct: 33.33, avgValueCents: 300 })), 1000).oddsValid,
  false,
  "33.33*3 = 99.99 is short — the editor should say so",
)
assert.equal(
  packEv([1, 2, 3].map((i) => ({ tier: String(i), pct: 100 / 3, avgValueCents: 300 })), 1000).oddsValid,
  true,
  "…but float thirds that really do sum to 100 pass",
)

// empty / junk rows must not produce NaN in a money readout
assert.equal(packEv([], 3000).evCents, 0)
assert.equal(packEv([{ tier: "x", pct: NaN, avgValueCents: NaN }], 3000).evCents, 0)
assert.equal(packEv(odds, 0).marginPct, 0, "free pack: no division by zero")

console.log("admin-core: ok")
