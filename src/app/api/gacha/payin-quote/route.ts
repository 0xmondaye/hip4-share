// Sponsored Relay pay-in quote for a pack pull: user's HL USDC → user's own
// Solana wallet, charging pack price + markup with the markup clawed back as
// an appFee. The client executes the quote with the same machinery as
// withdrawals (executeWithdraw); nothing moves until the user signs.

import { NextResponse } from "next/server"
import { requireGachaAccess } from "@/lib/gacha-server/gate"
import { errorResponse, GachaError } from "@/lib/gacha-server/http"
import { payinQuote } from "@/lib/gacha-server/relay"
import * as slabz from "@/lib/gacha-server/slabz"

// JWKS fetch + Slabz getPack (retries) + Relay quote — over the 10s default
export const maxDuration = 60

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      packId?: string
      solAddress?: string
      hlAddress?: string
      count?: number
    }
    const { packId, solAddress, hlAddress } = body
    // bulk pulls fund count × pack total in one bridge. Client-supplied —
    // clamp hard so a forged count can't mint an unbounded quote.
    const count = body.count ?? 1
    if (!Number.isInteger(count) || count < 1 || count > 10)
      throw new GachaError("BAD_REQUEST", "count must be an integer 1-10")
    if (!packId || typeof packId !== "string")
      throw new GachaError("BAD_REQUEST", "packId required")
    if (!hlAddress || !/^0x[0-9a-fA-F]{40}$/.test(hlAddress))
      throw new GachaError("BAD_ADDRESS", "invalid HL address")
    if (!solAddress || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(solAddress))
      throw new GachaError("BAD_ADDRESS", "invalid Solana address")
    await requireGachaAccess(req)

    // fresh price, never the client's possibly hour-stale catalog snapshot —
    // the client must use this for display, coverPerpsFromSpot and the
    // skip-bridge threshold, or a Slabz reprice strands the delivered USDC
    const pack = await slabz.getPack(packId)
    if (!pack.isActive) throw new GachaError("PACK_INACTIVE", "pack unavailable")
    if (pack.priceCents < 500)
      throw new GachaError("BAD_PRICE", "pack price too small for markup math")

    // the markup math is linear, so a bulk quote is just the single-pack quote
    // scaled: same bps, and payinQuoteOk checks delivered/fee against ×count
    const { quote, totalCents } = await payinQuote({
      userHlAddr: hlAddress,
      userSolAddr: solAddress,
      priceCents: pack.priceCents * count,
      markupCents: pack.markupCents * count, // 0 outside the marked collection
    })
    return NextResponse.json({ quote, priceCents: pack.priceCents * count, totalCents })
  } catch (e) {
    return errorResponse(e)
  }
}
