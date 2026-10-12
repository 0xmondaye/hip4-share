// Server-side Slabz partner client — same API the client proxy fronts, but
// called directly with the key (the executor flow never goes through
// /api/gacha). Types come from the shared client module.
// ponytail: no shared-state rate limiter possible in serverless — we honor a
// single 429 Retry-After per call; ask Slabz for a limit raise before launch.

import { markedPack } from "@/lib/gacha-core"
import { SlabzError, NOT_CONFIGURED } from "@/lib/slabz"
import type {
  BuybackQuote,
  OpenRes,
  Pack,
  PurchaseRes,
  ShipEstimate,
  SlabzTx,
} from "@/lib/slabz"

const BASE =
  process.env.SLABZ_API_URL ?? "https://api-staging-3e2d.up.railway.app/api/partner/v1"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function slabz<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const key = process.env.SLABZ_API_KEY
  if (!key) throw new SlabzError(NOT_CONFIGURED, "SLABZ_API_KEY not set", 503)
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/${path}`, {
      method,
      headers: {
        "X-API-Key": key,
        ...(body != null ? { "Content-Type": "application/json" } : {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
    })
    if (res.status === 429 && attempt === 0) {
      await sleep(Number(res.headers.get("Retry-After") ?? 2) * 1000)
      continue
    }
    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean
      data?: T
      error?: { code?: string; message?: string }
    }
    if (!res.ok || json.success === false) {
      throw new SlabzError(
        json.error?.code ?? `HTTP_${res.status}`,
        json.error?.message ?? `Slabz request failed (${res.status})`,
        res.status,
      )
    }
    return json.data as T
  }
}

// markedPack here too: the charge side must see the same name and markup the
// client displayed (gacha-core is the single source for both)
export const getPack = (id: string) => slabz<Pack>("GET", `packs/${id}`).then(markedPack)
export const purchasePack = (packId: string, walletAddress: string, turbo = false) =>
  slabz<PurchaseRes>("POST", `packs/${packId}/purchase`, { walletAddress, turbo })
export const submitSigned = (txId: string, signedTransaction: string) =>
  slabz<{ transactionId: string; status: string; signature: string }>(
    "POST",
    `transactions/${txId}/submit`,
    { signedTransaction },
  )
export const openPack = (txId: string, walletAddress: string) =>
  slabz<OpenRes>("POST", `transactions/${txId}/open`, { walletAddress })
export const getTx = (txId: string) => slabz<SlabzTx>("GET", `transactions/${txId}`)

export const buybackQuote = (txId: string) =>
  slabz<BuybackQuote>("GET", `transactions/${txId}/buyback/quote`)
export const buybackInitiate = (txId: string, walletAddress: string) =>
  slabz<{ transactionId: string; buybackStatus: string; offerCents: number; transaction: string }>(
    "POST",
    `transactions/${txId}/buyback`,
    { walletAddress },
  )
export const buybackSubmit = (txId: string, signedTransaction: string) =>
  slabz<{ transactionId: string; status: string; signature: string }>(
    "POST",
    `transactions/${txId}/buyback/submit`,
    { signedTransaction },
  )
/** Shipping quote, read with OUR key. Slabz scopes the redeem session to
 *  (transaction, wallet); the browser proxy and this server client share one
 *  SLABZ_API_KEY against one SLABZ_API_URL, so the session the browser
 *  established by signing is visible here too. The API-key part of that scope
 *  is our ASSUMPTION — the docs don't state it — but the sharing works either
 *  way while both sides use the same key. This is the trust boundary for the
 *  funding bridge: the shipping cost comes from Slabz, never from the client. */
export const redeemEstimate = (txId: string, shippingAddressId: string) =>
  slabz<ShipEstimate>("POST", `transactions/${txId}/redeem/estimate`, {
    shippingAddressId,
  })

// ---- gifting (house-funded free packs) --------------------------------------
// Docs: https://api-docs.slabz.com/gifting/. Only the grant route calls these:
// create reserves packs and returns the unsigned funding tx, submit broadcasts
// the house-signed copy, get reconciles an ambiguous submit.

export type GiftCreateRes = {
  giftId: string
  transaction: string // base64 unsigned Solana tx, house funder pays
  packCount: number
  priceCents: number
}
export const giftCreate = (body: {
  packId: string
  senderAddress: string
  receiverAddress: string
  count: number
  idempotencyKey: string
}) => slabz<GiftCreateRes>("POST", "gifts", body)
export const giftSubmit = (giftId: string, signedTransaction: string) =>
  slabz<{ giftId: string; status: string; signature: string }>(
    "POST",
    `gifts/${giftId}/submit`,
    { signedTransaction },
  )
export const giftGet = (giftId: string) =>
  slabz<{ giftId: string; status: string; packCount: number; priceCents: number }>(
    "GET",
    `gifts/${giftId}`,
  )

// prod payload shape tolerant: field name differs between docs and staging
export const buybackStatus = async (txId: string): Promise<string> => {
  const r = await slabz<{ buybackStatus?: string; status?: string }>(
    "GET",
    `transactions/${txId}/buyback/status`,
  )
  return r.buybackStatus ?? r.status ?? "unknown"
}
