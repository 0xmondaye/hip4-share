// Sponsored Relay payout quote: user's Solana USDC → user's HL account,
// sweep-all. Serves both sell-back proceeds and the stranded-balance
// recovery button. The amount is ALWAYS the wallet's on-chain balance read
// here — a client-supplied number is never trusted. The returned tx carries
// the HOUSE fee payer (server-side sponsorship); the user wallet needs zero
// SOL. The signed tx goes back through /api/gacha/payout-send.

import { NextResponse } from "next/server"
import { requireGachaAccess } from "@/lib/gacha-server/gate"
import { errorResponse, GachaError } from "@/lib/gacha-server/http"
import { payoutQuote } from "@/lib/gacha-server/relay"
import { walletUsdcUnits6 } from "@/lib/gacha-server/gas-sponsor"

export const maxDuration = 60

/** Below this a bridge isn't worth a signature (dust). */
const MIN_UNITS6 = BigInt(500_000) // $0.50

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      solAddress?: string
      hlAddress?: string
    }
    const { solAddress, hlAddress } = body
    if (!hlAddress || !/^0x[0-9a-fA-F]{40}$/.test(hlAddress))
      throw new GachaError("BAD_ADDRESS", "invalid HL address")
    if (!solAddress || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(solAddress))
      throw new GachaError("BAD_ADDRESS", "invalid Solana address")
    await requireGachaAccess(req)

    const units = await walletUsdcUnits6(solAddress)
    if (BigInt(units) < MIN_UNITS6)
      throw new GachaError("NOTHING_TO_BRIDGE", "no balance worth moving")

    const quote = await payoutQuote({
      userSolAddr: solAddress,
      userHlAddr: hlAddress,
      amountUnits6: units,
    })
    return NextResponse.json({ quote, amountUnits6: units })
  } catch (e) {
    return errorResponse(e)
  }
}
