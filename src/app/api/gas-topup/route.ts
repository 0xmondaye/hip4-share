// Drop gas HYPE into the caller's own HyperEVM wallet so they can move their USDC out
// (HyperEVM → HyperCore, ahead of a withdrawal) without ever buying HYPE. Paid by the settler
// key, which holds gas and nothing else. Only to an address Privy says the caller owns, and
// only when the wallet is running low — the on-chain balance check is the rate limit.
import { NextResponse } from "next/server"
import { requireUserEmails } from "@/lib/gacha-server/auth"
import { errorResponse, GachaError } from "@/lib/gacha-server/http"
import { ensureGas } from "@/lib/gacha-server/wine"

export const maxDuration = 60

export async function POST(req: Request) {
  try {
    const { subjects } = await requireUserEmails(req)
    const b = (await req.json().catch(() => ({}))) as { address?: unknown }
    const address = String(b.address ?? "")
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new GachaError("BAD_INPUT", "invalid address")
    if (!subjects.includes(address.toLowerCase()))
      throw new GachaError("NOT_YOURS", "that wallet is not linked to your account", 403)
    return NextResponse.json({ sent: await ensureGas(address as `0x${string}`) })
  } catch (e) {
    return errorResponse(e)
  }
}
