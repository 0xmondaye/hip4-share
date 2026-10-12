"use client"

// The user's OTHER balance. Hyperliquid gives one key two ledgers at the same address:
// HyperCore (the trading balance the header has always shown) and HyperEVM (an ordinary
// EVM wallet). Cellar pulls are paid from the EVM side and sellbacks are paid TO it, so a
// player who sells a bottle sees the money "vanish" if only Core is on screen. This module
// reads the EVM side and moves USDC across it; hl-exchange.ts owns the Core→EVM direction.
//
// ponytail: mainnet only. Native USDC exists on HyperEVM 999 alone, and on testnet the
// wine pay token is a mock nothing bridges to — readers return zeros there.

import type { ConnectedWallet } from "@privy-io/react-auth"
import { createPublicClient, createWalletClient, custom, encodeFunctionData, http, maxUint256, parseGwei, type Account, type PublicClient, type Transport, type WalletClient } from "viem"
import { hyperEvm } from "viem/chains"
import { CORE_DEPOSIT_WALLET, HL_USDC_EVM } from "./hl-exchange"
import { WINE_RPC_PROXY } from "./wine"
import { privyAuthHeaders } from "./privy-tokens"

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const

/** Circle's CoreDepositWallet: `deposit(amount, 4294967295)` pulls native USDC from the caller and
 *  credits the same address's HyperCore spot balance (HANDOFF "Funding from the HL balance"). */
const DEPOSIT_ABI = [
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint32" }], outputs: [] },
] as const
const DEPOSIT_DEX_SPOT = 4294967295 // uint32 max — the "spot, no perp dex" sentinel

export const HYPEREVM_CHAIN = hyperEvm
export const HYPEREVM_ENABLED = process.env.NEXT_PUBLIC_WINE_CHAIN === "mainnet"

let client: PublicClient | undefined
function evmClient(): PublicClient {
  // Through the same-origin relay, so these reads ride the paid RPC and not the public one
  // that rate-limits the header poll.
  client ??= createPublicClient({ chain: hyperEvm, transport: http(WINE_RPC_PROXY) })
  return client
}

export interface HyperEvmFunds {
  /** native USDC, 6dp */
  usdc: bigint
  /** HYPE, wei — gas for anything sent from this side */
  hype: bigint
}

export async function readHyperEvmFunds(user: `0x${string}`): Promise<HyperEvmFunds> {
  if (!HYPEREVM_ENABLED) return { usdc: BigInt(0), hype: BigInt(0) }
  const c = evmClient()
  const [usdc, hype] = await Promise.all([
    c.readContract({ address: HL_USDC_EVM, abi: ERC20_ABI, functionName: "balanceOf", args: [user] }),
    c.getBalance({ address: user }),
  ])
  return { usdc, hype }
}

/** "12.34" from 6dp units. */
export const usd6 = (units: bigint) => (Number(units) / 1e6).toFixed(2)

/** Parse a dollar string the user typed into 6dp units; null when it is not a number. */
export function parseUsd6(s: string): bigint | null {
  const m = s.trim().match(/^\$?(\d+)(?:\.(\d{1,6}))?$/)
  if (!m) return null
  return BigInt(m[1]) * BigInt(1_000_000) + BigInt((m[2] ?? "").padEnd(6, "0"))
}

const CHAIN_HEX = `0x${hyperEvm.id.toString(16)}`

/** Put the wallet's PROVIDER on HyperEVM and prove it before anything is signed.
 *
 *  `wallet.switchChain` alone was not enough: a guest on chain 1 got viem's "current chain of
 *  the wallet (id: 1) does not match the target chain (id: 999)" AFTER we had called it — Privy
 *  updates its own record, the provider underneath follows asynchronously (embedded), or the
 *  external wallet has to add the chain first (4902) and only then switch. So: ask the provider
 *  what chain it is on, switch at the provider level if needed (adding HyperEVM to a wallet
 *  that lacks it), and poll eth_chainId until it says 999. viem's guard stays on — it is what
 *  kept that guest from broadcasting a HyperEVM transfer onto Ethereum. */
async function putProviderOnHyperEvm(wallet: ConnectedWallet) {
  await wallet.switchChain(hyperEvm.id).catch(() => {}) // Privy's own bookkeeping; the provider is the arbiter
  const provider = await wallet.getEthereumProvider()
  const current = async () => Number(await provider.request({ method: "eth_chainId" }))
  if ((await current()) !== hyperEvm.id) {
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] })
    } catch (e) {
      const code = (e as { code?: number })?.code
      const msg = e instanceof Error ? e.message : String(e)
      if (code !== 4902 && !/unrecognized|not added|unknown chain|4902/i.test(msg)) throw e
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: CHAIN_HEX,
            chainName: hyperEvm.name,
            nativeCurrency: hyperEvm.nativeCurrency,
            rpcUrls: hyperEvm.rpcUrls.default.http,
            blockExplorerUrls: hyperEvm.blockExplorers ? [hyperEvm.blockExplorers.default.url] : undefined,
          },
        ],
      })
    }
    for (let i = 0; i < 20 && (await current()) !== hyperEvm.id; i++) await new Promise((r) => setTimeout(r, 250))
    if ((await current()) !== hyperEvm.id)
      throw new Error("Your wallet is still on another network. Switch it to HyperEVM (chain 999) and try again.")
  }
  return provider
}

/** Run `fn` with a wallet client on HyperEVM, then leave the wallet on the chain we found it.
 *  hl-exchange derives signatureChainId from `wallet.chainId`, which is a stale snapshot inside
 *  the caller's closure right after a switch -- so an HL action that follows this move would
 *  sign for the old chain while the embedded wallet insists on the new one. Switching back
 *  keeps snapshot and reality equal. */
async function onHyperEvm<T>(
  wallet: ConnectedWallet,
  fn: (w: WalletClient<Transport, typeof hyperEvm, Account>) => Promise<T>,
): Promise<T> {
  const embedded = wallet.walletClientType === "privy"
  const prevChain = Number(wallet.chainId.split(":").pop())
  const provider = await putProviderOnHyperEvm(wallet)
  const w = createWalletClient({ account: wallet.address as `0x${string}`, chain: hyperEvm, transport: custom(provider) })
  try {
    return await fn(w)
  } finally {
    // Embedded only: an external wallet's user would get a second switch prompt for nothing.
    if (embedded && Number.isFinite(prevChain) && prevChain !== hyperEvm.id)
      await wallet.switchChain(prevChain).catch(() => {}) // best effort; a stale switch is not a failed move
  }
}

// Same lesson as the settler: HyperEVM's base fee swings between block types, and a cap
// estimated a moment ago is rejected at submit. The cap is a ceiling, not the price paid.
const FEES = { maxFeePerGas: parseGwei("5"), maxPriorityFeePerGas: parseGwei("0.1") }
/** FEES, lifted to 3x the live base fee when a spike takes it past the fixed cap (wine.ts fees()). */
async function feesNow() {
  const base = await evmClient().getBlock().then((b) => b.baseFeePerGas ?? BigInt(0)).catch(() => BigInt(0))
  const spike = base * BigInt(3)
  return spike > FEES.maxFeePerGas ? { ...FEES, maxFeePerGas: spike } : FEES
}

/** HYPE a wallet must keep back so the send itself clears at the fee cap: a Relay deposit call
 *  is ~33k gas, a plain transfer 21k; 200k covers either with room. = 0.001 HYPE, which is also
 *  the settler's refill threshold (half a 0.002 top-up) — so a Max send leaves the wallet at
 *  exactly "enough", and Send HYPE → refill → Send HYPE cannot be looped to drain the settler. */
export const HYPE_GAS_RESERVE_WEI = FEES.maxFeePerGas * BigInt(200_000)

const NO_HYPE = "Your wallet has no HYPE for gas right now. Try again in a moment."

/** Wait for the receipt and refuse a reverted one — waitForTransactionReceipt resolves either way,
 *  and a reverted move must not read as "sent" to the caller polling for its credit. */
async function mined(hash: `0x${string}`) {
  const r = await evmClient().waitForTransactionReceipt({ hash })
  if (r.status !== "success") throw new Error(`The transaction was rejected on-chain (${hash.slice(0, 10)}…). Nothing was moved.`)
  return r
}

/** True only for a genuine can't-pay-for-gas failure, anywhere in the cause chain. NOT a bare
 *  /gas/ match: viem's estimateGas and fee-cap errors all say "gas", and for a while every one of
 *  them was reported to the guest as "no HYPE" — while their wallet had plenty. */
function isInsufficientFunds(e: unknown) {
  for (let c: unknown = e; c instanceof Error; c = c.cause)
    if (c.name === "InsufficientFundsError" || /insufficient funds|exceeds the balance/i.test(c.message)) return true
  return false
}

/** Everything a send needs, read through OUR paid RPC — gas, nonce, fee cap — so the wallet's
 *  provider (viem's default for chain 999 is the public RPC that rate-limits) is asked for
 *  exactly one thing: the broadcast. Also checks the wallet can pay, waiting briefly for a
 *  top-up that may still be propagating, and says so plainly if it cannot. */
async function prepare(
  from: `0x${string}`,
  tx: { to: `0x${string}`; data?: `0x${string}`; value?: bigint },
  topup?: string | null,
) {
  const pub = evmClient()
  const fees = await feesNow()
  // The estimate MUST succeed. For the two things sent from here (an ERC-20 transfer, a Relay
  // deposit call) a failed estimate means the call would revert; a fallback gas figure would
  // send it anyway, burn the gas, and leave the caller waiting for a credit that never comes.
  // One retry for a flaky RPC, then the revert reason goes to the guest.
  const gas = await pub.estimateGas({ account: from, ...tx }).catch(async (e1) => {
    await new Promise((r) => setTimeout(r, 1000))
    return pub.estimateGas({ account: from, ...tx }).catch((e2: unknown) => {
      const m = e2 instanceof Error ? e2.message : String(e1)
      throw new Error(`This transfer would fail: ${m.split("\n")[0].slice(0, 200)}`, { cause: e2 })
    })
  })
  const gasCost = gas * fees.maxFeePerGas
  const need = gasCost + (tx.value ?? BigInt(0))
  let bal = await pub.getBalance({ address: from })
  for (let i = 0; i < 5 && bal < need; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    bal = await pub.getBalance({ address: from }).catch(() => bal)
  }
  if (bal < need)
    throw new Error(
      // Sending HYPE itself: the wallet has HYPE, just not amount + gas at the live cap (a
      // base-fee spike past the reserve). Anything else: genuinely no gas.
      tx.value && bal >= gasCost
        ? "Not enough HYPE left for gas after that amount. Lower the amount a little and try again."
        : topup ? `${NO_HYPE} (gas top-up: ${topup})` : NO_HYPE,
    )
  const nonce = await pub.getTransactionCount({ address: from, blockTag: "pending" })
  return { ...tx, gas, nonce, ...fees }
}

/** Send native USDC from the user's HyperEVM wallet to any address on HyperEVM. Costs HYPE gas
 *  from the same wallet. Resolves to the tx hash once mined. */
export async function sendUsdcOnHyperEvm(
  wallet: ConnectedWallet,
  to: `0x${string}`,
  units6: bigint,
  topup?: string | null,
) {
  if (units6 <= BigInt(0)) throw new Error("amount must be positive")
  return onHyperEvm(wallet, async (w) => {
    const req = await prepare(
      wallet.address as `0x${string}`,
      { to: HL_USDC_EVM, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, units6] }) },
      topup,
    )
    let hash: `0x${string}`
    try {
      hash = await w.sendTransaction(req)
    } catch (e) {
      if (isInsufficientFunds(e)) throw new Error(topup ? `${NO_HYPE} (gas top-up: ${topup})` : NO_HYPE, { cause: e })
      throw e
    }
    await mined(hash)
    return hash
  })
}

/** Send native HYPE from the user's HyperEVM wallet to any address on HyperEVM. Gas comes out of
 *  the same HYPE, so callers cap the amount at balance − HYPE_GAS_RESERVE_WEI. */
export async function sendHypeOnHyperEvm(wallet: ConnectedWallet, to: `0x${string}`, wei: bigint) {
  if (wei <= BigInt(0)) throw new Error("amount must be positive")
  return onHyperEvm(wallet, async (w) => {
    const hash = await w.sendTransaction(await prepare(wallet.address as `0x${string}`, { to, value: wei }))
    await mined(hash)
    return hash
  })
}

/** Submit an arbitrary transaction (a Relay deposit step) from the user's HyperEVM wallet with
 *  our fee caps, and wait for it to mine. */
export async function sendTxOnHyperEvm(
  wallet: ConnectedWallet,
  tx: { to: `0x${string}`; data?: `0x${string}`; value?: bigint },
) {
  return onHyperEvm(wallet, async (w) => {
    const hash = await w.sendTransaction(await prepare(wallet.address as `0x${string}`, tx))
    await mined(hash)
    return hash
  })
}

/** Ask the house to drop gas HYPE into the user's wallet when it is running low. Best effort —
 *  the send that follows is the arbiter — but never silent: resolves null when the route
 *  answered OK, else a short reason that rides in the eventual error so support can read WHY
 *  ("gas top-up: 503 NOT_CONFIGURED") instead of guessing. */
async function ensureGas(user: `0x${string}`): Promise<string | null> {
  const res = await fetch("/api/gas-topup", {
    method: "POST",
    headers: { ...(await privyAuthHeaders()), "Content-Type": "application/json" },
    body: JSON.stringify({ address: user }),
  }).catch(() => null)
  if (!res) return "unreachable"
  if (res.ok) return null
  const j = (await res.json().catch(() => ({}))) as { error?: { code?: string } }
  return `${res.status}${j.error?.code ? ` ${j.error.code}` : ""}`
}

/** HyperEVM → HyperCore for native USDC. NOT a transfer to the system address: Circle has
 *  blacklisted `0x2000…0000` in the USDC contract (live 2026-09-06, "Blacklistable: account is
 *  blacklisted"), because a Transfer to it would credit nothing — Core USDC's linked evmContract is
 *  Circle's CoreDepositWallet, not the token. The real path is approve + `deposit(amount, max)` on
 *  that wallet; the credit lands in the same address's spot balance a few seconds later.
 *  Gas is sponsored: the user never has to buy HYPE to get their own USDC out. Approval is
 *  unlimited and once, so every later move is one transaction. */
export async function moveUsdcToHyperCore(wallet: ConnectedWallet, units6: bigint) {
  if (units6 <= BigInt(0)) throw new Error("amount must be positive")
  const from = wallet.address as `0x${string}`
  const topup = await ensureGas(from)
  const allowance = await evmClient().readContract({
    address: HL_USDC_EVM,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [from, CORE_DEPOSIT_WALLET],
  })
  return onHyperEvm(wallet, async (w) => {
    const send = async (tx: { to: `0x${string}`; data: `0x${string}` }) => {
      const req = await prepare(from, tx, topup)
      let hash: `0x${string}`
      try {
        hash = await w.sendTransaction(req)
      } catch (e) {
        if (isInsufficientFunds(e)) throw new Error(topup ? `${NO_HYPE} (gas top-up: ${topup})` : NO_HYPE, { cause: e })
        throw e
      }
      await mined(hash)
      return hash
    }
    if (allowance < units6)
      await send({
        to: HL_USDC_EVM,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [CORE_DEPOSIT_WALLET, maxUint256] }),
      })
    return send({
      to: CORE_DEPOSIT_WALLET,
      data: encodeFunctionData({ abi: DEPOSIT_ABI, functionName: "deposit", args: [units6, DEPOSIT_DEX_SPOT] }),
    })
  })
}
