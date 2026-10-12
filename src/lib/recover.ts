"use client"

// Stranded-funds recovery: find USDC sitting at the user's own address on an
// origin chain (wrong-network deposit, or a Relay refund) and bridge it into
// their Hyperliquid account via a Relay quote executed with the user's
// wallet. Primary path is gasless: `usePermit` makes Relay return an
// EIP-3009 signature step, so an embedded wallet with zero origin-chain gas
// can still move its USDC. Transaction steps (permit unavailable) are
// executed too but need origin gas — the error then says so plainly.

import type { ConnectedWallet } from "@privy-io/react-auth"
import {
  createPublicClient,
  createWalletClient,
  custom,
  erc20Abi,
  fallback,
  formatUnits,
  http,
  type Chain,
} from "viem"
import { arbitrum, base, mainnet, optimism, polygon } from "viem/chains"
import { makeSigner } from "./privy-signer"
import { sweepPerpsToSpot } from "./hl-exchange"
import { isUserRejection, WithdrawTrackableError } from "./relay-withdraw"
import { RELAY_API } from "./relay-withdraw-core"
import {
  DEPOSIT_CHAINS,
  MIN_RECOVER_RAW,
  parseRecoverQuote,
  type DepositChain,
  type RecoverItem,
} from "./recover-core"

const VIEM_CHAINS: Record<number, Chain> = {
  [arbitrum.id]: arbitrum,
  [base.id]: base,
  [mainnet.id]: mainnet,
  [optimism.id]: optimism,
  [polygon.id]: polygon,
}

// publicnode first (CORS-friendly, reliable — viem's default mainnet RPC
// failed outright in testing), viem chain default as fallback. A chain whose
// reads fail is a chain whose stranded funds we never detect.
const PUBLIC_RPC: Record<number, string> = {
  [arbitrum.id]: "https://arbitrum-one-rpc.publicnode.com",
  [base.id]: "https://base-rpc.publicnode.com",
  [mainnet.id]: "https://ethereum-rpc.publicnode.com",
  [optimism.id]: "https://optimism-rpc.publicnode.com",
  [polygon.id]: "https://polygon-bor-rpc.publicnode.com",
}

export interface StrandedFunds {
  chain: DepositChain
  /** Raw 6-dp USDC units. */
  amountRaw: bigint
  /** Human USDC, e.g. "25.5". */
  amountUsd: string
}

/** USDC balances at `user`'s own address on every deposit chain — funds the
 * app otherwise never surfaces. Per-chain RPC failures read as 0 (public
 * RPCs flake; a missed chain shows up on the next scan). */
export async function scanStranded(user: string): Promise<StrandedFunds[]> {
  const balances = await Promise.all(
    DEPOSIT_CHAINS.map(async (chain) => {
      try {
        const client = createPublicClient({
          chain: VIEM_CHAINS[chain.chainId],
          transport: fallback([http(PUBLIC_RPC[chain.chainId]), http()]),
        })
        const amountRaw = await client.readContract({
          address: chain.usdc,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [user as `0x${string}`],
        })
        return { chain, amountRaw, amountUsd: formatUnits(amountRaw, 6) }
      } catch {
        return { chain, amountRaw: BigInt(0), amountUsd: "0" }
      }
    }),
  )
  return balances.filter((b) => b.amountRaw >= MIN_RECOVER_RAW)
}

export type RecoverPhase = "quoting" | "signing" | "filling" | "done"

/** Bridge the full stranded amount on `chain` into the user's HL account.
 * Throws WithdrawTrackableError (with the Relay requestId) once a signature
 * or transaction has been submitted — from that point the funds are moving
 * and must never be reported as a plain failure. */
export async function executeRecovery(
  wallet: ConnectedWallet,
  stranded: StrandedFunds,
  onProgress: (p: RecoverPhase) => void,
): Promise<{ requestId: string; receiveUsd: string }> {
  onProgress("quoting")
  const res = await fetch("/api/recover-quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user: wallet.address,
      chainId: stranded.chain.chainId,
      amount: stranded.amountRaw.toString(),
    }),
  })
  const data = (await res.json().catch(() => null)) as {
    message?: string
  } | null
  if (!res.ok || !data)
    throw new Error(data?.message ?? `Recovery quote failed (${res.status})`)
  const quote = parseRecoverQuote(data)

  onProgress("signing")
  let submitted = false
  try {
    for (const item of quote.items) {
      await executeItem(wallet, stranded.chain, item)
      submitted = true
      if (item.check) {
        onProgress("filling")
        await pollCheck(item.check.endpoint, quote.requestId)
      }
    }
  } catch (e) {
    if (submitted && !(e instanceof WithdrawTrackableError) && !isUserRejection(e))
      throw new WithdrawTrackableError(
        "Connection lost mid-recovery — the transfer may still be processing. Track it on Relay.",
        quote.requestId,
      )
    throw e
  }

  // Recovered funds credit the perps account; orders settle in spot — same
  // sweep DepositDialog does, best-effort (ensureSpotUsdc backstops it).
  sweepPerpsToSpot(wallet).catch(() => {})
  onProgress("done")
  return { requestId: quote.requestId, receiveUsd: quote.receiveUsd }
}

async function executeItem(
  wallet: ConnectedWallet,
  chain: DepositChain,
  item: RecoverItem,
) {
  const isEmbedded = wallet.walletClientType === "privy"
  if (item.kind === "signature") {
    // Sign Relay's EIP-712 payload VERBATIM (HANDOFF: re-domaining 400s).
    // The embedded wallet only signs at its active chain, so switch it to
    // the payload's domain chain first (headless — showWalletUIs:false).
    const domainChain = Number(
      (item.sign.domain as { chainId?: number | string }).chainId,
    )
    if (isEmbedded && Number.isFinite(domainChain))
      await wallet.switchChain(domainChain)
    const signer = await makeSigner(wallet)
    const signTyped = signer.signTypedData as (args: {
      domain: Record<string, unknown>
      types: Record<string, unknown>
      primaryType: string
      message: Record<string, unknown>
    }) => Promise<`0x${string}`>
    const signature = await signTyped({
      domain: item.sign.domain,
      types: item.sign.types,
      primaryType: item.sign.primaryType,
      message: item.sign.value,
    })
    // Signature rides as a QUERY PARAM, body untouched (same as withdraw).
    const postRes = await fetch(
      `${RELAY_API}${item.post.endpoint}?signature=${signature}`,
      {
        method: item.post.method || "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item.post.body),
      },
    )
    if (!postRes.ok) {
      const text = await postRes.text().catch(() => "")
      let msg: string | undefined
      try {
        msg = (JSON.parse(text) as { message?: string }).message
      } catch {}
      throw new Error(
        msg ?? `Relay rejected the recovery (${postRes.status}): ${text.slice(0, 300)}`,
      )
    }
    return
  }

  // Transaction step — needs origin-chain gas.
  const txChainId = item.tx.chainId ?? chain.chainId
  await wallet.switchChain(txChainId)
  const provider = await wallet.getEthereumProvider()
  const client = createWalletClient({
    account: wallet.address as `0x${string}`,
    chain: VIEM_CHAINS[txChainId],
    transport: custom(provider),
  })
  try {
    await client.sendTransaction({
      to: item.tx.to as `0x${string}`,
      data: item.tx.data as `0x${string}` | undefined,
      value: item.tx.value ? BigInt(item.tx.value) : undefined,
    })
  } catch (e) {
    if (isUserRejection(e)) throw e
    if (/insufficient funds|gas/i.test(e instanceof Error ? e.message : ""))
      throw new Error(
        `This recovery needs a little ${chain.name} gas in your wallet to submit. Contact support if you can't add gas.`,
      )
    throw e
  }
}

/** Poll a Relay check endpoint until the fill settles (same contract as the
 * withdraw poller: success | failure | refund, 90 s deadline). */
export async function pollCheck(endpoint: string, requestId: string, what = "recovery") {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    let status = ""
    try {
      const res = await fetch(`${RELAY_API}${endpoint}`, { cache: "no-store" })
      status = String(((await res.json()) as { status?: string }).status ?? "")
    } catch {
      /* transient poll error — keep trying until the deadline */
    }
    if (status === "success") return
    if (status === "failure" || status === "refund")
      throw new WithdrawTrackableError(
        status === "refund"
          ? `Relay refunded the ${what} to your origin-chain wallet — it will show up here again.`
          : `Relay reported the ${what} failed.`,
        requestId,
      )
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new WithdrawTrackableError(
    `Still processing — track the ${what} on Relay.`,
    requestId,
  )
}
