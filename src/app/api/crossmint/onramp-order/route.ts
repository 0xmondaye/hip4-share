// Server-created Crossmint onramp order for a card-funded pack pull. The
// order pins the USD charge (displayed total = bare Slabz price + markup) and
// the recipient wallet server-side — the client only relays orderId +
// clientSecret to Crossmint's embedded checkout, so it can neither reprice
// the pull nor redirect the USDC. Same trust boundary as the Coinflow JWT.
//
// Crossmint's onramp is exact-in: fees come out of the charged amount. The
// markup is the fee headroom; if Crossmint's quote can't guarantee delivery
// of the bare price, we refuse rather than silently under-fund the pull.

import { NextResponse } from "next/server"
import { requireGachaAccess } from "@/lib/gacha-server/gate"
import { errorResponse, GachaError } from "@/lib/gacha-server/http"
import * as slabz from "@/lib/gacha-server/slabz"
import { cardCart } from "@/lib/coinflow-core"
import {
  centsToUsd,
  coversPull,
  CROSSMINT_API,
  CROSSMINT_USDC_LOCATOR,
  crossmintEnabled,
} from "@/lib/crossmint-core"

// JWKS fetch + Slabz getPack (retries) + two Crossmint round trips
export const maxDuration = 60

export async function POST(req: Request) {
  try {
    const apiKey = process.env.CROSSMINT_API_KEY ?? ""
    if (!crossmintEnabled || !apiKey)
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
    const { emails } = await requireGachaAccess(req)
    const receiptEmail = emails[0]
    if (!receiptEmail)
      throw new GachaError("EMAIL_REQUIRED", "card checkout needs an email on your account")

    // fresh price, never the client's possibly hour-stale catalog snapshot
    const pack = await slabz.getPack(packId)
    if (!pack.isActive) throw new GachaError("PACK_INACTIVE", "pack unavailable")
    const cart = cardCart(pack, count)

    const headers = { "Content-Type": "application/json", "x-api-key": apiKey }

    // Crossmint requires external delivery wallets to be linked to a user first
    const link = await fetch(
      `${CROSSMINT_API}/api/2025-06-09/users/${encodeURIComponent(
        `email:${receiptEmail}`,
      )}/linked-wallets/${encodeURIComponent(solAddress)}`,
      { method: "PUT", headers, body: JSON.stringify({ chain: "solana" }) },
    )
    if (!link.ok) {
      console.error("[crossmint] link-wallet failed", link.status, await link.text().catch(() => ""))
      throw new GachaError("CROSSMINT_ERROR", "couldn't start card checkout — try again", 502)
    }

    const res = await fetch(`${CROSSMINT_API}/api/2022-06-09/orders`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        lineItems: [
          {
            tokenLocator: CROSSMINT_USDC_LOCATOR,
            executionParameters: { mode: "exact-in", amount: centsToUsd(cart.totalCents) },
          },
        ],
        payment: { method: "card", receiptEmail },
        recipient: { walletAddress: solAddress },
      }),
    })
    const json = (await res.json().catch(() => ({}))) as {
      clientSecret?: string
      order?: {
        orderId?: string
        lineItems?: Array<{ quote?: { quantityRange?: { lowerBound?: string } } }>
      }
    }
    const orderId = json.order?.orderId
    const lowerBound = json.order?.lineItems?.[0]?.quote?.quantityRange?.lowerBound
    if (!res.ok || !json.clientSecret || !orderId || !lowerBound) {
      console.error("[crossmint] create-order failed", res.status, json)
      throw new GachaError("CROSSMINT_ERROR", "couldn't start card checkout — try again", 502)
    }
    // exact-in: Crossmint's fee comes out of the charge. Guaranteed delivery
    // must still cover the bare Slabz price or the resumed pull can't buy.
    if (!coversPull(lowerBound, cart.subtotalCents)) {
      console.error("[crossmint] fee exceeds markup headroom", {
        lowerBound,
        subtotalCents: cart.subtotalCents,
        totalCents: cart.totalCents,
      })
      throw new GachaError(
        "CARD_FEE_TOO_HIGH",
        "card fees are too high for this pack right now — try the balance flow",
        502,
      )
    }

    return NextResponse.json({
      orderId,
      clientSecret: json.clientSecret,
      subtotalCents: cart.subtotalCents,
      totalCents: cart.totalCents,
    })
  } catch (e) {
    return errorResponse(e)
  }
}
