// Sponsored Relay pay-in for a physical redeem: user's HL USDC → user's own
// Solana pack wallet, so Slabz's burn tx can pay the shipping cost. No markup
// (shipping is Slabz's charge, not ours) and no house custody — same leg as a
// pack pull, quoted for the shipping total instead of a pack price.
//
// The amount is read from Slabz's own estimate with our API key (this route and
// the browser proxy share one key, so the browser's signed redeem session is
// visible here), never taken from the request body: a client-supplied figure
// would be an open-ended bridge on our sponsorship. The client now also checks
// the returned totalCents against the estimate the user confirmed before it
// signs anything — see fundShipping.

import { NextResponse } from "next/server"
import { requireGachaAccess } from "@/lib/gacha-server/gate"
import { errorResponse, GachaError } from "@/lib/gacha-server/http"
import { payinQuote } from "@/lib/gacha-server/relay"
import * as slabz from "@/lib/gacha-server/slabz"

// JWKS fetch + Slabz estimate + Relay quote — over the 10s default
export const maxDuration = 60

// Ceiling on one sponsored shipping bridge. Worst documented case is ~$35
// shipping + $3/extra card + 0.5% insurance, so $200 clears real orders while
// keeping a bug from draining the fee-sponsorship balance.
const MAX_FUND_CENTS = Math.floor(Number(process.env.GACHA_REDEEM_MAX_FUND_CENTS ?? 20_000))

export async function POST(req: Request) {
  try {
    const { transactionId, shippingAddressId, solAddress, hlAddress } = (await req
      .json()
      .catch(() => ({}))) as {
      transactionId?: string
      shippingAddressId?: string
      solAddress?: string
      hlAddress?: string
    }
    if (!transactionId || !/^[0-9a-fA-F-]{36}$/.test(transactionId))
      throw new GachaError("BAD_REQUEST", "transactionId required")
    if (!shippingAddressId || typeof shippingAddressId !== "string")
      throw new GachaError("BAD_REQUEST", "shippingAddressId required")
    if (!hlAddress || !/^0x[0-9a-fA-F]{40}$/.test(hlAddress))
      throw new GachaError("BAD_ADDRESS", "invalid HL address")
    if (!solAddress || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(solAddress))
      throw new GachaError("BAD_ADDRESS", "invalid Solana address")
    await requireGachaAccess(req)

    const estimate = await slabz.redeemEstimate(transactionId, shippingAddressId)
    // round UP to the cent: a bridge one cent short fails the burn AFTER the
    // user's money moved. Fractions of a cent are ours to eat, not theirs.
    const totalCents = Math.ceil(Number(estimate.total) * 100)
    if (!Number.isFinite(totalCents) || totalCents < 1)
      throw new GachaError("BAD_ESTIMATE", "Slabz returned no shipping cost")
    if (totalCents > MAX_FUND_CENTS)
      throw new GachaError(
        "SHIPPING_TOO_LARGE",
        `Shipping quoted $${(totalCents / 100).toFixed(2)} — over the $${(MAX_FUND_CENTS / 100).toFixed(0)} limit. Contact support.`,
      )

    const { quote } = await payinQuote({
      userHlAddr: hlAddress,
      userSolAddr: solAddress,
      priceCents: totalCents,
      markupCents: 0, // we don't mark up shipping
    })
    return NextResponse.json({ quote, totalCents })
  } catch (e) {
    return errorResponse(e)
  }
}
