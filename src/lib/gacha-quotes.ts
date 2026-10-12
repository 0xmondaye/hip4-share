// Client for the gacha quote routes. Every call carries the Privy access
// token — the server verifies it against Privy's JWKS.

import { privyAuthHeaders } from "./privy-tokens"
import type { FreeCredit } from "./gacha-core"
import type { WithdrawQuote } from "./relay-withdraw-core"
import type { SolanaQuoteStep } from "./gacha-relay-core"

export class GachaApiError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

async function api<T>(path: string, body: unknown, retried = false): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      // shared single-flight lookup — see privy-tokens.ts for why asking
      // Privy per-call is what trips its rate limit
      ...(await privyAuthHeaders(retried)),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as T & {
    error?: { code?: string; message?: string }
  }
  if (!res.ok) {
    // One silent retry on 401, forcing a fresh lookup past the cache: Privy
    // reissues the identity token alongside the access token.
    if (res.status === 401 && !retried) {
      return api<T>(path, body, true)
    }
    throw new GachaApiError(
      json.error?.code ?? `HTTP_${res.status}`,
      json.error?.message ?? `Request failed (${res.status})`,
      res.status,
    )
  }
  return json
}

/** Sponsored pay-in quote (HL → user's own Solana wallet, markup included) —
 *  executed client-side with the same machinery as withdrawals. */
export const getPayinQuote = (
  packId: string,
  solAddress: string,
  hlAddress: string,
  count = 1,
) =>
  api<{ quote: WithdrawQuote; priceCents: number; totalCents: number }>(
    "/api/gacha/payin-quote",
    { packId, solAddress, hlAddress, count },
  )

/** Sponsored pay-in quote for a physical redeem's shipping cost. The server
 *  reads the amount from Slabz's estimate — nothing here sets it. */
export const getRedeemFundQuote = (input: {
  transactionId: string
  shippingAddressId: string
  solAddress: string
  hlAddress: string
}) =>
  api<{ quote: WithdrawQuote; totalCents: number }>("/api/gacha/redeem-fund", input)

/** Sponsored sweep-all payout quote (user Solana → user HL). The server
 *  derives the amount from the wallet's on-chain balance. */
export const getPayoutQuote = (solAddress: string, hlAddress: string) =>
  api<{
    quote: { requestId: string; step: SolanaQuoteStep; checkEndpoint: string }
    amountUnits6: string
  }>("/api/gacha/payout-quote", { solAddress, hlAddress })

/** Server-side gas sponsorship: post the user-signed payout tx; the server
 *  verifies it, co-signs as fee payer and broadcasts. */
export const sendPayoutTx = (transaction: string) =>
  api<{ signature: string }>("/api/gacha/payout-send", { transaction })

/** Free-pack entitlements owed to the caller (gacha_credits). Read-only and
 *  wallet-free — filter per pack with `creditMatches`. */
export const getFreeCredits = () =>
  api<{ credits: FreeCredit[] }>("/api/gacha/credits", {})

/** Redeem one entitlement into a house-funded Slabz gift on this pack. This
 *  SPENDS house money (the full Slabz price) — only ever call it from a user
 *  click, never on load. The returned gift claims exactly like a gifted pack. */
export const claimFreeCredit = (packId: string, solAddress: string) =>
  api<{ giftId: string; status: string; packCount: number }>("/api/gacha/credits", {
    packId,
    solAddress,
  })

/** Server-signed Coinflow checkout params for a card-funded pull: subtotal =
 *  bare price (delivered as USDC), fee = markup (house). The JWT is the
 *  tamper guard — the client only relays it to the Coinflow component. */
export const getCardCheckoutJwt = (packId: string, solAddress: string, count = 1) =>
  api<{ jwtToken: string; subtotalCents: number; feeCents: number; totalCents: number }>(
    "/api/coinflow/checkout-jwt",
    { packId, solAddress, count },
  )

/** Server-created Crossmint onramp order for a card-funded pull: the charge
 *  amount and recipient wallet are pinned server-side; the client only relays
 *  orderId + clientSecret into Crossmint's embedded checkout. */
export const getOnrampOrder = (packId: string, solAddress: string, count = 1) =>
  api<{ orderId: string; clientSecret: string; subtotalCents: number; totalCents: number }>(
    "/api/crossmint/onramp-order",
    { packId, solAddress, count },
  )
