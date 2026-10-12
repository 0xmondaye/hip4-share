// node --experimental-strip-types src/lib/gacha-server/svm-tx.test.mjs
// Fixture captured from a live keyless Relay payout quote (2026-08-01).
import assert from "node:assert/strict"
import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit"
import {
  assertSponsorIsolated,
  buildUnsignedSvmTxB64,
  payoutFeeLamports,
  verifyGiftFundingTx,
  verifyPayoutTx,
} from "./svm-tx.ts"

const USER = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9"
const instructions = [
  {
    programId: "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2",
    keys: [
      { pubkey: "Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc", isSigner: false, isWritable: false },
      { pubkey: USER, isSigner: true, isWritable: true },
      { pubkey: USER, isSigner: false, isWritable: false },
      { pubkey: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", isSigner: false, isWritable: false },
      { pubkey: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", isSigner: false, isWritable: false },
      { pubkey: "11111111111111111111111111111111", isSigner: false, isWritable: false },
    ],
    data: "0b9c60da27a3b41340787d0100000000ff024ae7", // hex, no 0x — live shape
  },
]
const lookupTables = {
  // a fake table containing some of the instruction's accounts — exercises
  // the compression path without an RPC fetch
  Hm9fUgcn7qwDaiNTFiGh6pNtVATgnaRcmK6Bbx6EMZfP: [
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  ],
}
const blockhash = "9sHcv6xwn9YkB8nxTUGKDwPwNnmqZp5oCCXcJTGmXWa4"

const b64 = buildUnsignedSvmTxB64({
  feePayer: USER,
  blockhash,
  lastValidBlockHeight: BigInt(1000),
  instructions,
  lookupTables,
})
const wire = Buffer.from(b64, "base64")
// wire layout: [numSigs=1][64 zero bytes][0x80 version byte][message…]
assert.equal(wire[0], 1, "exactly one required signature (the user wallet)")
assert.ok(wire.subarray(1, 65).every((b) => b === 0), "signature slot is a zero placeholder")
assert.equal(wire[65], 0x80, "v0 transaction version byte")
assert.equal(wire[66], 1, "numRequiredSignatures = 1 in message header")

// same build without tables still compiles (payouts with no ALTs)
const plain = buildUnsignedSvmTxB64({
  feePayer: USER,
  blockhash,
  lastValidBlockHeight: BigInt(1000),
  instructions,
  lookupTables: {},
})
assert.ok(Buffer.from(plain, "base64").length > 65)
// ALT compression must shrink the account table
assert.ok(wire.length < Buffer.from(plain, "base64").length, "lookup tables compress the tx")

// garbage data fails loud, before anyone signs
assert.throws(
  () =>
    buildUnsignedSvmTxB64({
      feePayer: USER,
      blockhash,
      lastValidBlockHeight: BigInt(1000),
      instructions: [{ ...instructions[0], data: "zz-not-hex" }],
      lookupTables: {},
    }),
  /isn't hex/,
)

// ---- verifyPayoutTx: the house co-signature trust boundary ----------------
const HOUSE = "Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc" // stand-in executor
const decode = (b) => getTransactionDecoder().decode(Buffer.from(b, "base64"))
const build = (feePayer, keys) =>
  buildUnsignedSvmTxB64({
    feePayer,
    blockhash,
    lastValidBlockHeight: BigInt(1000),
    instructions: [{ programId: "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2", keys, data: "0b9c" }],
    lookupTables: {},
  })

// good: house pays the fee, only the user signs inside the instruction
const good = build(HOUSE, [{ pubkey: USER, isSigner: true, isWritable: true }])
verifyPayoutTx(decode(good), HOUSE)

// wrong fee payer (user-paid tx must never get the house signature)
assert.throws(() => verifyPayoutTx(decode(good), USER), /fee payer/)

// instruction touches the sponsor account — co-signing could move its SOL
const drain = build(HOUSE, [
  { pubkey: HOUSE, isSigner: false, isWritable: true },
  { pubkey: USER, isSigner: true, isWritable: true },
])
assert.throws(() => verifyPayoutTx(decode(drain), HOUSE), /references the sponsor/)

// sponsor-only tx (no user signer) isn't one we assembled
const solo = build(HOUSE, [{ pubkey: USER, isSigner: false, isWritable: true }])
assert.throws(() => verifyPayoutTx(decode(solo), HOUSE), /expected 2/)

// ---- verifyGiftFundingTx: the gift-funding signature trust boundary --------
// good: funder pays the fee; instructions may (must) reference it — the spend
// bound is the grant route's simulation, not this
const giftGood = build(HOUSE, [
  { pubkey: HOUSE, isSigner: false, isWritable: true }, // funder's USDC ATA moves
  { pubkey: USER, isSigner: false, isWritable: true },
])
verifyGiftFundingTx(decode(giftGood), HOUSE)

// wrong fee payer — someone else's tx must never get the funder signature
assert.throws(() => verifyGiftFundingTx(decode(giftGood), USER), /fee payer/)

// mainnet shape: Slabz co-signs. Allowed — our sig still only authorizes this
// message, and the funder stays at slot 0 (the only slot we fill)
const coSigned = build(HOUSE, [{ pubkey: USER, isSigner: true, isWritable: true }])
verifyGiftFundingTx(decode(coSigned), HOUSE)
// ...but a co-signed tx whose fee payer is someone else is still refused
assert.throws(() => verifyGiftFundingTx(decode(coSigned), USER), /fee payer/)

// ---- assertSponsorIsolated: the ALT-proof half of the payout boundary -----
// verifyPayoutTx reads COMPILED indices and never resolves lookup tables, so a
// sponsor reference compressed into an ALT index slips past it. This check runs
// on the plain pubkeys, before compression, where it cannot be hidden.
const ix = (keys) => [{ programId: "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2", keys, data: "0b9c" }]

// clean payout: nothing names the sponsor
assertSponsorIsolated(HOUSE, ix([{ pubkey: USER, isSigner: true, isWritable: true }]))

// sponsor named as an account — the drain shape, whether or not an ALT hides it
assert.throws(
  () => assertSponsorIsolated(HOUSE, ix([{ pubkey: HOUSE, isSigner: false, isWritable: true }])),
  /references the sponsor/,
)
// read-only still counts: rent/refund destinations need no write flag
assert.throws(
  () => assertSponsorIsolated(HOUSE, ix([{ pubkey: HOUSE, isSigner: false, isWritable: false }])),
  /references the sponsor/,
)
// sponsor as the invoked program
assert.throws(
  () => assertSponsorIsolated(HOUSE, [{ programId: HOUSE, keys: [], data: "0b" }]),
  /invokes the sponsor/,
)
// a later instruction in a multi-instruction tx must not escape the scan
assert.throws(
  () =>
    assertSponsorIsolated(HOUSE, [
      ...ix([{ pubkey: USER, isSigner: true, isWritable: true }]),
      ...ix([{ pubkey: HOUSE, isSigner: false, isWritable: true }]),
    ]),
  /references the sponsor/,
)
// and it must agree with verifyPayoutTx: anything the compiled check rejects,
// this rejects too (the reverse is the gap this closes)
assert.throws(() => verifyPayoutTx(decode(drain), HOUSE), /references the sponsor/)
assert.throws(
  () => assertSponsorIsolated(HOUSE, ix([
    { pubkey: HOUSE, isSigner: false, isWritable: true },
    { pubkey: USER, isSigner: true, isWritable: true },
  ])),
  /references the sponsor/,
)

// ---- the fee is attacker-chosen, so it must be bounded -------------------
// ComputeBudget instructions carry ZERO accounts, so the account-reference
// rules above can never see them. Before this bound, verifyPayoutTx accepted a
// message with any priority fee and the sponsor paid it — charged even when the
// transaction FAILS on-chain (probe-confirmed against the real decoder).
const CB = "ComputeBudget111111111111111111111111111111"
const u32le = (n) => { const b = Buffer.alloc(5); b[0] = 2; b.writeUInt32LE(n, 1); return b.toString("hex") }
const u64le = (n) => { const b = Buffer.alloc(9); b[0] = 3; b.writeBigUInt64LE(BigInt(n), 1); return b.toString("hex") }
const feeTx = (cuLimit, microLamports) =>
  decode(
    buildUnsignedSvmTxB64({
      feePayer: HOUSE,
      blockhash,
      lastValidBlockHeight: BigInt(1000),
      instructions: [
        { programId: CB, keys: [], data: u32le(cuLimit) },
        { programId: CB, keys: [], data: u64le(microLamports) },
        ...ix([{ pubkey: USER, isSigner: true, isWritable: true }]),
      ],
      lookupTables: {},
    }),
  )

// base fee only: 5000 x 2 signers
const noPriority = decode(build(HOUSE, [{ pubkey: USER, isSigner: true, isWritable: true }]))
const msgOf = (tx) => getCompiledTransactionMessageDecoder().decode(tx.messageBytes)
assert.equal(payoutFeeLamports(msgOf(noPriority)), 10_000n)

// 1.4M CU at 50k microLamports/CU = 70_000 priority + 10_000 base
assert.equal(payoutFeeLamports(msgOf(feeTx(1_400_000, 50_000))), 80_000n)
// a realistic priority fee is allowed through
verifyPayoutTx(feeTx(1_400_000, 50_000), HOUSE)

// an abusive one is refused rather than silently paid
assert.throws(() => verifyPayoutTx(feeTx(1_400_000, 10_000_000), HOUSE), /over the .* cap/)
// u64::MAX must not overflow into a small number and sneak past
assert.throws(
  () => verifyPayoutTx(feeTx(1_400_000, 2n ** 64n - 1n), HOUSE),
  /over the .* cap/,
)
// ceil, never floor — under-reporting the fee is the unsafe direction
assert.equal(payoutFeeLamports(msgOf(feeTx(1, 1))), 10_001n)

console.log("svm-tx: all assertions passed")
