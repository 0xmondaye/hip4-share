// Server-side gas sponsorship for the payout leg: the client returns the
// user-signed payout tx (minted by /payout-quote with the house fee payer),
// this route verifies it only spends the fee (svm-tx.verifyPayoutTx),
// co-signs with the executor key and broadcasts. Auth but NO allowlist gate:
// moving funds OUT to the user's own HL account must always work, even for
// users later removed from the beta.
//
// No per-user send cap either (removed 2026-08-25). It cost ~$0.045 a send to
// sponsor, so the old 20/day defended under a dollar while 429ing the users
// who play most — and it never bounded abuse anyway: payout-quote refuses
// under $0.50 and the sweep DRAINS the wallet, so a repeat send needs a fresh
// deposit that costs the sender more than it costs us, and the pay-in leg
// draws the same sponsorship with no counter at all. What actually bounds a
// runaway client is unchanged: verifyPayoutTx limits the executor to the
// network fee, RecoverBalance stops after MAX_AUTO_TRIES, the money lock
// serialises ops, and a drained wallet quotes NOTHING_TO_BRIDGE. Re-add a
// cap only against a measured cost, never a hypothetical one.

import { NextResponse } from "next/server"
import { requireUser } from "@/lib/gacha-server/auth"
import { errorResponse, GachaError } from "@/lib/gacha-server/http"
import { coSignAndSendPayout } from "@/lib/gacha-server/svm-tx"

export const maxDuration = 30

export async function POST(req: Request) {
  try {
    // still the trust boundary — the cap is gone, the auth check is not
    await requireUser(req)
    const { transaction } = (await req.json().catch(() => ({}))) as { transaction?: string }
    // a legit payout tx is ~300-400 bytes; anything huge isn't ours
    if (!transaction || typeof transaction !== "string" || transaction.length > 4096)
      throw new GachaError("BAD_TX", "invalid transaction payload")
    const signature = await coSignAndSendPayout(transaction)
    return NextResponse.json({ signature })
  } catch (e) {
    return errorResponse(e)
  }
}
