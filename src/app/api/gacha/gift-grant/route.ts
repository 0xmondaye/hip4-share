import { NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "node:crypto"
import { grantGift } from "@/lib/gacha-server/gift"
import { GachaError } from "@/lib/gacha-server/http"
import { SlabzError } from "@/lib/slabz"

// Admin-only "free packs" grant: fund a Slabz gift from the house funder
// wallet so a chosen user can claim packs at no cost. No UI — curl it:
//
//   curl -X POST https://…/api/gacha/gift-grant \
//     -H "X-Admin-Key: $GACHA_GIFT_ADMIN_KEY" -H "Content-Type: application/json" \
//     -d '{"receiverAddress":"<solana addr>","packId":"<uuid>","count":1}'
//
// This is the ops escape hatch (one-off goodwill, a support ticket, a partner
// drop). The self-serve path is an entitlement row in gacha_credits redeemed
// through /api/gacha/credits — prefer that for anything with more than one
// recipient. Both share gacha-server/gift.ts, including the funder-balance
// budget cap documented there.

const UUID = /^[0-9a-fA-F-]{36}$/
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

function authorized(req: NextRequest): boolean {
  const key = process.env.GACHA_GIFT_ADMIN_KEY
  const got = req.headers.get("x-admin-key") ?? ""
  if (!key || !got) return false
  const a = Buffer.from(got)
  const b = Buffer.from(key)
  return a.length === b.length && timingSafeEqual(a, b)
}

const fail = (code: string, message: string, status: number) =>
  NextResponse.json({ success: false, error: { code, message } }, { status })

export async function POST(req: NextRequest) {
  if (!authorized(req)) return fail("UNAUTHORIZED", "bad or missing X-Admin-Key", 401)

  const body = (await req.json().catch(() => null)) as {
    receiverAddress?: string
    packId?: string
    count?: number
    idempotencyKey?: string
  } | null
  const receiverAddress = body?.receiverAddress ?? ""
  const packId = body?.packId ?? ""
  const count = body?.count ?? 1
  if (!UUID.test(packId)) return fail("BAD_REQUEST", "packId must be a UUID", 400)
  if (!BASE58.test(receiverAddress))
    return fail("BAD_REQUEST", "receiverAddress must be a Solana address", 400)
  if (!Number.isInteger(count) || count < 1 || count > 20)
    return fail("BAD_REQUEST", "count must be 1-20", 400)

  try {
    // default key blocks an accidental double-grant (same wallet+pack+count,
    // same day) from a retried curl; pass an explicit key to grant again
    const idempotencyKey =
      body?.idempotencyKey ??
      `gift:${receiverAddress}:${packId}:${count}:${new Date().toISOString().slice(0, 10)}`

    const gift = await grantGift({ packId, receiverAddress, count, idempotencyKey })

    return NextResponse.json({
      success: true,
      data: { ...gift, claimUrl: `/gacha/${packId}?gift=${gift.giftId}` },
    })
  } catch (e) {
    if (e instanceof SlabzError && e.code === "PARTNER_GIFT_IDEMPOTENCY_KEY_REUSED")
      return fail(
        e.code,
        "already granted today for this wallet+pack+count — pass a fresh idempotencyKey to grant again",
        409,
      )
    if (e instanceof GachaError) return fail(e.code, e.message, e.status)
    const code =
      e instanceof SlabzError ? e.code : (e as { code?: string })?.code ?? "GIFT_GRANT_FAILED"
    console.error("[gift-grant]", e)
    return fail(code, e instanceof Error ? e.message : String(e), 502)
  }
}
