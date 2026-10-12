// Server-signed Coinflow checkout parameters for a card-funded pack pull.
// The JWT pins subtotal (bare Slabz price → delivered as USDC to the user's
// pack wallet) and the markup as a customPayInFee (settles to our Coinflow
// merchant balance) — signed server-side so a client can neither strip the
// fee nor reprice the pull. Same trust boundary as the Relay pay-in quote.

import { NextResponse } from "next/server"
import { requireGachaAccess } from "@/lib/gacha-server/gate"
import { errorResponse, GachaError } from "@/lib/gacha-server/http"
import * as slabz from "@/lib/gacha-server/slabz"
import { cardCart, COINFLOW_API, coinflowEnabled } from "@/lib/coinflow-core"

// JWKS fetch + Slabz getPack (retries) + Coinflow round trip — over the 10s default
export const maxDuration = 60

export async function POST(req: Request) {
  try {
    const apiKey = process.env.COINFLOW_API_KEY ?? ""
    if (!coinflowEnabled || !apiKey)
      throw new GachaError("NOT_CONFIGURED", "card checkout is not configured", 503)

    const body = (await req.json().catch(() => ({}))) as {
      packId?: string
      solAddress?: string
      count?: number
    }
    const { packId, solAddress } = body
    const count = body.count ?? 1
    if (!Number.isInteger(count) || count < 1 || count > 10)
      throw new GachaError("BAD_REQUEST", "count must be an integer 1-10")
    if (!packId || typeof packId !== "string")
      throw new GachaError("BAD_REQUEST", "packId required")
    if (!solAddress || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(solAddress))
      throw new GachaError("BAD_ADDRESS", "invalid Solana address")
    await requireGachaAccess(req)

    // fresh price, never the client's possibly hour-stale catalog snapshot
    const pack = await slabz.getPack(packId)
    if (!pack.isActive) throw new GachaError("PACK_INACTIVE", "pack unavailable")
    const cart = cardCart(pack, count)

    const res = await fetch(`${COINFLOW_API}/checkout/jwt-token`, {
      method: "POST",
      headers: { Authorization: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        blockchain: "solana",
        subtotal: { cents: cart.subtotalCents, currency: "USD" },
        ...(cart.feeCents > 0 && {
          customPayInFees: [
            {
              lineItemLabel: "Service fee",
              fee: { isFixed: true, cents: cart.feeCents, currency: "USD", percent: null },
            },
          ],
        }),
        chargebackProtectionData: [
          {
            productName: pack.name,
            productType: "digitalCollectibles",
            quantity: count,
            rawProductData: { packId: pack.id, solAddress },
          },
        ],
        webhookInfo: { packId: pack.id, count, solAddress },
      }),
    })
    const json = (await res.json().catch(() => ({}))) as { checkoutJwtToken?: string }
    if (!res.ok || !json.checkoutJwtToken) {
      console.error("[coinflow] jwt-token failed", res.status, json)
      throw new GachaError("COINFLOW_ERROR", "couldn't start card checkout — try again", 502)
    }
    return NextResponse.json({
      jwtToken: json.checkoutJwtToken,
      subtotalCents: cart.subtotalCents,
      feeCents: cart.feeCents,
      totalCents: cart.totalCents,
    })
  } catch (e) {
    return errorResponse(e)
  }
}
