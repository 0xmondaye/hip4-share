// House-funded free packs: mint a Slabz gift a chosen wallet can claim at no
// cost. Two callers — the admin curl route (/api/gacha/gift-grant) and the
// self-serve credit claim (/api/gacha/credits, gacha_credits entitlements).
//
// The funder key (GACHA_GIFT_FUNDER_SOLANA_KEY) is a separate wallet from the
// executor — the executor's invariant is "SOL only, never USDC" and stays
// that way. The funder holds USDC + dust SOL.
//
// ITS BALANCE IS THE CAMPAIGN BUDGET CAP: every mint moves the full Slabz
// price (no markup is collected on a free pack — it is pure CAC), and a dry
// funder fails closed before anything is signed. Fund it with exactly the
// campaign budget and top it up per campaign; that is the only spend limit,
// deliberately, because it cannot be bypassed by a bug in our own accounting.

import {
  address,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  type Base64EncodedWireTransaction,
} from "@solana/kit"
import { rpc, signerFromEnv, USDC_MINT } from "./gas-sponsor"
import { verifyGiftFundingTx } from "./svm-tx"
import { getPack, giftCreate, giftGet, giftSubmit } from "./slabz"
import { GachaError } from "./http"
import { SlabzError } from "@/lib/slabz"

export type GrantedGift = {
  giftId: string
  status: string
  packId: string
  packCount: number
  priceCents: number
  receiverAddress: string
}

/** Funder USDC across its token accounts: raw units + the account addresses
 *  (the simulation re-reads exactly these to bound the spend). */
async function funderUsdc(owner: string): Promise<{ units: bigint; accounts: string[] }> {
  const res = await rpc()
    .getTokenAccountsByOwner(address(owner), { mint: address(USDC_MINT) }, { encoding: "jsonParsed" })
    .send()
  let units = BigInt(0)
  const accounts: string[] = []
  for (const acc of res.value) {
    const info = acc.account.data.parsed.info as { tokenAmount?: { amount?: string } }
    units += BigInt(info.tokenAmount?.amount ?? "0")
    accounts.push(acc.pubkey)
  }
  return { units, accounts }
}

/**
 * JSON for a log line built from RPC data, which may carry BigInts.
 *
 * Plain `JSON.stringify` THROWS on a BigInt ("Do not know how to serialize a
 * BigInt"), and @solana/kit upcasts integers in RPC responses at runtime — so a
 * real simulation failure surfaced as an opaque TypeError from the error
 * FORMATTER and hid the cause it was trying to report. Invisible to typecheck:
 * the declared type of `err` carries no bigint (only `unitsConsumed` does), so
 * this only ever showed up against a live RPC.
 */
/** USDC 6dp base units → a human "12.34", for ops-facing log lines. */
const usdcStr = (units: bigint): string => (Number(units) / 1e6).toFixed(2)

const describeRpc = (v: unknown): string => {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)) ?? String(v)
  } catch {
    return String(v) // never let a diagnostic be the thing that fails
  }
}

/** Spend bound for the blind-signed funding tx: simulate it and require the
 *  funder's USDC delta to stay within the quoted price. Catches a wrong or
 *  hostile tx BEFORE the house signature exists. */
async function assertSpendWithinQuote(
  txB64: string,
  funderAddr: string,
  maxCents: number,
): Promise<void> {
  const pre = await funderUsdc(funderAddr)
  if (pre.accounts.length === 0)
    throw new Error(
      `gift funder ${funderAddr} holds no USDC at all (mint ${USDC_MINT}) — top it up`,
    )
  // Underfunded is THE common ops failure, and it used to reach the simulation
  // and come back as an opaque SPL "custom program error: 0x1" with no number
  // in it. Say what is held and what is needed.
  //
  // This sums every account the funder owns for the mint, so it cannot block a
  // transaction that would otherwise succeed (you can't spend what you don't
  // hold) — but it also can't prove success: a tx spending one SPECIFIC ATA can
  // still come up short while the total looks fine. The simulation below stays
  // the arbiter; this only buys a diagnosable message for the usual case.
  const needUnits = BigInt(maxCents) * BigInt(10_000)
  if (pre.units < needUnits)
    throw new Error(
      `gift funder ${funderAddr} holds ${usdcStr(pre.units)} USDC of the ` +
        `${usdcStr(needUnits)} needed (mint ${USDC_MINT}) — top it up`,
    )
  const sim = await rpc()
    .simulateTransaction(txB64 as Base64EncodedWireTransaction, {
      encoding: "base64",
      sigVerify: false,
      // We simulate ONLY to bound the spend, so the tx's own blockhash is
      // irrelevant here — and simulating against it fails outright once it has
      // aged out, turning a fine transaction into a refused grant. Replacing it
      // isolates this check to the thing it is actually asserting.
      // (Mutually exclusive with sigVerify, which is already false: the funder
      // has not signed at this point — that is the whole point of checking first.)
      replaceRecentBlockhash: true,
      accounts: { addresses: pre.accounts.map((a) => address(a)), encoding: "jsonParsed" },
    })
    .send()
  if (sim.value.err)
    // Diagnose with the LOGS, not just the error tag. A bare err like
    // {"InstructionError":[2,{"Custom":6001}]} says nothing actionable; the
    // program logs name the actual failure, and they only ever reach the server
    // (errorResponse hands the client a generic INTERNAL).
    throw new Error(
      `gift funding tx fails simulation: ${describeRpc(sim.value.err)}` +
        ` | funder ${funderAddr} holds ${usdcStr(pre.units)} USDC across ` +
        `${pre.accounts.length} account(s), tx priced at ${usdcStr(needUnits)}` +
        (sim.value.logs?.length ? ` | logs: ${sim.value.logs.slice(-6).join(" / ")}` : ""),
    )
  let post = BigInt(0)
  for (const acc of sim.value.accounts ?? []) {
    const parsed = (acc?.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } } | undefined)
      ?.parsed
    post += BigInt(parsed?.info?.tokenAmount?.amount ?? "0")
  }
  const spent = pre.units - post
  if (spent > BigInt(maxCents) * BigInt(10_000))
    throw new Error(
      `gift funding tx spends ${spent} USDC units, quoted ${maxCents} cents — refusing to sign`,
    )
}

/**
 * Reserve, verify, fund and submit a gift. `idempotencyKey` is the only
 * double-grant guard Slabz gives us — make it deterministic per grant reason
 * (the credit claim uses `credit:<row>:<attempt>`), never random.
 *
 * Failure contract for callers holding an entitlement: **a throw means no
 * money moved.** Every step before `giftSubmit` succeeds is either pure Slabz
 * bookkeeping or a local check, so an unfunded reserved gift is worth $0 and
 * the entitlement is safe to hand back for a retry. A return value means the
 * funding tx was submitted — consume the entitlement even when `status` is
 * not yet `confirmed`, because a resubmit could double-spend the funder.
 */
export async function grantGift(input: {
  packId: string
  receiverAddress: string
  count: number
  idempotencyKey: string
}): Promise<GrantedGift> {
  const { packId, receiverAddress, count, idempotencyKey } = input
  const funder = await signerFromEnv("GACHA_GIFT_FUNDER_SOLANA_KEY")
  // price sanity: what Slabz will charge must match its own catalog
  const pack = await getPack(packId)
  const expectedCents = pack.priceCents * count

  // Per-grant ceiling, checked BEFORE anything is reserved. The funder balance
  // caps the campaign, but nothing caps a SINGLE grant, and an entitlement caps
  // free PACKS rather than dollars — so a mistyped `'*'` credit row (any pack)
  // could redeem the priciest pack in the catalog and drain a whole campaign
  // budget on one click. $500 default: covers the admin route's own max (20 ×
  // $25 = $500) and any plausible credit row, refuses a $2,500 Pokemon 2500.
  // Blast-radius limiter for an ops typo, not a security boundary — raise it
  // deliberately for a high-value drop.
  const maxCents = Number(process.env.GACHA_GIFT_MAX_CENTS ?? 50_000)
  // a typo'd env must not silently remove the ceiling: NaN > x is false, which
  // would fail OPEN on the one guard whose whole job is bounding a spend
  if (!Number.isFinite(maxCents) || maxCents <= 0)
    throw new GachaError(
      "NOT_CONFIGURED",
      "GACHA_GIFT_MAX_CENTS must be a positive number of cents",
      503,
    )
  if (expectedCents > maxCents)
    throw new GachaError(
      "GIFT_TOO_LARGE",
      `gift would cost ${expectedCents}c, ceiling is ${maxCents}c (GACHA_GIFT_MAX_CENTS) — nothing reserved`,
      400,
    )

  const gift = await giftCreate({
    packId,
    senderAddress: funder.address,
    receiverAddress,
    count,
    idempotencyKey,
  })

  if (gift.priceCents !== expectedCents)
    throw new GachaError(
      "PRICE_MISMATCH",
      `Slabz wants ${gift.priceCents}c, catalog says ${expectedCents}c — nothing signed`,
      502,
    )

  // trust boundary: structural check + simulated spend bound, then sign
  const tx = getTransactionDecoder().decode(Buffer.from(gift.transaction, "base64"))
  verifyGiftFundingTx(tx, funder.address)
  await assertSpendWithinQuote(gift.transaction, funder.address, gift.priceCents)
  const signed = await partiallySignTransaction([funder.keyPair], tx)

  let status: string
  try {
    ;({ status } = await giftSubmit(gift.giftId, getBase64EncodedWireTransaction(signed)))
  } catch (e) {
    // ambiguous submit (502/504): the gift may still confirm — report the
    // live status instead of resubmitting blind (docs' rule)
    if (e instanceof SlabzError && e.status >= 500)
      status = (await giftGet(gift.giftId).catch(() => ({ status: "unknown" }))).status
    else throw e
  }

  return {
    giftId: gift.giftId,
    status,
    packId,
    packCount: gift.packCount,
    priceCents: gift.priceCents,
    receiverAddress,
  }
}
