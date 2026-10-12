// Bottles a HyperEVM address holds from wine pulls — the settle index filtered
// by ownerOf(). Public read: who owns which ERC-721 is on-chain anyway, and the
// Collection page reads it before the Privy session has a token.

import { NextResponse } from "next/server"
import { errorResponse, GachaError } from "@/lib/gacha-server/http"
import { bottlesOf } from "@/lib/gacha-server/wine"

export async function GET(req: Request) {
  try {
    const user = new URL(req.url).searchParams.get("user") ?? ""
    if (!/^0x[0-9a-fA-F]{40}$/.test(user)) throw new GachaError("BAD_INPUT", "invalid user address")
    const bottles = await bottlesOf(user as `0x${string}`)
    return NextResponse.json({
      bottles: bottles.map((b) => ({ ...b, tokenId: b.tokenId.toString() })),
    })
  } catch (e) {
    return errorResponse(e)
  }
}
