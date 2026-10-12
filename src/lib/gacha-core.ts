// Pure logic for the direct gacha flow (docs/SPEC-gacha-direct.md): the user's
// own Privy Solana wallet signs Slabz txs; house revenue is a flat markup on
// the pack price, collected as a Relay appFee on the pay-in bridge.
// No I/O here — everything is unit-tested in gacha-core.test.mjs.

// Single env read on both client (display) and server (charge) so the two
// can't drift. NEXT_PUBLIC_ is deliberate: the markup is visible price math.
export const MARKUP_CENTS = Number(process.env.NEXT_PUBLIC_GACHA_MARKUP_CENTS ?? 500)

// The one collection that carries the markup, renamed to the price the user
// actually pays ($25 pack + $5 → "Pokemon 30"). Every other pack sells at the
// Slabz price. ponytail: matched by name — swap to pack ids if Slabz renames.
const MARKED_NAMES = ["pokemon 25", "pokemon 30"]
const MARKED_AS = "Pokemon 30"

/** Data-level pack fixup, applied by both Slabz clients so display (client)
 *  and charge (server) can't drift: renames the marked collection and stamps
 *  its markup. Unmarked packs get 0 — they sell at the Slabz price. */
export function markedPack<P extends { name: string; priceCents: number }>(
  pack: P,
): P & { markupCents: number } {
  const marked = MARKED_NAMES.includes((pack.name ?? "").trim().toLowerCase())
  return {
    ...pack,
    name: marked ? MARKED_AS : pack.name,
    markupCents: marked ? MARKUP_CENTS : 0,
  }
}

/** What the user sees and pays: Slabz price + this pack's markup. Missing
 *  markup reads as 0 — under-charging is recoverable, over-charging isn't. */
export const displayCents = (pack: { priceCents: number; markupCents?: number }): number =>
  pack.priceCents + (pack.markupCents ?? 0)

/**
 * appFee bps that collects ~markup from the bridged total. Floored — the
 * rounding fraction goes to the user's delivered amount, never against the
 * pack price (delivered = total − fee ≥ price must always hold).
 */
export function markupBps(priceCents: number, markupCents = MARKUP_CENTS): number {
  const total = priceCents + markupCents
  if (total <= 0 || markupCents <= 0) return 0
  return Math.floor((markupCents / total) * 10_000)
}

/**
 * Fail-closed pay-in quote check. The fill must deliver the pack price into
 * the user's wallet — not less (the Slabz buy would fail AFTER the user's
 * money moved; a cap-hit quote once delivered 24.85 for a $25 pack), and not
 * the un-fee'd total (a dropped/ignored appFee silently gifts the markup to
 * the user). `receiveRaw` is the quote's destination amount in USDC 6dp base
 * units; `appFeeUsd` is the quote's fees.app.amountUsd.
 */
export function payinQuoteOk(input: {
  receiveRaw: string
  appFeeUsd: number
  priceCents: number
  markupCents?: number
}): boolean {
  if (!/^\d+$/.test(input.receiveRaw)) return false
  const markup = input.markupCents ?? MARKUP_CENTS
  const delivered = BigInt(input.receiveRaw)
  const price = BigInt(Math.floor(input.priceCents)) * BigInt(10_000)
  // floored bps under-collect by < 1¢; allow 5¢ slack for Relay's own rounding
  const eps = BigInt(5 * 10_000)
  if (delivered < price || delivered > price + eps) return false
  return Math.abs(input.appFeeUsd * 100 - markup) <= 5
}

// ---- pack-wallet sweep -----------------------------------------------------
// Resting USDC in the user's own Solana pack wallet (sellback proceeds, an
// interrupted pull) is swept home by RecoverBalance. These two live here
// because both the sweeper and the bridge read them, and they used to be three
// separate literals drifting against the payout-quote route's own floor.

/** Below this a bridge isn't worth a signature. MUST match MIN_UNITS6 in
 *  src/app/api/gacha/payout-quote/route.ts — the server refuses to mint a
 *  quote under it, so a client that offers to sweep less just errors. */
export const SWEEP_DUST_CENTS = 50
export const SWEEP_DUST_UNITS6 = BigInt(SWEEP_DUST_CENTS) * BigInt(10_000)

/**
 * What a payout poll that ran out its deadline actually means, given the
 * wallet's remaining USDC (6dp base units, or null when the balance couldn't
 * be read).
 *
 * "inflight" — the wallet drained, so the transfer LEFT. Read this as "not lost
 * yet", NOT as "guaranteed to arrive": Relay documents three outcomes, not two —
 * it fills, it refunds MINUS gas to the origin wallet (where the sweeper picks
 * it up), or, "if the refund amount is not enough to cover the cost of gas",
 * it marks the request failed and sends no refund at all. So the caller must
 * not report an inflight timeout as delivered.
 * "stuck" — the money never moved (or we can't tell), so surface it and retry.
 *
 * Fail-closed on null: an RPC hiccup must never be reported as a delivered
 * transfer. The cost of guessing "stuck" wrongly is one wasted re-quote, which
 * answers NOTHING_TO_BRIDGE; guessing "inflight" wrongly tells the user their
 * money is on its way when it is sitting still.
 */
export const payoutTimeoutVerdict = (leftUnits6: bigint | null): "inflight" | "stuck" =>
  leftUnits6 != null && leftUnits6 < SWEEP_DUST_UNITS6 ? "inflight" : "stuck"

// ---- buyback state reading -------------------------------------------------
// Slabz's buyback field naming drifts BY ENDPOINT and the docs never comment on
// it: initiate and GET buyback/status answer `buybackStatus`, while POST
// buyback/submit answers `status`. Both carry the same enum. Reading the wrong
// one silently yields "" and turns a completed sale into a poll — so the read
// lives here, once, with a test.

/** Case/whitespace-fold every status read through one place. The two readers
 *  used to disagree — `buybackDead` was case-insensitive while the sold check
 *  was exact-match, so a `"Completed"` payload read as neither sold nor dead
 *  and fell through to the "your payout is coming" branch on a sale that HAD
 *  completed. Normalise once instead of per-call-site. */
const normStatus = (s: string | null | undefined) => (s ?? "").trim().toLowerCase()

/**
 * Is the sale terminally DONE (NFT burned, USDC in the user's wallet)?
 *
 * "completed" is the ONLY terminal success state. `pending` and `failed` both
 * mean "not sold yet" per the docs, and `submitted` means a settlement is still
 * in flight — none of them may read as sold, because the UI commits to "sold"
 * on this answer and a false positive tells a user their card is gone when it
 * isn't.
 */
export const buybackSold = (
  res: { status?: string | null; buybackStatus?: string | null } | null | undefined,
): boolean => normStatus(res?.buybackStatus ?? res?.status) === "completed"

/**
 * Is this a terminal NOT-sold state? Matched by shape rather than one exact
 * string because the payloads drift. Deliberately does NOT match "submitted"
 * (settlement in flight) or "pending" (offer minted, awaiting signature) —
 * treating either as dead would abandon a sale that is still going through.
 */
export const buybackDead = (status: string | null | undefined): boolean =>
  /fail|reject|cancel|expire/i.test(status ?? "")

/**
 * Slabz says a settlement is genuinely IN FLIGHT. `submitted` is the ONLY such
 * state — the docs are explicit that "pending and failed" are both "not sold
 * yet" rather than a lock. This gates the "your payout is on its way" copy, so
 * reading `pending` as progress would promise money for a sale that never
 * happened (offer minted, signed tx never accepted).
 */
export const buybackInFlight = (status: string | null | undefined): boolean =>
  normStatus(status) === "submitted"

/**
 * Terminal not-sold AFTER a submit: either no buyback is recorded on the
 * transaction (`none`) or an offer is still sitting there awaiting a signed tx
 * (`pending`). Both mean our submit did not take effect.
 *
 * The caller must allow a brief read-after-write grace window before trusting
 * this — a just-accepted submit can read either for a moment. Kept separate
 * from `buybackDead`, which matches failure WORDING; these two are "nothing
 * happened", not "it failed".
 */
export const buybackNotSold = (status: string | null | undefined): boolean =>
  ["none", "pending"].includes(normStatus(status))

// ---- redeem session -------------------------------------------------------

/** Slabz's 14-minute redeem session lapsed and must be re-opened. */
export const REDEEM_SESSION_GONE = "PARTNER_REDEEM_SESSION_REQUIRED"

/**
 * Should a redeem call be retried against a fresh session?
 *
 * Keyed on the CODE and never on status 401. Our own Privy gate also answers
 * 401 — with code `UNAUTHORIZED` — and that has to stay the re-login path:
 * silently re-signing a redeem session in response to it would paper over an
 * expired login and retry into the same 401 forever.
 */
export const isRedeemSessionGone = (
  e: { code?: string | null; status?: number } | null | undefined,
): boolean => e?.code === REDEEM_SESSION_GONE

/**
 * Prepare a new shipment, resume the existing one, or neither.
 *
 * `redeem/prepare` is what creates and prices a shipment, so calling it twice
 * for one card risks a second charge. When a previous attempt already prepared
 * but the burn never landed (`pending_burn`), the documented retry is
 * `redeem/resume`: same shipmentId, fresh blockhash.
 *
 * Anything further along — processing/shipped/delivered — means the card is
 * already gone. `failed` and `cancelled` land here too, deliberately: resume
 * rejects a cancelled shipment (PARTNER_REDEEM_RESUME_REJECTED) and we can't
 * tell from the status alone whether the user was charged, so we show them the
 * shipment rather than guessing and burning a second time.
 */
export const redeemStep = (
  s: { redeemStatus?: string } | null | undefined,
): "prepare" | "resume" | "existing" =>
  s == null || !s.redeemStatus || s.redeemStatus === "none"
    ? "prepare"
    : s.redeemStatus === "pending_burn"
      ? "resume"
      : "existing"

/**
 * A shipment's own price in cents, or null when it can't be trusted.
 *
 * Slabz sends `totalCost` as a dollars string. Resuming a shipment makes it
 * the ceiling `shipRedeem` checks the resumed price against, and that check is
 * `prepCents > ceiling` — `NaN > n` is FALSE, so an unreadable price would
 * wave every burn through. Null means the caller must not offer the burn.
 */
export const shipmentCents = (totalCost: string | undefined): number | null => {
  const n = Number(totalCost)
  return Number.isFinite(n) && n > 0 ? Math.ceil(n * 100) : null
}

// ---- free-pack credits -----------------------------------------------------
// An entitlement to open a pack for free, house-funded (gacha_credits +
// gacha-server/credits.ts). Shape is shared so the banner, the pack page and
// the claim route all read the same fields.

export type FreeCredit = {
  id: number
  /** pack this credit is good for — the marked display name, or "*" for any */
  packName: string
  /** free opens this row is worth */
  packs: number
  /** why it was granted: "beta-2026-08", "referral:<did>", "goodwill:<id>" */
  reason: string
}

/**
 * Does a credit apply to this pack? `*` is any pack; otherwise the marked
 * display name must match, case-insensitively. Deliberately NOT family
 * matching (`packFamily`) — a "Pokemon 30" credit must not open a
 * "Pokemon 2500" pack, which is the same family and 80× the cost.
 *
 * MUST stay in lockstep with the SQL predicate in gacha-server/credits.ts —
 * this one only filters what's displayed, that one decides what's spent.
 */
export const creditMatches = (credit: { packName: string }, packName: string): boolean =>
  credit.packName.trim() === "*" ||
  credit.packName.trim().toLowerCase() === packName.trim().toLowerCase()

/**
 * Does this pull cost the user anything? Both entitlement peeks (gift deep
 * link, credit ledger) are async, so `undefined` means NOT KNOWN YET and is
 * distinct from `null` ("none"). Until both have landed the answer is
 * `unknown` and the CTA must claim neither "Free" nor a price: promising free
 * openings nobody has is the confusing half, and a paid click on a free pack
 * spends real USDC on something the user already owned.
 */
export const freeState = (
  gift: { packsRemaining: number } | null | undefined,
  credit: { packs: number } | null | undefined,
) => {
  const giftLeft = gift?.packsRemaining ?? 0
  const free = giftLeft > 0 || !!credit
  const unknown = gift === undefined || credit === undefined
  return {
    free,
    unknown,
    packsLeft: giftLeft > 0 ? giftLeft : (credit?.packs ?? 0),
    // paid controls (price, qty stepper, card checkout) — hidden while unknown
    showPaid: !free && !unknown,
  }
}

/**
 * Verified emails from a Privy identity token's `linked_accounts` claim (a
 * JSON-encoded array). Email logins carry `address`; OAuth logins (Google,
 * Apple) carry `email`. Lowercased for matching; garbage yields [].
 */
export function emailsFromLinkedAccounts(raw: string): string[] {
  try {
    const accounts = JSON.parse(raw) as { type?: string; address?: string; email?: string }[]
    return accounts
      .map((a) => (a.type === "email" ? a.address : a.email))
      .filter((e): e is string => typeof e === "string" && e.includes("@"))
      .map((e) => e.toLowerCase())
  } catch {
    return []
  }
}

/**
 * Verified wallet addresses from the same claim — the only handle we have on a
 * wallet-only signup (no email, no OAuth), so it is what the allowlist and the
 * credits ledger key on for those users. Linking a wallet in Privy costs a
 * signature from its private key, so this is as forge-proof as the email list.
 *
 * Lowercased like the emails, because every match runs through `lower()` on
 * both sides — an EIP-55 checksum address and the same address pasted flat by
 * a user have to land on one key. That also folds Solana base58 case, which is
 * lossy for an *address* but fine for a *lookup key*: nothing here is ever
 * used as a transfer destination, only compared.
 */
export function walletsFromLinkedAccounts(raw: string): string[] {
  try {
    const accounts = JSON.parse(raw) as { type?: string; address?: string }[]
    return accounts
      .filter((a) => a.type === "wallet")
      .map((a) => a.address)
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .map((s) => s.toLowerCase())
  } catch {
    return []
  }
}

// ---- pull journal ----------------------------------------------------------
// Money steps are resumable: the client persists progress (localStorage) and
// on every pull start resolves what to do next from the journal instead of
// restarting. Signatures are the commit points — everything before one can
// re-run; everything after is tracked by an id and polled to completion.

export type PullJournal = {
  packId: string
  /** fresh Slabz price at quote time — the skip-bridge funding threshold.
   *  For a bulk pull this is the whole batch's total, not per pack. */
  priceCents: number
  /** packs in this pull (bulk); missing = 1 (journals predate bulk) */
  count?: number
  /** set once a Relay pay-in quote was handed to the wallet for signing */
  payinRequestId?: string
  checkEndpoint?: string
  /** Idempotency key for this journal's SINGLE purchase, written BEFORE the
   *  call. A create response lost in transit (504, socket drop) is otherwise
   *  unrecoverable: the retry mints a SECOND pack and charges again. Replaying
   *  the same key makes Slabz answer with the original transaction instead. */
  purchaseKey?: string
  /** set once Slabz minted the purchase — the charge is committed */
  slabzTxId?: string
  /** bulk pull: every tx of the batch — the whole batch is committed at once */
  bulkTxIds?: string[]
  ts: number
}

export type PullResume =
  /** no usable journal — quote and bridge from scratch */
  | { kind: "fresh" }
  /** a pay-in may be in flight — poll `checkEndpoint`; success ⇒ purchase,
   *  failure/refund ⇒ fresh, pending ⇒ keep waiting. NEVER mint a second
   *  quote while this resolves (double-$30). */
  | { kind: "await_fill"; checkEndpoint: string }
  /** purchase tx already minted — resume at submit/open, never re-purchase */
  | { kind: "open"; slabzTxId: string }
  /** bulk batch already minted — open every tx, never re-purchase */
  | { kind: "open_bulk"; slabzTxIds: string[] }

/** Resolve the next pull action from a journal. Pure — the caller does the
 *  polling and clears the journal on reveal or terminal failure. */
export function nextPullAction(j: PullJournal | null | undefined, packId: string): PullResume {
  if (!j || j.packId !== packId) return { kind: "fresh" }
  if (j.bulkTxIds?.length) return { kind: "open_bulk", slabzTxIds: j.bulkTxIds }
  if (j.slabzTxId) return { kind: "open", slabzTxId: j.slabzTxId }
  if (j.payinRequestId && j.checkEndpoint)
    return { kind: "await_fill", checkEndpoint: j.checkEndpoint }
  return { kind: "fresh" }
}

// ---- slab tells for the grading reveal -------------------------------------
// Slabz ships no year/grade/category fields, only a ~32-char `name` that leads
// with the year and usually carries the grade ("2003 #H32 Xatu-Holo PSA 9
// Skyrid"). ponytail: parse what's there; promote to real fields if Slabz ships
// them. Anything unparseable returns null and its reveal row collapses out —
// never guess a grade.

export const cardYear = (name: string): string | null =>
  name.match(/\b(?:19|20)\d{2}\b/)?.[0] ?? null

/** "PSA 9" / "CGC 9.5" — grader + number. Often truncated off the name. */
export function cardGrade(name: string): string | null {
  const m = name.match(/\b(PSA|BGS|CGC|SGC|TAG|ACE)\s*(\d+(?:\.\d+)?)\b/i)
  return m ? `${m[1].toUpperCase()} ${m[2]}` : null
}

/** Category from ccPackType ("pokemon_25" → "Pokémon"). Only pokemon is in the
 *  catalog today; extend as new categories sync. */
const CATEGORY_BY_PREFIX: Record<string, string> = { pokemon: "Pokémon" }
export const packCategory = (ccPackType: string | undefined | null): string | null =>
  CATEGORY_BY_PREFIX[ccPackType?.split("_")[0]?.toLowerCase() ?? ""] ?? null

/** Storefront visibility: catalog packs the pickers hide even while Slabz has
 *  them active. ponytail: anime pulled temporarily (2026-08-30) — delete the
 *  entry to re-enable. */
export const packHidden = (p: { ccPackType: string }): boolean =>
  p.ccPackType.split("_")[0] === "anime"

/** Family key for grouping tier variants of the same product line:
 *  "Pokemon 30" / "Pokemon 2500" → "Pokemon"; "Pokemon Sealed" stays its own
 *  family. ponytail: trailing-number heuristic on the name — Slabz has no
 *  family field; revisit if they ever name a pack ending in a real number. */
export const packFamily = (name: string): string =>
  name.replace(/\s+[\d,]+$/, "").trim() || name

/** Tier variants of one product line ("Pokemon 30/50/…") grouped for the
 *  storefront, phygitals-style. Families keep the catalog's order of first
 *  appearance; packs within a family sort cheap → priciest. */
export function groupByFamily<P extends { name: string; priceCents: number; markupCents?: number }>(
  packs: P[],
): P[][] {
  const m = new Map<string, P[]>()
  for (const p of packs) {
    const f = packFamily(p.name)
    m.set(f, [...(m.get(f) ?? []), p])
  }
  return [...m.values()].map((ps) => ps.sort((a, b) => displayCents(a) - displayCents(b)))
}

/** Rarity → text color class, shared by every gacha surface so a tier reads
 *  the same on the pack page, the reveal, and the collection. Legendary gets
 *  cac's UR rainbow (.text-rainbow in globals.css), matching the reveal. */
const RARITY_TEXT: Record<string, string> = {
  legendary: "text-rainbow",
  epic: "text-violet-400",
  rare: "text-sky-400",
  common: "text-muted-foreground",
  // the Cellar's ladder (wine-shelf WINE_TIERS), same five rungs
  "grand prize": "text-rainbow",
  icon: "text-violet-400",
  reserve: "text-sky-400",
  cellar: "text-emerald-400",
  entry: "text-muted-foreground",
}
export const rarityText = (r: string): string =>
  RARITY_TEXT[r.toLowerCase()] ?? "text-muted-foreground"

/** Cards from Slabz pull history whose NFT is still in the wallet: completed,
 *  not auto-sold, mint present on-chain. Deduped by mint (Slabz history can
 *  repeat a tx across pages). Each card keeps its `transactionId` — every
 *  redeem/buyback endpoint is addressed by transaction, not by mint — and its
 *  `createdAt`, which feeds the sell-back countdown. */
export function heldCards<C extends { nftMint: string; autoSold: boolean }>(
  txs: {
    transactionId?: string
    status: string
    createdAt?: string
    card?: C | Record<string, never>
  }[],
  ownedMints: ReadonlySet<string>,
): (C & { transactionId: string; createdAt?: string })[] {
  const seen = new Set<string>()
  const out: (C & { transactionId: string; createdAt?: string })[] = []
  for (const t of txs) {
    if (t.status !== "completed") continue
    // `in` doesn't narrow Record<string, never> — cast after the shape check
    const c = t.card && "nftMint" in t.card ? (t.card as C) : null
    if (!c || c.autoSold) continue
    if (!ownedMints.has(c.nftMint) || seen.has(c.nftMint)) continue
    seen.add(c.nftMint)
    out.push({ ...c, transactionId: t.transactionId ?? "", createdAt: t.createdAt })
  }
  return out
}

// ---- sell-back window --------------------------------------------------------
// Slabz buybacks close 72h after the pull. The countdown is advisory — the tx
// `createdAt` is the purchase time, not the open time, and buybackQuote stays
// the oracle (an "expired" card still shows its real quote state). Never hide
// the Sell button on this number alone.

export const SELLBACK_WINDOW_H = 72

/** Whole hours left in the sell-back window, floored at 0 once passed.
 *  null when the timestamp is missing/garbage — show nothing, not a guess. */
export function sellbackHoursLeft(
  createdAt: string | undefined,
  now: number = Date.now(),
): number | null {
  const t = Date.parse(createdAt ?? "")
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.ceil((t + SELLBACK_WINDOW_H * 3_600_000 - now) / 3_600_000))
}

/**
 * The other half of a pull history: cards that were opened but are no longer
 * in the wallet — sold back (the slab goes to Slabz), auto-sold, or shipped.
 * `heldCards` + this = everything the user ever pulled, which is why the shop
 * carries no separate ledger: the collection page is the whole history.
 *
 * Built by subtracting the held set rather than re-deriving ownership, so the
 * two lists can never both claim (or both drop) the same mint.
 */
export function pastCards<C extends { nftMint: string; autoSold: boolean }>(
  txs: {
    transactionId?: string
    status: string
    createdAt?: string
    card?: C | Record<string, never>
  }[],
  ownedMints: ReadonlySet<string>,
): (C & { transactionId: string; createdAt?: string })[] {
  const held = new Set(heldCards(txs, ownedMints).map((c) => c.nftMint))
  const seen = new Set<string>()
  const out: (C & { transactionId: string; createdAt?: string })[] = []
  for (const t of txs) {
    if (t.status !== "completed") continue
    const c = t.card && "nftMint" in t.card ? (t.card as C) : null
    if (!c || held.has(c.nftMint) || seen.has(c.nftMint)) continue
    seen.add(c.nftMint)
    out.push({ ...c, transactionId: t.transactionId ?? "", createdAt: t.createdAt })
  }
  return out
}
