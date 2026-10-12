// Open a user's signed wine pack (ERC-3009, gasless for the player). The
// signature binds every Request field — the contract recomputes the nonce as
// requestId(req) — so the only thing this route "spends" is settler gas, and
// payment moves in the same tx as the bottles. The allowlist gate keeps the
// Cellar inside the same closed beta as pack pulls (it shares gacha_allowlist).

import { NextResponse } from "next/server"
import { requireGachaAllowlist } from "@/lib/gacha-server/gate"
import { errorResponse, GachaError } from "@/lib/gacha-server/http"
import { openPack } from "@/lib/gacha-server/wine"

export const maxDuration = 60

const HEX32 = /^0x[0-9a-fA-F]{64}$/
const ADDR = /^0x[0-9a-fA-F]{40}$/
const SIG = /^0x[0-9a-fA-F]{130}$/

export async function POST(req: Request) {
  try {
    await requireGachaAllowlist(req)
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const user = b.user as string
    const userSeed = b.userSeed as string
    const signature = b.signature as string
    const count = Number(b.count)
    const payToken = Number(b.payToken)
    const minAvailable = Number(b.minAvailable)
    const epoch = Number(b.epoch)
    const round = Number(b.round)
    const validBefore = Number(b.validBefore)

    if (!ADDR.test(user)) throw new GachaError("BAD_INPUT", "invalid user address")
    if (!HEX32.test(userSeed) || /^0x0{64}$/.test(userSeed))
      throw new GachaError("BAD_INPUT", "invalid userSeed")
    if (!SIG.test(signature)) throw new GachaError("BAD_INPUT", "invalid signature")
    if (!Number.isInteger(count) || count < 1 || count > 25)
      throw new GachaError("BAD_INPUT", "count out of range")
    if (!Number.isInteger(payToken) || payToken < 0 || payToken > 255)
      throw new GachaError("BAD_INPUT", "invalid payToken")
    if (!Number.isInteger(minAvailable) || minAvailable < 0 || minAvailable > 0xffffffff)
      throw new GachaError("BAD_INPUT", "invalid minAvailable")
    if (!Number.isInteger(epoch) || epoch < 0 || epoch > 0xffffffff)
      throw new GachaError("BAD_INPUT", "invalid epoch")
    if (!Number.isInteger(round) || round < 1 || round > Number.MAX_SAFE_INTEGER)
      throw new GachaError("BAD_INPUT", "invalid round")
    if (!Number.isInteger(validBefore) || validBefore <= Math.floor(Date.now() / 1000))
      throw new GachaError("BAD_INPUT", "authorization expired")

    const out = await openPack({
      user: user as `0x${string}`,
      userSeed: userSeed as `0x${string}`,
      signature: signature as `0x${string}`,
      count,
      payToken,
      minAvailable,
      epoch,
      round: BigInt(round),
      validAfter: BigInt(0),
      validBefore: BigInt(validBefore),
    })
    return NextResponse.json(out)
  } catch (e) {
    return errorResponse(e)
  }
}
