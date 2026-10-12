// Same-origin JSON-RPC relay so the BROWSER's HyperEVM reads ride the paid endpoint too.
// WINE_RPC_URL is a credential and stays server-only; the page talks to this route and
// this route talks to QuickNode. Falls back to the chain's public RPC when unset or when
// the caller is not signed in, so the client never has to know which one it got.
//
// Read methods only. Anything that writes goes through the wallet's own provider (the
// user signs and their wallet broadcasts), and an open relay for eth_sendRawTransaction
// would just be someone else's free RPC.
//
// Who pays: a SIGNED-IN user (valid Privy access token, sent as the same-origin cookie the
// page already carries) is forwarded to the paid endpoint; anyone else gets the chain's
// public RPC. So a scraper can only ever burn the free endpoint through us, never the
// QuickNode quota, while signed-out visitors still see the shelf.
//
// ponytail: no per-user rate limit — the Privy JWT is the gate and QuickNode's quota the
// ceiling. Add a token bucket keyed on userId if one account ever shows up in the bill.

import { NextResponse } from "next/server"
import { requireUser } from "@/lib/gacha-server/auth"
import { WINE_CHAIN } from "@/lib/wine"

export const maxDuration = 30

const READ = new Set([
  "eth_call", "eth_getBalance", "eth_blockNumber", "eth_chainId", "eth_getCode",
  "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber",
  "eth_getLogs", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas",
  "eth_feeHistory", "eth_getTransactionCount", "net_version",
])

type Req = { method?: unknown }

export async function POST(req: Request) {
  const origin = req.headers.get("origin")
  const host = req.headers.get("host")
  let originHost: string | null = null
  try { originHost = origin ? new URL(origin).host : null } catch { originHost = "invalid" }
  if (originHost && host && originHost !== host)
    return NextResponse.json({ error: "cross-origin" }, { status: 403 })

  const body = (await req.json().catch(() => null)) as Req | Req[] | null
  if (!body) return NextResponse.json({ error: "bad json" }, { status: 400 })
  const calls = Array.isArray(body) ? body : [body]
  if (calls.length > 50 || calls.some((c) => typeof c?.method !== "string" || !READ.has(c.method)))
    return NextResponse.json({ error: "read methods only" }, { status: 400 })

  const publicRpc = WINE_CHAIN.rpcUrls.default.http[0]
  const signedIn = await requireUser(req).then(() => true, () => false)
  const upstream = signedIn ? (process.env.WINE_RPC_URL ?? publicRpc) : publicRpc
  const r = await fetch(upstream, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  })
  return new NextResponse(r.body, {
    status: r.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}
