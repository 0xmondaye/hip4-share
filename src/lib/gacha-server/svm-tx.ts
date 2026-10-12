// Assemble Relay's instruction-list SVM quote step into an unsigned v0
// transaction the client can sign & send unchanged (the "serialized" path).
// Live payout quote 2026-08-01: SVM-origin steps come as {instructions,
// addressLookupTableAddresses}, instruction data hex-encoded without 0x.

import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
  type Transaction,
} from "@solana/kit"
import type { SolanaQuoteStep } from "../gacha-relay-core.ts"
import { executorSigner, rpc } from "./gas-sponsor.ts"

type InstructionsStep = Extract<SolanaQuoteStep, { kind: "instructions" }>

function hexToBytes(h: string): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h
  // fail loud on anything but hex — a silently mis-decoded instruction would
  // produce an on-chain failure after the user signed
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2)
    throw new Error("Relay instruction data isn't hex")
  return Uint8Array.from(s.match(/.{2}/g) ?? [], (b) => parseInt(b, 16))
}

/** Pure v0-tx build (no RPC) — the unit-tested core. Signature slots are
 *  zero-filled placeholders; the user's wallet signs client-side. */
export function buildUnsignedSvmTxB64(input: {
  feePayer: string
  blockhash: string
  lastValidBlockHeight: bigint
  instructions: InstructionsStep["instructions"]
  /** lookup table address → its full addresses list, pre-fetched */
  lookupTables: Record<string, string[]>
}): string {
  const ixs: Instruction[] = input.instructions.map((ix) => ({
    programAddress: address(ix.programId),
    accounts: ix.keys.map((k) => ({
      address: address(k.pubkey),
      role: k.isSigner
        ? k.isWritable
          ? AccountRole.WRITABLE_SIGNER
          : AccountRole.READONLY_SIGNER
        : k.isWritable
          ? AccountRole.WRITABLE
          : AccountRole.READONLY,
    })),
    data: hexToBytes(ix.data),
  }))
  const tables = Object.fromEntries(
    Object.entries(input.lookupTables).map(([t, addrs]) => [
      address(t),
      addrs.map((a) => address(a)),
    ]),
  ) as Record<Address, Address[]>
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(input.feePayer), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: input.blockhash as Blockhash,
          lastValidBlockHeight: input.lastValidBlockHeight,
        },
        m,
      ),
    (m) => appendTransactionMessageInstructions(ixs, m),
    (m) =>
      Object.keys(tables).length
        ? compressTransactionMessageUsingAddressLookupTables(m, tables)
        : m,
  )
  return getBase64EncodedWireTransaction(compileTransaction(message))
}

/**
 * Trust boundary for the house co-signature. The client posts a user-signed
 * transaction and asks the executor to pay its fee; the executor's ed25519
 * signature authorizes the WHOLE message, so before signing we require:
 *   - fee payer (static account 0) is the executor — its only role
 *   - NO instruction references account 0 (a referencing instruction — e.g.
 *     a system transfer sourced from it — would let the co-signature move
 *     the executor's SOL, not just pay the fee)
 * ALT-loaded accounts can't be signers (signers must be static), so lookup
 * tables can't smuggle the executor in. Throws on any violation.
 */
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111"
/** ComputeBudget instruction discriminators (first data byte). */
const CB_SET_UNIT_LIMIT = 2
const CB_SET_UNIT_PRICE = 3
/** Solana's per-instruction default CU when no explicit limit is set, and the
 *  runtime's hard ceiling on a requested limit. */
const DEFAULT_CU_PER_IX = 200_000
const MAX_CU_LIMIT = 1_400_000
const LAMPORTS_PER_SIGNATURE = BigInt(5000)

/**
 * Lamports the fee payer will be charged for this message, worst case.
 *
 * `fee = 5000 x signatures + ceil(computeUnitLimit x microLamportsPerCU / 1e6)`.
 * Both ComputeBudget knobs are read off the instruction data; absent a
 * SetComputeUnitPrice there is no priority fee at all.
 *
 * Exported for the test — this is the number a caller could otherwise choose
 * for us, and the fee is charged even when the transaction FAILS on-chain.
 */
export function payoutFeeLamports(msg: {
  staticAccounts: readonly string[]
  header: { numSignerAccounts: number }
  // ReadonlyUint8Array in the decoder's own types — read-only is all we need
  instructions: readonly {
    programAddressIndex: number
    data?: { readonly length: number; readonly [n: number]: number } & ArrayLike<number>
  }[]
}): bigint {
  let limit: bigint | null = null
  let microLamports = BigInt(0)
  for (const ix of msg.instructions) {
    if (msg.staticAccounts[ix.programAddressIndex] !== COMPUTE_BUDGET_PROGRAM) continue
    const d = ix.data
    if (!d || d.length === 0) continue
    // little-endian reads off ArrayLike bytes — avoids depending on the
    // decoder's ReadonlyUint8Array carrying a buffer/byteOffset
    const le = (at: number, n: number) => {
      let v = BigInt(0)
      for (let i = n - 1; i >= 0; i--) v = (v << BigInt(8)) | BigInt(d[at + i] & 0xff)
      return v
    }
    if (d[0] === CB_SET_UNIT_LIMIT && d.length >= 5) limit = le(1, 4)
    else if (d[0] === CB_SET_UNIT_PRICE && d.length >= 9) microLamports = le(1, 8)
  }
  const cu =
    limit ?? BigInt(Math.min(DEFAULT_CU_PER_IX * msg.instructions.length, MAX_CU_LIMIT))
  const base = LAMPORTS_PER_SIGNATURE * BigInt(msg.header.numSignerAccounts)
  // ceil division — never under-report what the sponsor could be charged
  const priority = (cu * microLamports + BigInt(999_999)) / BigInt(1_000_000)
  return base + priority
}

/**
 * Ceiling on what one payout may cost the house in Solana fees. Base fee is
 * 5000/signature; everything above that is a priority fee the CALLER chooses,
 * so it needs a bound.
 *
 * Calibrated against the real executor balance, not picked for roundness: a
 * payout is 2 signatures (10_000 lamports base) and a generous Solana priority
 * fee is tens of thousands, so 200_000 is ~20x the base and ample. It also has
 * to be small relative to what the executor actually holds — at the 0.0065 SOL
 * observed on 2026-08-24 a 1_000_000 cap would have let ONE transaction burn
 * 15% of the balance, and the 20/day per-user send cap would have authorised 3x
 * the whole balance. Raise it deliberately (and top the executor up) if real
 * congestion ever needs more.
 */
const MAX_PAYOUT_FEE_LAMPORTS = BigInt(
  process.env.GACHA_MAX_PAYOUT_FEE_LAMPORTS ?? 200_000, // 0.0002 SOL
)

export function verifyPayoutTx(tx: Transaction, executorAddr: string): void {
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes)
  if (!("instructions" in msg))
    throw new Error("unsupported transaction message version")
  if (msg.staticAccounts[0] !== executorAddr)
    throw new Error("payout tx fee payer isn't the house sponsor")
  for (const ix of msg.instructions) {
    if (ix.programAddressIndex === 0 || ix.accountIndices?.includes(0))
      throw new Error("payout tx references the sponsor beyond fee payment")
  }
  // exactly sponsor + user — anything else wasn't assembled by us
  if (msg.header.numSignerAccounts !== 2)
    throw new Error(`payout tx wants ${msg.header.numSignerAccounts} signers, expected 2`)
  // The sponsor may appear ONCE, as the fee payer. The checks above only ever
  // look at index 0, so a second static slot holding the same address would
  // slip past them and pick up our signature (partiallySignTransaction fills by
  // address, not by slot). The runtime would reject that as AccountLoadedTwice,
  // but relying on the runtime to protect our key is not a boundary.
  if ((msg.staticAccounts as readonly string[]).lastIndexOf(executorAddr) !== 0)
    throw new Error("payout tx names the sponsor more than once")
  // Every program must be a STATIC account. A program reached through an address
  // lookup table is unidentifiable here — we never resolve tables — and the fee
  // bound below depends on recognising the ComputeBudget program.
  for (const ix of msg.instructions)
    if (ix.programAddressIndex >= msg.staticAccounts.length)
      throw new Error("payout tx invokes a program through a lookup table")
  // THE FEE. Rules 1-3 bound account references, and a ComputeBudget
  // instruction has NO accounts — so an attacker-set priority fee was invisible
  // to all of them, and the fee is charged to the sponsor even when the
  // transaction fails on-chain. Nothing binds the posted bytes to the quote we
  // minted, so this must be bounded here.
  const fee = payoutFeeLamports(msg)
  if (fee > MAX_PAYOUT_FEE_LAMPORTS)
    throw new Error(
      `payout tx would charge the sponsor ${fee} lamports, over the ${MAX_PAYOUT_FEE_LAMPORTS} cap`,
    )
}

/**
 * Trust boundary for gift funding (free packs). Slabz hands us an unsigned tx
 * that spends the house funder's USDC; our ed25519 signature authorizes the
 * WHOLE message, so before signing require the fee payer (static account 0)
 * to be the funder — slot 0 is the only signature we ever add.
 *
 * Co-signers are allowed. Our signature's power comes from the MESSAGE, not
 * from who else signs it, and mainnet Slabz co-signs the gift escrow where
 * staging did not (the "wants 2 signers" prod failure). Log them, trust none.
 *
 * Unlike verifyPayoutTx, instructions here MUST reference the funder (it's
 * the payer), so the spend bound comes from the grant route's simulation
 * check (USDC delta ≤ quoted price), not from account isolation. That check,
 * not this one, is what caps a blind signature — never sign without it.
 */
export function verifyGiftFundingTx(tx: Transaction, funderAddr: string): void {
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes)
  if (!("instructions" in msg))
    throw new Error("unsupported transaction message version")
  if (msg.staticAccounts[0] !== funderAddr)
    throw new Error("gift funding tx fee payer isn't the house funder")
  const coSigners = msg.staticAccounts.slice(1, msg.header.numSignerAccounts)
  if (coSigners.length) console.warn("[gacha] gift funding co-signers", coSigners)
}

/** Verify, co-sign as fee payer, broadcast. Returns the tx signature. The
 *  user's own signature must already be present (preflight rejects otherwise,
 *  so a forged/unsigned post costs the executor nothing). */
export async function coSignAndSendPayout(txB64: string): Promise<string> {
  const signer = await executorSigner()
  const tx = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(txB64, "base64")))
  verifyPayoutTx(tx, signer.address)
  const signed = await partiallySignTransaction([signer.keyPair], tx)
  return await rpc()
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: "base64",
      skipPreflight: false, // preflight verifies the user's signature too
    })
    .send()
}

/**
 * Sponsor isolation, enforced on the PLAIN pubkeys — the only place it cannot
 * be evaded.
 *
 * verifyPayoutTx enforces the same rule downstream, but it reads COMPILED
 * account indices and never resolves address lookup tables. So a reference to
 * the fee payer that ALT compression moved into a table index is invisible to
 * it: its `accountIndices.includes(0)` test only sees static slot 0. Relay
 * supplies BOTH the instruction list and the tables, which is exactly where a
 * sponsor-draining account reference would hide.
 *
 * Payout-path only, deliberately. The gift-funding tx MUST reference its funder
 * (the funder's USDC is what moves), so this rule is wrong there — that path is
 * bounded by the grant route's simulation instead. That is also why this does
 * not live in buildUnsignedSvmTxB64, which is a dumb encoder.
 *
 * If verifyPayoutTx passes for a given tx today, this cannot fire on it.
 */
export function assertSponsorIsolated(
  feePayer: string,
  instructions: InstructionsStep["instructions"],
): void {
  for (const ix of instructions) {
    if (ix.programId === feePayer)
      throw new Error("payout instruction invokes the sponsor as a program")
    for (const k of ix.keys)
      if (k.pubkey === feePayer)
        throw new Error("payout instruction references the sponsor beyond fee payment")
  }
}

/** RPC wrapper: fetch lookup tables + a fresh blockhash, then build. */
export async function assembleInstructionsTxB64(
  feePayer: string,
  step: InstructionsStep,
): Promise<string> {
  // before any RPC work, and before the ALTs can hide anything
  assertSponsorIsolated(feePayer, step.instructions)
  const lookupTables: Record<string, string[]> = {}
  for (const t of step.addressLookupTableAddresses) {
    const res = await rpc()
      .getAccountInfo(address(t), { encoding: "jsonParsed" })
      .send()
    const addrs = (
      res.value?.data as { parsed?: { info?: { addresses?: string[] } } } | undefined
    )?.parsed?.info?.addresses
    if (!Array.isArray(addrs))
      throw new Error(`Relay lookup table ${t} unreadable — try again shortly`)
    lookupTables[t] = addrs
  }
  const { value } = await rpc().getLatestBlockhash().send()
  return buildUnsignedSvmTxB64({
    feePayer,
    blockhash: value.blockhash,
    lastValidBlockHeight: BigInt(value.lastValidBlockHeight),
    instructions: step.instructions,
    lookupTables,
  })
}
