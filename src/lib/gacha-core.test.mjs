// Money-path checks for the direct gacha flow.
// Run: node --experimental-strip-types src/lib/gacha-core.test.mjs

import assert from "node:assert/strict"
import {
  MARKUP_CENTS,
  displayCents,
  markedPack,
  markupBps,
  payinQuoteOk,
  redeemStep,
  shipmentCents,
  emailsFromLinkedAccounts,
  walletsFromLinkedAccounts,
  freeState,
  heldCards,
  pastCards,
  sellbackHoursLeft,
  payoutTimeoutVerdict,
  buybackSold,
  buybackDead,
  buybackInFlight,
  buybackNotSold,
  isRedeemSessionGone,
  REDEEM_SESSION_GONE,
  SWEEP_DUST_CENTS,
  SWEEP_DUST_UNITS6,
  nextPullAction,
  cardYear,
  cardGrade,
  creditMatches,
  packCategory,
  packFamily,
  groupByFamily,
} from "./gacha-core.ts"
import {
  buildPayinQuoteBody,
  buildPayoutQuoteBody,
  centsToUnits6,
  parseSolanaQuote,
  quoteCovers,
  SOLANA_CHAIN_ID,
  SOLANA_USDC,
} from "./gacha-relay-core.ts"
import { b58, sigVerdict } from "./solana-client.ts"

// markup math: the marked $25 pack shows and charges $30, flat, no fee anywhere
assert.equal(MARKUP_CENTS, 500)
assert.equal(displayCents({ priceCents: 2500, markupCents: 500 }), 3000)
assert.equal(displayCents({ priceCents: 5000, markupCents: 0 }), 5000)
assert.equal(displayCents({ priceCents: 5000 }), 5000) // missing ⇒ no markup

// the markup is per-collection: only the Pokemon 25 pack carries it, and it
// is renamed to what it actually costs
{
  const marked = markedPack({ name: " pokemon 25 ", priceCents: 2500 })
  assert.equal(marked.name, "Pokemon 30")
  assert.equal(marked.markupCents, 500)
  assert.equal(displayCents(marked), 3000)
  // idempotent — re-marking the renamed pack keeps the markup
  assert.deepEqual(markedPack(marked), marked)
  for (const name of ["Pokemon 50", "Pokemon 250"]) {
    const plain = markedPack({ name, priceCents: 5000 })
    assert.equal(plain.name, name) // untouched
    assert.equal(plain.markupCents, 0) // sells at the Slabz price
    assert.equal(markupBps(5000, plain.markupCents), 0) // no appFee bps
  }
}

// bps floors: delivered = total − fee must NEVER dip under the pack price
assert.equal(markupBps(2500), 1666) // 500/3000 → 16.66̅% floored
assert.equal(markupBps(0, 0), 0)
{
  // simulated Relay application of the floored bps (fee on input, floored):
  const total = 3000_0000 // $30, 6dp
  const fee = Math.floor((total * markupBps(2500)) / 10_000)
  const delivered = total - fee
  assert.ok(delivered >= 2500_0000) // ≥ $25 — purchase can't fail on shortfall
  assert.ok(fee >= 499_0000 && fee <= 500_0000) // house collects ~$5
}

// pay-in quote check, fail-closed both directions
const okQuote = { receiveRaw: "25002000", appFeeUsd: 4.998, priceCents: 2500, markupCents: 500 }
assert.equal(payinQuoteOk(okQuote), true)
assert.equal(payinQuoteOk({ ...okQuote, receiveRaw: "24849600" }), false) // the live 24.8496 short fill
assert.equal(payinQuoteOk({ ...okQuote, receiveRaw: "30000000", appFeeUsd: 0 }), false) // dropped appFee gifts the markup
assert.equal(payinQuoteOk({ ...okQuote, appFeeUsd: 0 }), false) // fee missing even if delivery looks right
assert.equal(payinQuoteOk({ ...okQuote, receiveRaw: "" }), false) // Relay omitted the amount
assert.equal(payinQuoteOk({ ...okQuote, receiveRaw: "25.0" }), false) // formatted ≠ raw

// Relay leg quote bodies
const USER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const SOL = "UserSoLWallet11111111111111111111111111111"
const HOUSE = "0xffffffffffffffffffffffffffffffffffffffff"

const payin = buildPayinQuoteBody({
  userHlAddr: USER,
  userSolAddr: SOL,
  totalCents: 3000,
  appFeeRecipient: HOUSE,
  appFeeBps: markupBps(2500),
  subsidyCapUsdc: 5,
})
assert.equal(payin.originChainId, 1337)
assert.equal(payin.destinationChainId, SOLANA_CHAIN_ID)
assert.equal(payin.destinationCurrency, SOLANA_USDC)
assert.equal(payin.recipient, SOL) // the user's OWN wallet — no custody
assert.equal(payin.refundTo, USER) // failed fills bounce to the USER on HL
assert.equal(payin.amount, "3000000000") // $30 in 8dp HL perps units
assert.deepEqual(payin.appFees, [{ recipient: HOUSE, fee: "1666" }])
// unmarked pack: no markup ⇒ no appFees key (a fee:"0" entry is not a quote
// body Relay should have to interpret), and the user pays the bare price
{
  const plain = buildPayinQuoteBody({
    userHlAddr: USER,
    userSolAddr: SOL,
    totalCents: 5000,
    appFeeRecipient: HOUSE,
    appFeeBps: markupBps(5000, 0),
    subsidyCapUsdc: 5,
  })
  assert.equal("appFees" in plain, false)
  assert.equal(plain.amount, "5000000000") // $50, no markup added
  assert.equal(payinQuoteOk({ receiveRaw: "50000000", appFeeUsd: 0, priceCents: 5000, markupCents: 0 }), true)
  assert.equal(payinQuoteOk({ receiveRaw: "49000000", appFeeUsd: 0, priceCents: 5000, markupCents: 0 }), false)
}
assert.equal(payin.subsidizeFees, true)
// "app" must NEVER be sponsored: blanket subsidizeFees refunded our own
// $4.998 markup to the user out of the $5 cap (29.79-delivered quote,
// 2026-08-01) — the list is every component EXCEPT app
assert.deepEqual(payin.sponsoredFeeComponents, ["execution", "swap", "relay", "rent"])
// rent needs its own opt-in — subsidizeFees alone let ATA-creation rent be
// deducted from a live fill (24.8496 landed for a $25 pack)
assert.equal(payin.subsidizeRent, true)
// MANDATORY cap, always USDC 6dp per Relay docs (short fills are caught by
// payinQuoteOk in payinQuote, not by the cap)
assert.equal(payin.maxSubsidizationAmount, "5000000")

const payout = buildPayoutQuoteBody({
  userSolAddr: SOL,
  userHlAddr: USER,
  amountUnits6: "47000000", // sweep-all: on-chain balance, never client input
  subsidyCapUsdc: 5,
})
assert.equal(payout.originChainId, SOLANA_CHAIN_ID)
assert.equal(payout.destinationChainId, 1337)
assert.equal(payout.recipient, USER)
assert.equal(payout.refundTo, SOL) // failed fills bounce to the user's wallet
assert.equal(payout.amount, "47000000")
assert.equal(payout.maxSubsidizationAmount, "5000000") // origin Solana USDC, 6dp
assert.throws(() => buildPayoutQuoteBody({ userSolAddr: SOL, userHlAddr: USER, amountUnits6: "47.0", subsidyCapUsdc: 5 }))
assert.equal(centsToUnits6(4700), "47000000") // $47 in 6dp USDC units

// quote-covers guard: raw destination units, fail closed on junk
assert.equal(quoteCovers("25000000", "25000000"), true)
assert.equal(quoteCovers("24849600", "25000000"), false)
assert.equal(quoteCovers("", "25000000"), false)
assert.equal(quoteCovers("?", "25000000"), false)

// Solana quote parsing: both encodings + loud failure on neither
const serialized = {
  steps: [
    { requestId: "req-1", kind: "transaction", items: [{ data: { transaction: "AAAA" } }] },
  ],
  details: { currencyOut: { amount: "4700000000" } },
}
assert.deepEqual(parseSolanaQuote(serialized), {
  requestId: "req-1",
  step: { kind: "serialized", transaction: "AAAA" },
  checkEndpoint: "/intents/status/v3?requestId=req-1",
  receiveRaw: "4700000000",
})
assert.throws(() => parseSolanaQuote({ steps: [] }))

// identity-token emails: email logins use address, oauth uses email,
// wallets/garbage contribute nothing, everything lowercased
assert.deepEqual(
  emailsFromLinkedAccounts(
    JSON.stringify([
      { type: "email", address: "Lui@Example.com" },
      { type: "google_oauth", email: "g@example.com" },
      { type: "wallet", address: "0xcafe" },
    ]),
  ),
  ["lui@example.com", "g@example.com"],
)
assert.deepEqual(emailsFromLinkedAccounts("not json"), [])
assert.deepEqual(emailsFromLinkedAccounts(""), [])

// the same helper also parses Privy's REST user record (auth.ts falls back to
// it when the identity token can't reach us), whose entries carry many more
// fields — verified against a live /v1/users response
assert.deepEqual(
  emailsFromLinkedAccounts(
    JSON.stringify([
      {
        type: "wallet",
        address: "0xabc",
        chain_type: "ethereum",
        wallet_client_type: "privy",
        delegated: false,
      },
      {
        type: "email",
        address: "Beta@Example.com",
        verified_at: 1787117594,
        first_verified_at: 1787117594,
      },
    ]),
  ),
  ["beta@example.com"],
)
// no linked accounts at all (Privy returned an empty record) = no allowlist
// match, never a crash
assert.deepEqual(emailsFromLinkedAccounts(JSON.stringify([])), [])
// the allowlist/credits key for a wallet-only signup: wallets only, lowercased
// (checksum-cased EVM and a flat paste must land on one key), emails ignored
assert.deepEqual(
  walletsFromLinkedAccounts(
    JSON.stringify([
      { type: "email", address: "lui@example.com" },
      { type: "wallet", address: "0xAbCd00000000000000000000000000000000BeEf" },
      { type: "wallet", address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" },
      { type: "wallet" },
    ]),
  ),
  [
    "0xabcd00000000000000000000000000000000beef",
    "7xkxtg2cw87d97txjsdpbd5jbkhetqa83tzrujosgasu",
  ],
)
assert.deepEqual(walletsFromLinkedAccounts("not json"), [])
assert.deepEqual(walletsFromLinkedAccounts(""), [])

// journal resume invariants: never re-quote a live pay-in, never re-purchase
// a minted tx, foreign/absent journals start fresh
const PACK = "pack-1"
assert.deepEqual(nextPullAction(null, PACK), { kind: "fresh" })
assert.deepEqual(
  nextPullAction({ packId: "other", priceCents: 2500, slabzTxId: "t", ts: 1 }, PACK),
  { kind: "fresh" }, // asked about the wrong pack — see cross-pack resume below
)
assert.deepEqual(
  nextPullAction(
    { packId: PACK, priceCents: 2500, payinRequestId: "r", checkEndpoint: "/c", ts: 1 },
    PACK,
  ),
  { kind: "await_fill", checkEndpoint: "/c" }, // poll — a second quote is a double-$30
)
assert.deepEqual(
  nextPullAction(
    {
      packId: PACK,
      priceCents: 2500,
      payinRequestId: "r",
      checkEndpoint: "/c",
      slabzTxId: "tx-9",
      ts: 1,
    },
    PACK,
  ),
  { kind: "open", slabzTxId: "tx-9" }, // charge committed — resume, never re-buy
)
assert.deepEqual(
  nextPullAction({ packId: PACK, priceCents: 2500, ts: 1 }, PACK),
  { kind: "fresh" }, // journal without ids = nothing signed, safe to restart
)

// cross-pack resume: the journal is ONE slot per wallet, so the page resolves
// it by the journal's OWN pack (nextPullAction(j, j.packId)) — committed money
// is finished from ANY pack page instead of blocking (a vanished pack would
// deadlock every pull otherwise)
const foreign = { packId: "other", priceCents: 2500, ts: 1 }
assert.deepEqual(nextPullAction({ ...foreign, slabzTxId: "t" }, foreign.packId), {
  kind: "open",
  slabzTxId: "t",
})
assert.deepEqual(
  nextPullAction({ ...foreign, payinRequestId: "r", checkEndpoint: "/c" }, foreign.packId),
  { kind: "await_fill", checkEndpoint: "/c" },
)
assert.deepEqual(nextPullAction(foreign, foreign.packId), { kind: "fresh" }) // nothing in motion

// wallet collection: only completed, kept, still-on-chain cards show; deduped
{
  const card = (m) => ({ nftMint: m, autoSold: false })
  const txs = [
    { transactionId: "tx-A", status: "completed", card: card("A") },
    { transactionId: "tx-A2", status: "completed", card: card("A") }, // dupe mint
    { status: "completed", card: { nftMint: "B", autoSold: true } }, // auto-sold
    { status: "completed", card: card("C") }, // not on-chain (sold/transferred)
    { status: "failed", card: card("D") },
    { status: "completed", card: {} }, // opening not finished
    { status: "completed" },
  ]
  const owned = new Set(["A", "B", "D", "X"])
  assert.deepEqual(
    heldCards(txs, owned).map((c) => c.nftMint),
    ["A"],
  )
  assert.deepEqual(heldCards([], owned), [])
  assert.deepEqual(heldCards(txs, new Set()), [])
  // redeem is addressed by transaction: the FIRST tx for a mint wins, and a
  // tx with no id yields "" (the UI hides Ship on those instead of 404ing)
  assert.equal(heldCards(txs, owned)[0].transactionId, "tx-A")
  assert.equal(heldCards([{ status: "completed", card: card("A") }], owned)[0].transactionId, "")
  // createdAt rides along for the sell-back countdown
  assert.equal(
    heldCards(
      [{ transactionId: "tx-A", status: "completed", createdAt: "2026-08-07T00:00:00Z", card: card("A") }],
      owned,
    )[0].createdAt,
    "2026-08-07T00:00:00Z",
  )
  // gone half of the same history: auto-sold and off-chain (sold back) cards.
  // held ∪ past = every completed pull, and the two never overlap — that
  // partition is what lets the collection page be the ONLY pull ledger.
  assert.deepEqual(
    pastCards(txs, owned).map((c) => c.nftMint),
    ["B", "C"],
  )
  assert.deepEqual(pastCards([], owned), [])
  // no wallet read yet ⇒ nothing is "held", so every pulled card reads as gone
  // rather than silently vanishing from both lists
  assert.deepEqual(
    pastCards(txs, new Set()).map((c) => c.nftMint),
    ["A", "B", "C"],
  )
  assert.equal(
    heldCards(txs, owned).filter((h) => pastCards(txs, owned).some((g) => g.nftMint === h.nftMint))
      .length,
    0,
  )
}

// sell-back window: 72h from the pull, advisory countdown
{
  const t0 = Date.parse("2026-08-07T00:00:00Z")
  assert.equal(sellbackHoursLeft("2026-08-07T00:00:00Z", t0), 72)
  assert.equal(sellbackHoursLeft("2026-08-07T00:00:00Z", t0 + 71.5 * 3_600_000), 1) // ceil, not floor
  assert.equal(sellbackHoursLeft("2026-08-07T00:00:00Z", t0 + 72 * 3_600_000), 0)
  assert.equal(sellbackHoursLeft("2026-08-07T00:00:00Z", t0 + 100 * 3_600_000), 0) // never negative
  assert.equal(sellbackHoursLeft(undefined, t0), null)
  assert.equal(sellbackHoursLeft("garbage", t0), null)
}

// base58: the redeem-auth signature encoding. Known answers from the bs58
// package — a wrong encoding here fails Slabz's ed25519 verify, and 64-byte
// inputs (signatures) exercise a wider BigInt than the 32-byte pubkeys the
// on-chain owner check uses.
{
  const sig = new Uint8Array(64)
  for (let i = 0; i < 64; i++) sig[i] = (i * 7) % 256
  assert.equal(
    b58(sig),
    "12rWDwKCxbhzae37Eyku3HUpv512vAdixbYE38xoCW3WcPfdUtUKnHeWgHe3AzKXTouXedhskce1v6PXnfHEorY",
  )
  assert.equal(b58(new Uint8Array([0, 0, 1, 255])), "119p") // leading zeros survive
}

// slab tells for the grading reveal — real staging names (Slabz truncates at
// ~32 chars, so the grade is often gone and that row must collapse, not guess)
{
  assert.equal(cardYear("2003 #H32 Xatu-Holo PSA 9 Skyrid"), "2003")
  assert.equal(cardYear("1996 #6 Charizard-Holo PSA 5 Jap"), "1996")
  assert.equal(cardYear("#150 Giratina V"), null) // no year → row collapses
  assert.equal(cardYear("2025 #174 Eevee EX PSA 10 Svp EN"), "2025") // #174 isn't a year

  assert.equal(cardGrade("2003 #H32 Xatu-Holo PSA 9 Skyrid"), "PSA 9")
  assert.equal(cardGrade("2003 #003 May & Munchlax CGC 9.5"), "CGC 9.5")
  assert.equal(cardGrade("2025 #179 Mega Lucario EX psa10"), "PSA 10") // no space, lowercase
  assert.equal(cardGrade("2000 #1 Gym Heroes 1st Edition H"), null) // truncated away

  assert.equal(packCategory("pokemon_25"), "Pokémon")
  assert.equal(packCategory("sports_100"), null) // unknown category → row collapses
  assert.equal(packCategory(undefined), null)
}

// family groups tier variants of one product line into a single storefront tile
{
  assert.equal(packFamily("Pokemon 30"), "Pokemon")
  assert.equal(packFamily("Pokemon 2500"), "Pokemon")
  assert.equal(packFamily("One Piece 1,000"), "One Piece")
  assert.equal(packFamily("Pokemon Sealed"), "Pokemon Sealed") // no tier suffix → own family
  assert.equal(packFamily("100"), "100") // never collapse to empty

  const fams = groupByFamily([
    { name: "Pokemon 2500", priceCents: 250_000 },
    { name: "One Piece 250", priceCents: 25_000 },
    { name: "Pokemon 30", priceCents: 2_500, markupCents: 500 },
  ])
  // catalog order of first appearance, cheap → priciest inside a family
  assert.deepEqual(
    fams.map((ps) => ps.map((p) => p.name)),
    [["Pokemon 30", "Pokemon 2500"], ["One Piece 250"]],
  )
}

// bulk journal resumes at open_bulk — never re-purchases, wins over slabzTxId
{
  const bulk = { packId: "p1", priceCents: 5000, count: 2, bulkTxIds: ["t1", "t2"], ts: 1 }
  assert.deepEqual(nextPullAction(bulk, "p1"), { kind: "open_bulk", slabzTxIds: ["t1", "t2"] })
  assert.deepEqual(nextPullAction({ ...bulk, bulkTxIds: [] }, "p1"), { kind: "fresh" })
  assert.deepEqual(nextPullAction(bulk, "p2"), { kind: "fresh" }) // foreign pack
}

// free-pack credits: a credit must open EXACTLY the pack it was granted for.
// "Pokemon 30" and "Pokemon 2500" share a family and differ ~80x in cost, so
// family matching here would hand out $2,500 packs on a $25 entitlement.
{
  const c = (packName) => ({ packName })
  assert.equal(creditMatches(c("Pokemon 30"), "Pokemon 30"), true)
  assert.equal(creditMatches(c("pokemon 30"), "Pokemon 30"), true) // case
  assert.equal(creditMatches(c(" Pokemon 30 "), "Pokemon 30"), true) // padding
  assert.equal(creditMatches(c("Pokemon 30"), "Pokemon 2500"), false) // same family!
  assert.equal(creditMatches(c("Pokemon 30"), "One Piece 250"), false)
  assert.equal(creditMatches(c("Pokemon 30"), "Pokemon"), false) // family != pack
  // "*" is the goodwill/any-pack grant
  assert.equal(creditMatches(c("*"), "Pokemon 2500"), true)
  assert.equal(creditMatches(c("*"), "anything"), true)
  // a credit for the pre-markup name must NOT open the marked pack: markedPack
  // renames "Pokemon 25" -> "Pokemon 30", and pack names are compared post-rename
  assert.equal(creditMatches(c("Pokemon 25"), "Pokemon 30"), false)
  assert.equal(markedPack({ name: "Pokemon 25", priceCents: 2500 }).name, "Pokemon 30")
}

// free/paid CTA gating: an in-flight peek is `undefined`, not "none". Showing
// "Claim free pack" to someone who has none is the confusing half; showing a
// price to someone who has one charges for a pack they already owned.
{
  assert.deepEqual(freeState(undefined, undefined), {
    free: false, unknown: true, packsLeft: 0, showPaid: false,
  }) // both peeks in flight — no price, no gift claim
  assert.deepEqual(freeState(null, undefined), {
    free: false, unknown: true, packsLeft: 0, showPaid: false,
  }) // gift answered "none", credit still loading
  assert.deepEqual(freeState(null, null), {
    free: false, unknown: false, packsLeft: 0, showPaid: true,
  }) // both answered "none" — paid pull
  assert.deepEqual(freeState(null, { packs: 2 }), {
    free: true, unknown: false, packsLeft: 2, showPaid: false,
  })
  assert.deepEqual(freeState({ packsRemaining: 3 }, null), {
    free: true, unknown: false, packsLeft: 3, showPaid: false,
  })
  // a spent gift falls back to the credit, not to a paid pull
  assert.deepEqual(freeState({ packsRemaining: 0 }, { packs: 1 }), {
    free: true, unknown: false, packsLeft: 1, showPaid: false,
  })
}

// --- payoutTimeoutVerdict: a bridge timeout is not a lost payout ---
{
  // wallet drained ⇒ the transfer left; Relay fills or refunds to the same
  // wallet, and the auto-sweeper is the recovery either way
  assert.equal(payoutTimeoutVerdict(BigInt(0)), "inflight")
  assert.equal(payoutTimeoutVerdict(SWEEP_DUST_UNITS6 - BigInt(1)), "inflight")
  // still holding a sweepable balance ⇒ nothing moved, surface it
  assert.equal(payoutTimeoutVerdict(SWEEP_DUST_UNITS6), "stuck")
  assert.equal(payoutTimeoutVerdict(BigInt(30_000_000)), "stuck")
  // FAIL CLOSED: an unreadable balance must never be reported as delivered
  assert.equal(payoutTimeoutVerdict(null), "stuck")
  // the floor must stay in lockstep with MIN_UNITS6 in the payout-quote route
  assert.equal(SWEEP_DUST_CENTS, 50)
  assert.equal(SWEEP_DUST_UNITS6, BigInt(500_000))
}

// --- sigVerdict: ask the chain, and don't call "processed" done ---
{
  assert.equal(sigVerdict({ confirmationStatus: "confirmed" }), "confirmed")
  assert.equal(sigVerdict({ confirmationStatus: "finalized" }), "confirmed")
  // "processed" can still be dropped on a fork — must NOT read as done
  assert.equal(sigVerdict({ confirmationStatus: "processed" }), "pending")
  // RPC hasn't seen it yet: pending, never failed
  assert.equal(sigVerdict(null), "pending")
  assert.equal(sigVerdict(undefined), "pending")
  assert.equal(sigVerdict({}), "pending")
  // an on-chain error is terminal even at a confirmed commitment
  assert.equal(sigVerdict({ confirmationStatus: "finalized", err: { InstructionError: [0, {}] } }), "failed")
  assert.equal(sigVerdict({ confirmationStatus: "processed", err: "anything" }), "failed")
  // err:null is the success shape Solana actually returns — not a failure
  assert.equal(sigVerdict({ confirmationStatus: "confirmed", err: null }), "confirmed")
}

// --- buyback state: the field drift and the "only completed is sold" rule ---
{
  // submit answers `status`; initiate and buyback/status answer `buybackStatus`
  assert.equal(buybackSold({ status: "completed" }), true)
  assert.equal(buybackSold({ buybackStatus: "completed" }), true)
  // buybackStatus wins when both are present
  assert.equal(buybackSold({ buybackStatus: "completed", status: "submitted" }), true)
  assert.equal(buybackSold({ buybackStatus: "submitted", status: "completed" }), false)
  // NOTHING else counts as sold — a false positive tells a user their card is
  // gone when they still own it. Case variants of "completed" DO count (see the
  // folding asserts below): the danger is a wrong STATE, not a wrong case.
  for (const s of ["submitted", "pending", "failed", "none", "", "complete", "completed!"])
    assert.equal(buybackSold({ status: s }), false, `must not read "${s}" as sold`)
  assert.equal(buybackSold(null), false)
  assert.equal(buybackSold(undefined), false)
  assert.equal(buybackSold({}), false)

  // terminal not-sold, by shape
  for (const s of ["failed", "FAILED", "rejected", "cancelled", "canceled", "expired"])
    assert.equal(buybackDead(s), true, `"${s}" is terminal`)
  // in-flight and success states must NEVER read as dead — abandoning a live
  // settlement is how proceeds get stranded.
  // `none` is NOT dead-by-wording and stays out of this regex on purpose; it is
  // "no buyback exists", handled by buybackAbsent with a grace window, because
  // trusting it instantly would kill a just-recorded buyback.
  for (const s of ["submitted", "pending", "completed", "none", "", null, undefined])
    assert.equal(buybackDead(s), false, `"${s}" must not read as dead`)

  // case/whitespace folding: a "Completed" payload used to read as neither sold
  // nor dead and fell through to the "your payout is coming" promise
  assert.equal(buybackSold({ status: "Completed" }), true)
  assert.equal(buybackSold({ status: " completed " }), true)
  assert.equal(buybackSold({ buybackStatus: "COMPLETED" }), true)

  // buybackNotSold: our submit did not take effect. `pending` belongs HERE, not
  // in "in flight" — the docs put pending and failed under "not sold yet", and
  // reading pending as progress promises a payout for a sale that never
  // happened (this exact mapping was a live bug).
  for (const s of ["none", "None", " none ", "pending", "PENDING"])
    assert.equal(buybackNotSold(s), true, `"${s}" means our submit did not land`)
  for (const s of ["submitted", "completed", "failed", "expired"])
    assert.equal(buybackNotSold(s), false, `"${s}" is not a did-not-land state`)
  // an unreadable status is NOT "not sold" — we simply don't know, and the
  // caller must neither promise money nor declare failure from it
  for (const s of ["", null, undefined]) assert.equal(buybackNotSold(s), false)

  // buybackInFlight: the ONLY state that may promise the user money is coming
  assert.equal(buybackInFlight("submitted"), true)
  assert.equal(buybackInFlight("SUBMITTED"), true)
  for (const s of ["pending", "none", "completed", "failed", "", null, undefined])
    assert.equal(buybackInFlight(s), false, `"${s}" must not read as in flight`)

  // the four predicates must be mutually exclusive — no status may be two
  // things at once, or the poll's branch order silently decides the outcome
  for (const s of ["completed", "submitted", "pending", "failed", "expired", "none", ""]) {
    const hits =
      Number(buybackSold({ status: s })) +
      Number(buybackDead(s)) +
      Number(buybackNotSold(s)) +
      Number(buybackInFlight(s))
    assert.ok(hits <= 1, `"${s}" matched ${hits} predicates — must be at most 1`)
  }
}

// --- redeem session expiry: code, never status ---
{
  assert.equal(isRedeemSessionGone({ code: REDEEM_SESSION_GONE, status: 401 }), true)
  assert.equal(isRedeemSessionGone({ code: REDEEM_SESSION_GONE }), true)
  // OUR gate's 401 must stay the re-login path — re-signing a redeem session
  // for it would retry into the same 401 forever
  assert.equal(isRedeemSessionGone({ code: "UNAUTHORIZED", status: 401 }), false)
  assert.equal(isRedeemSessionGone({ status: 401 }), false)
  // other PARTNER_ redeem errors are terminal, not session problems
  for (const c of ["PARTNER_REDEEM_ALREADY_DONE", "PARTNER_REDEEM_NOT_PREPARED",
                   "PARTNER_REDEEM_NONCE_EXPIRED", "PARTNER_REDEEM_AUTH_FAILED"])
    assert.equal(isRedeemSessionGone({ code: c, status: 401 }), false, c)
  assert.equal(isRedeemSessionGone(null), false)
  assert.equal(isRedeemSessionGone(undefined), false)
  assert.equal(isRedeemSessionGone({}), false)
}

// --- prepare vs resume: never create a second shipment for one card ---
{
  // nothing prepared yet
  assert.equal(redeemStep(null), "prepare")
  assert.equal(redeemStep(undefined), "prepare")
  assert.equal(redeemStep({}), "prepare")
  assert.equal(redeemStep({ redeemStatus: "none" }), "prepare")
  // prepared but never burned — resume the SAME shipment, don't re-prepare
  assert.equal(redeemStep({ redeemStatus: "pending_burn" }), "resume")
  // already gone, or ambiguous: show it, never burn again
  for (const st of ["processing", "shipped", "delivered", "failed", "cancelled"])
    assert.equal(redeemStep({ redeemStatus: st }), "existing", st)
  // an unknown future status must not read as "safe to prepare"
  assert.equal(redeemStep({ redeemStatus: "held_at_customs" }), "existing")
}

// --- a resumed shipment's price is a burn ceiling: unreadable must be null ---
{
  assert.equal(shipmentCents("6.17"), 617)
  assert.equal(shipmentCents("5.99"), 599)
  assert.equal(shipmentCents("6.001"), 601) // ceil, never round the user down
  // every one of these would make `prepCents > ceiling` false and let an
  // unpriced burn through, so they must refuse instead
  for (const bad of [undefined, "", "  ", "abc", "0", "-5", "NaN", "Infinity"])
    assert.equal(shipmentCents(bad), null, String(bad))
}

console.log("gacha-core.test.mjs OK")
