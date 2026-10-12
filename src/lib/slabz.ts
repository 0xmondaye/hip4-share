// Typed client for the Slabz partner API, via our /api/gacha proxy (key
// stays server-side). Docs: https://api-docs.slabz.com

import { markedPack } from "./gacha-core"
import { privyAuthHeaders } from "./privy-tokens"

export type PackOdds = {
  tier: string
  probability: number
  minValueCents: number
  maxValueCents: number | null
}

export type Pack = {
  id: string
  name: string
  description: string
  imageUrl: string
  priceCents: number
  /** house markup, stamped by markedPack — not a Slabz field */
  markupCents: number
  ccPackType: string
  isActive: boolean
  evCents: number | null
  odds: PackOdds[]
}

export type PackCard = {
  nftId: string
  name: string
  rarity: string
  insuredValueCents: number
  imageUrl: string
}

export type OpenedCard = {
  nftMint: string
  name: string
  rarity: string
  insuredValueCents: number
  imageUrl?: string | null
  autoSold: boolean
  autoSoldCents: number | null
}

export type PurchaseRes = {
  transactionId: string
  transaction: string // base64 unsigned Solana tx
  priceCents: number
}

export type OpenRes =
  | { status: "completed"; transactionId: string; card: OpenedCard }
  | { status: "opening"; transactionId: string; retryAfterMs: number }

export type BuybackQuote = {
  transactionId: string
  available: boolean
  offerCents: number
}

export type SlabzTx = {
  transactionId: string
  status: "created" | "confirmed" | "opening" | "completed" | "failed" | "expired"
  packId: string
  walletAddress: string
  priceCents: number
  card?: OpenedCard | Record<string, never>
  createdAt: string
}

export class SlabzError extends Error {
  code: string
  status: number
  /** Raw `error.details` from Slabz. Only `PARTNER_IDEMPOTENCY_KEY_REUSED`
   *  carries the original id (`details.transactionId`); `*_IN_PROGRESS` and
   *  `*_KEY_MISMATCH` carry none, so don't look for one there. Typed unknown so
   *  each reader narrows what it actually needs. */
  details?: unknown
  /** Seconds to wait, from the response's `Retry-After` header. Slabz documents
   *  a real value on every 429; the retry loops used to back off on a hardcoded
   *  guess and ignore it. undefined when absent. */
  retryAfterMs?: number
  constructor(
    code: string,
    message: string,
    status: number,
    details?: unknown,
    retryAfterMs?: number,
  ) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
    this.retryAfterMs = retryAfterMs
  }
}

export const NOT_CONFIGURED = "NOT_CONFIGURED"

// POSTs and transaction reads are gated server-side (auth + allowlist) — the
// Privy tokens ride along when we're in a browser session. Shared cache: a
// pack page fires five of these in parallel and asking Privy five times over
// is what trips its rate limit. privy-tokens.ts also owns the SSR guard, so
// @privy-io/react-auth is never pulled into the server bundle.

/** `Retry-After` in ms. Slabz sends whole seconds; a malformed value reads as
 *  absent so the caller keeps its own backoff rather than sleeping on NaN. */
function retryAfterMs(res: Response): number | undefined {
  const secs = Number(res.headers.get("Retry-After"))
  return Number.isFinite(secs) && secs > 0 ? Math.min(secs, 60) * 1000 : undefined
}

async function api<T>(method: "GET" | "POST", path: string, body?: unknown, retried = false): Promise<T> {
  const res = await fetch(`/api/gacha/${path}`, {
    method,
    headers: {
      // gate.ts matches the allowlist on emails inside the identity token
      ...(await privyAuthHeaders(retried)),
      ...(body != null ? { "Content-Type": "application/json" } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  })
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean
    data?: T
    error?: { code?: string; message?: string; details?: unknown }
  }
  // 202 = accepted-but-not-done (a pack still minting). The documented body is a
  // plain SUCCESS envelope — {success:true, data:{transactionId, status:"opening",
  // retryAfterMs}} with NO error object; `PARTNER_OPEN_PENDING` exists only as a
  // row in the errors table and never appears in a body, so never gate on it.
  // Short-circuited here anyway rather than trusting `success` to be true: this
  // is the ONE non-terminal response the pull flow depends on, and if that
  // envelope ever said success:false the gate below would turn a normal mint
  // into a dead pull.
  if (res.status === 202 && json.data != null) return json.data as T
  if (!res.ok || json.success === false) {
    // One silent retry on 401, forcing a fresh token lookup past the cache:
    // Privy reissues the identity token alongside the access token. Covers
    // sessions whose stored identity token went stale mid-page.
    //
    // Only for OUR 401s. A `PARTNER_*` code means Slabz rejected it, not Privy —
    // notably PARTNER_REDEEM_SESSION_REQUIRED, where refreshing a Privy token
    // changes nothing and this blindly replays the POST. Prepare's idempotency
    // is undocumented, so a blind replay there is exactly the risk this codebase
    // avoids elsewhere; the redeem session retry lives in gacha-bridge instead.
    // Our own gate answers code UNAUTHORIZED, so the Privy path is unaffected.
    const upstreamCode = json.error?.code?.startsWith("PARTNER_") ?? false
    if (res.status === 401 && !retried && !upstreamCode && typeof window !== "undefined") {
      return api<T>(method, path, body, true)
    }
    throw new SlabzError(
      json.error?.code ?? `HTTP_${res.status}`,
      json.error?.message ?? `Request failed (${res.status})`,
      res.status,
      json.error?.details,
      retryAfterMs(res),
    )
  }
  return json.data as T
}

// Docs say probability is a 0–1 fraction; production returns whole percents
// (75/20/4/1) and some packs omit odds entirely. Normalize to percent and
// always hand the UI an array.
function normalizeOdds(pack: Pack): Pack {
  const odds = pack.odds ?? []
  const sum = odds.reduce((a, o) => a + o.probability, 0)
  return markedPack({
    ...pack,
    odds:
      sum > 0 && sum <= 1.5
        ? odds.map((o) => ({ ...o, probability: o.probability * 100 }))
        : odds,
  })
}

export const listPacks = () =>
  api<Pack[]>("GET", "packs").then((ps) => ps.map(normalizeOdds))
export const getPack = (id: string) =>
  api<Pack>("GET", `packs/${id}`).then(normalizeOdds)
// Slabz sorts value-desc and caps limit at 100, so an unfiltered fetch on a
// deep pool returns legendaries only — pass rarity to sample other tiers
export const getPackCards = (id: string, limit = 100, rarity?: string) =>
  api<PackCard[]>(
    "GET",
    `packs/${id}/cards?limit=${limit}${rarity ? `&rarity=${rarity}` : ""}`,
  )

/** `idempotencyKey` (8-255 chars) is optional to the API but the CALLER should
 *  always pass one and persist it first — see PullJournal.purchaseKey. */
export const purchasePack = (
  packId: string,
  walletAddress: string,
  turbo = false,
  idempotencyKey?: string,
) =>
  api<PurchaseRes>("POST", `packs/${packId}/purchase`, {
    walletAddress,
    turbo,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  })

/** Bulk purchase (docs: /bulk-purchase): one call reserves `count` packs and
 *  returns one unsigned tx per pack. `packCount` can come back short of
 *  `requestedCount` when stock runs out — the batch charges totalPriceCents,
 *  never the requested amount. Each tx embeds a ~60–90s blockhash: sign and
 *  submit promptly. */
export type BulkPurchaseRes = {
  bulkId: string
  packCount: number
  requestedCount: number
  packPriceCents: number
  totalPriceCents: number
  transactions: PurchaseRes[]
}
export const bulkPurchasePacks = (
  packId: string,
  walletAddress: string,
  count: number,
  idempotencyKey: string,
  turbo = false,
) =>
  api<BulkPurchaseRes>("POST", `packs/${packId}/bulk-purchase`, {
    walletAddress,
    count,
    turbo,
    idempotencyKey,
  })
export const submitSigned = (txId: string, signedTransaction: string) =>
  api<{ transactionId: string; status: string; signature: string }>(
    "POST",
    `transactions/${txId}/submit`,
    { signedTransaction },
  )
export const openPack = (txId: string, walletAddress: string) =>
  api<OpenRes>("POST", `transactions/${txId}/open`, { walletAddress })

export const getTransaction = (txId: string) =>
  api<SlabzTx>("GET", `transactions/${txId}`)

export const buybackQuote = (txId: string) =>
  api<BuybackQuote>("GET", `transactions/${txId}/buyback/quote`)

/** Buyback progress — tolerates Slabz's buybackStatus/status payload drift. */
export const buybackStatus = (txId: string) =>
  api<{ buybackStatus?: string; status?: string }>(
    "GET",
    `transactions/${txId}/buyback/status`,
  ).then((r) => r.buybackStatus ?? r.status ?? "")

/** Cents paid if this tx's card was sold back, else null. The tx object
 *  itself never reflects a buyback (verified against prod) — only this
 *  endpoint knows. */
export const buybackSoldCents = (txId: string) =>
  api<{ buybackStatus?: string; status?: string; offerCents?: number | null }>(
    "GET",
    `transactions/${txId}/buyback/status`,
  )
    .then((r) =>
      (r.buybackStatus ?? r.status) === "completed" ? (r.offerCents ?? 0) : null,
    )
    .catch(() => null)
export const buybackInitiate = (txId: string, walletAddress: string) =>
  api<{ transactionId: string; buybackStatus: string; offerCents: number; transaction: string }>(
    "POST",
    `transactions/${txId}/buyback`,
    { walletAddress },
  )
export const buybackSubmit = (txId: string, signedTransaction: string) =>
  api<{ transactionId: string; status: string; signature: string }>(
    "POST",
    `transactions/${txId}/buyback/submit`,
    { signedTransaction },
  )

// ---- redeem (ship the physical slab) ---------------------------------------
// Docs: https://api-docs.slabz.com/redeem. Session model: POST redeem/auth →
// sign the returned message (ed25519, base58) → POST auth/verify. The nonce is
// good for 5 min and the session for 14, both held by Slabz against OUR API
// key — so the server-side client (gacha-server/slabz.ts) shares the session
// the browser established.

export type ShipAddress = {
  name: string
  line1: string
  line2?: string
  city: string
  state: string
  postalCode: string
  /** Full English country name, e.g. "United States" — the docs' example body
   *  is "United States of America"; an ISO code 502s the estimate */
  country: string
  phoneNumber?: string
  email: string
}

/** Shipping quote. All amounts are USD (dollars, not cents — unlike the rest
 *  of the partner API). */
export type ShipEstimate = {
  price: number
  insurancePrice: number
  feesPrice: number
  shippingPrice: number
  total: number
  numberOfCards: number
  breakdown?: {
    region?: string
    declaredValue?: number
    lines?: { code: string; label: string; amount: number }[]
    notes?: string[]
  }
}

export type RedeemStatus = {
  shipmentId: string
  /** the courier's own label — free-form, display only */
  status: string
  redeemStatus:
    | "pending_burn"
    | "processing"
    | "shipped"
    | "delivered"
    | "failed"
    | "cancelled"
  /** Slabz's own order reference — the number to quote at their support */
  customId?: string
  deliveryCompany?: string
  trackingIds?: string[]
  trackingUrls?: string[]
  totalCost?: string
  shippingCost?: string
  insuranceCost?: string
  feesCost?: string
  createdAt?: string
  updatedAt?: string
}

const redeem = (txId: string, leg: string) => `transactions/${txId}/redeem/${leg}`

export const redeemAuth = (txId: string, walletAddress: string) =>
  api<{ messageToSign: string; nonce: string }>("POST", redeem(txId, "auth"), {
    walletAddress,
  })
export const redeemVerify = (txId: string, walletAddress: string, signature: string) =>
  api<{ success: boolean }>("POST", redeem(txId, "auth/verify"), {
    walletAddress,
    signature,
  })
export const redeemAddAddress = (txId: string, address: ShipAddress) =>
  api<{ id: string }>("POST", redeem(txId, "addresses"), address)
export const redeemEstimate = (txId: string, shippingAddressId: string) =>
  api<ShipEstimate>("POST", redeem(txId, "estimate"), { shippingAddressId })
/** Creates the shipment and returns its burn transactions. No `insurance`
 *  field — Slabz applies it automatically above $5,000 of declared value. */
export type RedeemPrepareRes = {
  shipmentId: string
  transactions: string[]
  totalCost: number
}
export const redeemPrepare = (
  txId: string,
  shippingAddressId: string,
  opts: { email?: string; comment?: string } = {},
) =>
  api<RedeemPrepareRes>("POST", redeem(txId, "prepare"), {
    shippingAddressId,
    coin: "USDC",
    ...opts,
  })

/** Rebuild the SAME shipment's burn transactions with a fresh blockhash. The
 *  prepared ones carry a ~60-90s blockhash, so an attempt that stalled between
 *  prepare and burn must come back through here — a second `prepare` would
 *  risk a second charge for one shipment. Takes no body. */
export const redeemResume = (txId: string) =>
  api<RedeemPrepareRes>("POST", redeem(txId, "resume"))
export const redeemBurn = (
  txId: string,
  signedTransactions: string[],
  shipmentId: string,
) =>
  api<{ shipmentId: string; status: string; transactionUrls: string[] }>(
    "POST",
    redeem(txId, "burn"),
    { signedTransactions, shipmentId },
  )
/** Live shipment, or null when this card was never redeemed (Slabz answers
 *  NOT_FOUND / PARTNER_REDEEM_NOT_PREPARED — both mean "nothing shipped"). */
export const redeemStatus = (txId: string): Promise<RedeemStatus | null> =>
  api<RedeemStatus>("GET", redeem(txId, "status")).catch((e) => {
    if (
      e instanceof SlabzError &&
      (e.status === 404 || e.code === "PARTNER_REDEEM_NOT_PREPARED")
    )
      return null
    throw e
  })

// ---- gifting (free packs) ---------------------------------------------------
// Docs: https://api-docs.slabz.com/gifting/. Granting is server-side only
// (/api/gacha/gift-grant, house-funded) — the browser lists and claims. A
// completed claim yields a standard transactionId; open/reveal/buyback/redeem
// all work on it unchanged.

export type Gift = {
  giftId: string
  status: "created" | "confirmed" | "completed" | "failed" | "expired"
  packId: string
  senderAddress: string
  receiverAddress: string
  packCount: number
  packsClaimed: number
  packsRemaining: number
  priceCents: number
  createdAt: string
}

export const listGifts = (receiverAddress: string) =>
  api<Gift[]>("GET", `gifts?receiver_address=${encodeURIComponent(receiverAddress)}`)
export const getGift = (giftId: string) => api<Gift>("GET", `gifts/${giftId}`)
export const giftClaimInit = (giftId: string, walletAddress: string) =>
  api<{ messageToSign: string; nonce: string; packsRemaining: number }>(
    "POST",
    `gifts/${giftId}/claim/init`,
    { walletAddress },
  )
export const giftClaimComplete = (
  giftId: string,
  body: {
    walletAddress: string
    nonce: string
    signedMessage: string
    signature: string // base58, like the redeem session
    turbo?: boolean
  },
) =>
  api<{
    transactionId: string
    status: string
    packsClaimed: number
    packsRemaining: number
  }>("POST", `gifts/${giftId}/claim/complete`, body)

export const listTransactions = (walletAddress: string, limit = 20) =>
  api<SlabzTx[]>(
    "GET",
    `transactions?wallet_address=${encodeURIComponent(walletAddress)}&limit=${limit}`,
  )

// base64 ⇄ bytes for Solana tx signing (browser-safe, no Buffer)
export const b64ToBytes = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
export const bytesToB64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))

export const usd = (cents: number): string =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })

// whole dollars for ranges and caps — "$50,000" where "$50,000.00" wraps
export const usdWhole = (cents: number): string =>
  `$${Math.round(cents / 100).toLocaleString("en-US")}`
