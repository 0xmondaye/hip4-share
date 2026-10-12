// Relay a holder's signed sellback. The holder signs; this submits and pays the gas.
//
// Gasless on purpose: a guest gifted their stake has never held HYPE, and the sellback used
// to be the one transaction they had to send themselves — so winning a bottle and being
// unable to cash it out was the default experience for exactly the people an event is for.
//
// This endpoint is a convenience, not a gate. `PrizeNFT.sellWithSig` is permissionless, so if
// this is down the holder can submit the same authorisation themselves and still be paid.

import { NextResponse } from "next/server"
import { requireGachaAllowlist } from "@/lib/gacha-server/gate"
import { errorResponse, GachaError } from "@/lib/gacha-server/http"
import { relaySellback } from "@/lib/gacha-server/wine"

export const maxDuration = 60

const ADDR = /^0x[0-9a-fA-F]{40}$/
const SIG = /^0x[0-9a-fA-F]+$/

export async function POST(req: Request) {
  try {
    await requireGachaAllowlist(req)
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const owner = String(b.owner ?? "")
    const collection = String(b.collection ?? "")
    const signature = String(b.signature ?? "")

    if (!ADDR.test(owner)) throw new GachaError("BAD_INPUT", "invalid owner address")
    if (!ADDR.test(collection)) throw new GachaError("BAD_INPUT", "invalid collection address")
    // 65 bytes for an EOA; longer is legitimate for an ERC-1271 contract wallet.
    if (!SIG.test(signature) || signature.length < 132)
      throw new GachaError("BAD_INPUT", "invalid signature")

    let tokenId: bigint
    let deadline: bigint
    try {
      tokenId = BigInt(String(b.tokenId))
      deadline = BigInt(String(b.deadline))
    } catch {
      throw new GachaError("BAD_INPUT", "tokenId and deadline must be integers")
    }
    // Checked here as well as on-chain so an expired authorisation costs no gas to learn.
    if (deadline <= BigInt(Math.floor(Date.now() / 1000)))
      throw new GachaError("EXPIRED", "that authorisation has expired — tap sell again", 400)
    // Bottles already handed over in person. The NFT is still in the wallet (nothing but the
    // holder can burn it), so the relay refuses to cash it a second time. sellWithSig itself
    // is permissionless, so this stops a guest with the app, not a determined operator of a
    // node -- good enough for an event. WINE_SELL_BLOCKLIST=65537,131073
    if ((process.env.WINE_SELL_BLOCKLIST ?? "").split(",").map((s) => s.trim()).includes(tokenId.toString()))
      throw new GachaError("COLLECTED", "this bottle was collected in person — it can no longer be sold back", 409)

    return NextResponse.json(
      await relaySellback(
        owner as `0x${string}`,
        collection as `0x${string}`,
        tokenId,
        deadline,
        signature as `0x${string}`,
      ),
    )
  } catch (e) {
    return errorResponse(e)
  }
}
