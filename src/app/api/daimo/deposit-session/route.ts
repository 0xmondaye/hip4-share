// Server-created Daimo Pay session for a deposit into the user's Hyperliquid
// account. The destination (Daimo's Hypercore adapter, HyperEVM USDC) and the
// recipient calldata are pinned here; the client only relays sessionId +
// clientSecret into Daimo's hosted checkout, so it can't redirect the funds.
// The amount is deliberately open — the user picks it inside Daimo, exactly
// like sending any size to the Relay deposit address.
//
// Requires a signed-in user (access token only — no allowlist, deposits are
// for everyone). /api/deposit-address is anonymous because all it hands back
// is an address, but a Daimo session is a Gambit-branded checkout on
// daimo.com that takes CARDS: minted anonymously it would be ready-made
// phishing bait ("fund your Gambit balance here") pointed at the attacker's
// own account. Auth doesn't stop a determined signup, it makes abuse
// traceable to a DID we can ban.
// ponytail: recipient is still whatever address the client passes — binding
// it to the DID needs the wallet list from the identity token or the Privy
// app secret. Worth doing if this rail ever gets abused; the log line below
// is what would show it.
//
// Bounce caveat: with calldata, a reverted adapter call refunds to
// refundAddress — the user's own address, but ON HYPEREVM, which
// RecoverFunds does not scan (see HANDOFF.md). Reverts on a plain USDC
// forward are rare; revisit if any session ever lands as `bounced`.

import { requireUser } from "@/lib/gacha-server/auth"
import {
  DAIMO_API,
  daimoEnabled,
  HYPERCORE_DEPOSIT_ADAPTER,
  HYPEREVM_CHAIN_ID,
  HYPEREVM_USDC,
  hypercoreDepositCalldata,
} from "@/lib/daimo-core"

// JWKS fetch on a cold start + one Daimo round trip
export const maxDuration = 30

export async function POST(req: Request) {
  const apiKey = process.env.DAIMO_API_KEY ?? ""
  if (!daimoEnabled || !apiKey)
    return Response.json({ message: "Card deposits are not configured" }, { status: 503 })

  const { user } = (await req.json().catch(() => ({}))) as { user?: string }
  if (typeof user !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(user))
    return Response.json({ message: "Bad request" }, { status: 400 })

  let userId: string
  try {
    ;({ userId } = await requireUser(req))
  } catch {
    return Response.json({ message: "Sign in to deposit" }, { status: 401 })
  }
  // the audit trail that would expose abuse of the open recipient
  console.log("[daimo] deposit session", { userId, user })

  const res = await fetch(`${DAIMO_API}/v1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      destination: {
        type: "evm",
        address: HYPERCORE_DEPOSIT_ADAPTER,
        chainId: HYPEREVM_CHAIN_ID,
        tokenAddress: HYPEREVM_USDC,
        calldata: hypercoreDepositCalldata(user),
      },
      display: {
        title: "Deposit to Gambit",
        verb: "Deposit",
        paymentMethods: { mode: "auto" },
      },
      // required whenever calldata is set — see the bounce caveat above
      refundAddress: user,
      metadata: { hlAddress: user },
    }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    session?: { sessionId?: string; clientSecret?: string }
  }
  const sessionId = data.session?.sessionId
  const clientSecret = data.session?.clientSecret
  if (!res.ok || !sessionId || !clientSecret) {
    console.error("[daimo] create-session failed", res.status, data)
    return Response.json(
      { message: "Couldn't start the deposit — try again" },
      { status: 502 },
    )
  }
  return Response.json({ sessionId, clientSecret })
}
