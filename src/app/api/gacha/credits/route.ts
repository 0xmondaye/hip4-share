// Free-pack entitlements: read what the caller is owed, and redeem one into a
// house-funded Slabz gift. Two shapes on one POST (the peek must not need a
// wallet — the embedded Solana wallet only exists after a first pull):
//
//   {}                       → { credits: [...] }   read-only, spends nothing
//   { packId, solAddress }   → { giftId, ... }      mints, the house pays
//
// The peek returns every unredeemed row and the client filters with
// `creditMatches` — that keeps page load off Slabz's 60/min key limit. The
// claim resolves the pack NAME server-side from packId and never trusts a
// client-supplied name: a credit caps free PACKS, not dollars, so a forged
// name on an expensive packId would mint a $2,500 gift off a $25 entitlement.

import { NextResponse } from "next/server"
import { requireGachaAccess } from "@/lib/gacha-server/gate"
import {
  attachGift,
  claimCredit,
  listCredits,
  releaseCredit,
} from "@/lib/gacha-server/credits"
import { grantGift } from "@/lib/gacha-server/gift"
import { errorResponse, GachaError } from "@/lib/gacha-server/http"
import { getPack } from "@/lib/gacha-server/slabz"

// JWKS fetch + Slabz getPack (retries) + gift create/simulate/sign/submit —
// well over the 10s default
export const maxDuration = 60

const UUID = /^[0-9a-fA-F-]{36}$/
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      packId?: string
      solAddress?: string
    }
    // one lookup covers every keying: email-granted campaigns, wallet-granted
    // grants for wallet-only signups, and DID-granted referrals. Built in
    // auth.ts so the gate that just let this caller in matched on exactly the
    // same list (credits.ts lowercases on the SQL side too).
    const { subjects } = await requireGachaAccess(req)

    if (!body.solAddress)
      return NextResponse.json({ credits: await listCredits(subjects) })

    // ---- redeem: the house pays the full Slabz price past this line --------
    const { packId, solAddress } = body
    if (!packId || !UUID.test(packId))
      throw new GachaError("BAD_REQUEST", "packId must be a UUID")
    if (!BASE58.test(solAddress))
      throw new GachaError("BAD_ADDRESS", "invalid Solana address")

    // Accepted write-down, same as the Slabz proxy: the receiver address is
    // not bound to the Privy account, so a user can point their own free pack
    // at someone else's wallet. Blast radius is their own entitlement — the
    // row is consumed either way — so this stays a UX wart, not a hole.
    const pack = await getPack(packId)
    if (!pack.isActive) throw new GachaError("PACK_INACTIVE", "pack unavailable")

    const row = await claimCredit(subjects, pack.name)
    if (!row)
      throw new GachaError("NO_CREDIT", "no free pack available for this pack", 409)

    let gift
    try {
      gift = await grantGift({
        packId,
        receiverAddress: solAddress,
        count: row.packs,
        // deterministic per attempt: a retry of THIS attempt can never mint a
        // second gift, while a released row's next attempt gets a fresh key
        idempotencyKey: `credit:${row.id}:${row.attempts}`,
      })
    } catch (e) {
      // grantGift's contract: a throw means nothing was funded — hand the
      // entitlement back so the user can click again
      await releaseCredit(row.id).catch(() => {})
      throw e
    }
    // Past the funding submit. NEVER release from here on: the funder may
    // already be out the money, and a second mint would double it. A failed
    // write leaves the row 'pending' — the /gacha banner still surfaces the
    // gift, since it lists Slabz gifts by receiver address.
    await attachGift(row.id, gift.giftId).catch((e) =>
      console.error("[credits] gift funded but row not attached", row.id, gift.giftId, e),
    )
    if (gift.status !== "confirmed")
      console.error("[credits] gift funded but status", gift.status, gift.giftId)

    return NextResponse.json({
      giftId: gift.giftId,
      status: gift.status,
      packCount: gift.packCount,
    })
  } catch (e) {
    return errorResponse(e)
  }
}
