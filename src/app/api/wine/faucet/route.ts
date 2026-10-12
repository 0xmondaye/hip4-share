// Testnet faucet: mint one pull of mock USDC to the caller's wallet so the Cellar is
// testable end-to-end without `cast`. mintTestUsdc refuses off chain 998.
//
// There is deliberately NO points faucet here. Points are 1:1 with USDC and a minted point
// is a free draw on the wine pool, so minting is owner-key only — `script/points.sh` in the
// contract repo, run by a human, straight to event staff. No hot key holds MINTER_ROLE and
// `dailyMintLimit` is 0, so this server could not mint even if this route asked it to.
// Staff hand points to guests with an ordinary ERC20 transfer and take cash for them.

import { NextResponse } from "next/server"
import { requireGachaAllowlist } from "@/lib/gacha-server/gate"
import { errorResponse, GachaError } from "@/lib/gacha-server/http"
import { mintTestUsdc } from "@/lib/gacha-server/wine"

export const maxDuration = 60

export async function POST(req: Request) {
  try {
    await requireGachaAllowlist(req)
    const b = (await req.json().catch(() => ({}))) as { user?: string }
    if (!b.user || !/^0x[0-9a-fA-F]{40}$/.test(b.user))
      throw new GachaError("BAD_INPUT", "invalid user address")
    return NextResponse.json(await mintTestUsdc(b.user as `0x${string}`, BigInt(100_000_000)))
  } catch (e) {
    return errorResponse(e)
  }
}
