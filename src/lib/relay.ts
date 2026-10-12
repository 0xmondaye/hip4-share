"use client"

// Relay (relay.link) Deposit Address flow: the user sends USDC on any of
// several origin chains (Arbitrum, Base, Ethereum, OP Mainnet, Polygon) to
// a Relay-generated address (e.g. a CEX withdrawal) and Relay auto-bridges it
// into their Hyperliquid account — no wallet, no signing. Built for users who
// aren't comfortable with self-custody bridging.
//
// Address minting goes through our /api/deposit-address route so the quote
// can carry the secret RELAY_API_KEY (fee sponsorship: relayer fees draw from
// our app balance, user gets in = out). Status polling stays keyless/direct.
// Deposits carry NO app fee (1:1 policy); APP_FEE_BPS/appFees are re-exported
// for the withdraw flow, where fees accrue to FEE_RECIPIENT's off-chain USDC
// balance on Relay — see https://docs.relay.link/features/app-fees.
import { APP_FEE_BPS, appFees, type DepositChain } from "./relay-deposit-core"

export { APP_FEE_BPS, appFees }

const RELAY_API = "https://api.relay.link"

// Advisory only — deposits are pushed to the address, so we can't block a
// small send; below this the fee/relayer cost makes it uneconomic.
export const MIN_DEPOSIT_USD = Math.max(
  1,
  Math.floor(Number(process.env.NEXT_PUBLIC_MIN_DEPOSIT_USD ?? 5)),
)

export interface DepositAddress {
  address: `0x${string}`
  feeBps: number
  feePct: string
  minUsd: number
  /** Relayer fees drawn from our app balance — user receives in = out. */
  sponsored: boolean
}

// Cache per (user, chain) so a returning user sees a stable address per
// chain. A fresh /quote mints a new open address each call; old ones keep
// working, but we want to show one consistent address per chain and track
// deposits to it. Deposits carry no app fee (1:1 policy), so fee config is
// no longer part of the key.
// ponytail: server-side RELAY_API_KEY changes don't bust this cache — bump
// the "relay-dep4" prefix if sponsorship config ever flips in prod.
// (dep3→dep4: dep3 addresses were minted without maxSubsidizationAmount,
// which Relay treats as cap 0 = zero sponsorship.)
function cacheKey(user: string, chainId: number) {
  return `relay-dep4:${user.toLowerCase()}:${chainId}`
}

/** Purge cached addresses from older prefixes (dep..dep3 were minted with
 * zero/no sponsorship — deposits to them lose the ~$1.21 execution fee). */
function purgeStaleAddresses() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k && /^relay-dep(:|2:|3:)/.test(k)) localStorage.removeItem(k)
    }
  } catch {
    /* private mode or SSR — nothing cached anyway */
  }
}
purgeStaleAddresses()

/** Get (or create + cache) the user's {chain}→Hyperliquid deposit address. */
export async function getDepositAddress(
  user: string,
  chain: DepositChain,
): Promise<DepositAddress> {
  // Deposits are fee-free by policy: no app fee, and with RELAY_API_KEY set
  // the relayer fees are sponsored too (100 in = 100 out).
  const meta = { feeBps: 0, feePct: "0", minUsd: MIN_DEPOSIT_USD }

  const cached =
    typeof localStorage !== "undefined"
      ? localStorage.getItem(cacheKey(user, chain.chainId))
      : null
  if (cached) {
    try {
      const c = JSON.parse(cached) as { address?: string; sponsored?: boolean }
      if (c.address && /^0x[0-9a-fA-F]{40}$/.test(c.address))
        return {
          address: c.address as `0x${string}`,
          sponsored: Boolean(c.sponsored),
          ...meta,
        }
    } catch {
      /* stale/corrupt entry — fall through and re-mint */
    }
  }

  const res = await fetch("/api/deposit-address", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, chainId: chain.chainId }),
  })
  const data = (await res.json()) as {
    address?: string
    sponsored?: boolean
    message?: string
  }
  if (!res.ok) throw new Error(data.message ?? `Relay quote failed (${res.status})`)
  const { address, sponsored = false } = data
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address))
    throw new Error("Relay did not return a deposit address")
  try {
    localStorage.setItem(
      cacheKey(user, chain.chainId),
      JSON.stringify({ address, sponsored }),
    )
  } catch {
    /* private mode — address still returned, just not cached */
  }
  return { address: address as `0x${string}`, sponsored, ...meta }
}

import type { DepositActivity } from "./relay-activity"
export type { DepositActivity }

/**
 * Recent deposits detected at this address, for live status in the dialog.
 *
 * Goes through OUR route, not Relay directly. Relay's /requests/v2 is deprecated
 * (throttled from 2026-09-01, retired 2026-11-24) and its replacement made
 * `x-api-key` mandatory — so a browser fetch is no longer possible at all,
 * because RELAY_API_KEY is server-only. The route holds the key and does the
 * v3 parse; see src/app/api/deposit-activity/route.ts.
 *
 * Still fails soft (returns []): a status list must never break the dialog. The
 * difference is that the SERVER now logs the failure — the old silent [] on the
 * client is exactly how a deprecation this size went unnoticed.
 */
export async function getDepositActivity(address: string): Promise<DepositActivity[]> {
  try {
    const res = await fetch(`/api/deposit-activity?address=${address}`, { cache: "no-store" })
    if (!res.ok) return []
    return ((await res.json()) as { activity?: DepositActivity[] }).activity ?? []
  } catch {
    return []
  }
}
