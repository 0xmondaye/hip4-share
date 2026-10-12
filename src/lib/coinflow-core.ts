// Coinflow card checkout (docs.coinflow.cash) — fiat in, USDC delivered
// on-chain to the user's own Solana pack wallet. Slots in FRONT of the
// existing purchase path: a funded wallet re-enters doPull at the skip-bridge
// check, so nothing downstream changes. Pure logic only; no I/O.
//
// Money split, mirroring the Relay pay-in leg's economics:
//   subtotal        = bare Slabz price × count → delivered to the user as USDC
//   customPayInFees = markup × count          → settles to our Coinflow merchant
//                                               balance (house revenue)
// The fee is minted into a server-signed checkout JWT (route
// /api/coinflow/checkout-jwt) so a client can't strip it.

export const COINFLOW_MERCHANT_ID = process.env.NEXT_PUBLIC_COINFLOW_MERCHANT_ID ?? ""

const RAW_ENV = process.env.NEXT_PUBLIC_COINFLOW_ENV ?? "sandbox"
/** Only the two envs we deploy against — anything else clamps to sandbox so a
 *  typo can never take real card payments. */
export const COINFLOW_ENV: "prod" | "sandbox" = RAW_ENV === "prod" ? "prod" : "sandbox"

/** Card checkout exists only when the merchant id is configured. */
export const coinflowEnabled = COINFLOW_MERCHANT_ID !== ""

export const COINFLOW_API =
  COINFLOW_ENV === "prod"
    ? "https://api.coinflow.cash/api"
    : "https://api-sandbox.coinflow.cash/api"

export type CardCart = {
  /** USDC delivered to the wallet — must equal what the Slabz purchase spends */
  subtotalCents: number
  /** house markup, charged on the card but never delivered */
  feeCents: number
  /** what the card is charged: subtotal + fee */
  totalCents: number
}

/**
 * Cart for a card-funded pull. Same linear math as the Relay pay-in quote:
 * bulk = single × count on both legs. Throws on a non-positive price or an
 * out-of-range count — the route treats that as BAD_REQUEST, and a clamped
 * silent fixup could charge for a different pull than the user clicked.
 */
export function cardCart(
  pack: { priceCents: number; markupCents?: number },
  count: number,
): CardCart {
  if (!Number.isInteger(count) || count < 1 || count > 10)
    throw new Error("count must be an integer 1-10")
  if (!Number.isInteger(pack.priceCents) || pack.priceCents <= 0)
    throw new Error("bad pack price")
  const markup = pack.markupCents ?? 0
  if (!Number.isInteger(markup) || markup < 0) throw new Error("bad markup")
  const subtotalCents = pack.priceCents * count
  const feeCents = markup * count
  return { subtotalCents, feeCents, totalCents: subtotalCents + feeCents }
}
