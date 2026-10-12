// Pure helpers for the Relay deposit-address flow — no browser APIs, no
// network — so they run under node for tests (see relay-deposit.test.mjs).

export const HL_CHAIN_ID = 1337
export const HL_USDC = "0x00000000000000000000000000000000"

export interface DepositChain {
  chainId: number
  /** Full network name, used in safety copy ("Send USDC on Arbitrum One only"). */
  name: string
  /** Short label for the chain-selector pill. */
  label: string
  /** Native USDC contract on this chain (not USDC.e / bridged variants). */
  usdc: `0x${string}`
}

// Origin chains users can deposit from. A static allowlist by design: each
// entry needs a verified native-USDC address and safety copy, and which
// chains we expose is a product decision. All five verified against Relay
// /quote (keyless, useDepositAddress) on 2026-07-09. Non-EVM origins
// (Solana, Bitcoin) require a Relay API key — out of scope.
export const DEPOSIT_CHAINS: DepositChain[] = [
  {
    chainId: 42161,
    name: "Arbitrum One",
    label: "Arbitrum",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
  {
    chainId: 8453,
    name: "Base",
    label: "Base",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  {
    chainId: 1,
    name: "Ethereum",
    label: "Ethereum",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  {
    chainId: 10,
    name: "OP Mainnet",
    label: "Optimism",
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  },
  {
    chainId: 137,
    name: "Polygon",
    label: "Polygon",
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  },
]

export const DEFAULT_DEPOSIT_CHAIN = DEPOSIT_CHAINS[0]

// Our cut, in basis points, deducted from the user's deposit. 0 or missing
// recipient ⇒ no fee (dev default). NEXT_PUBLIC_ because the recipient is a
// public payout address and the bps shows in the UI.
export const APP_FEE_BPS = Math.max(
  0,
  Math.floor(Number(process.env.NEXT_PUBLIC_RELAY_FEE_BPS ?? 100)),
)
export const FEE_RECIPIENT = process.env.NEXT_PUBLIC_RELAY_FEE_RECIPIENT as
  | `0x${string}`
  | undefined

export function appFees() {
  return FEE_RECIPIENT && APP_FEE_BPS > 0
    ? [{ recipient: FEE_RECIPIENT, fee: String(APP_FEE_BPS) }]
    : undefined
}

/** Body for POST /quote minting an open deposit address on `chain`.
 * `subsidyCapUsdc` (USDC, 6-decimals string) turns on fee sponsorship: Relay
 * draws execution/relayer fees from our app balance instead of the user's
 * deposit (100 in → 100 out). Only honored when the quote carries our
 * x-api-key — keyless quotes silently ignore it (verified live 2026-07-18:
 * `subsidized` stays 0). The cap MUST be sent: omitting
 * maxSubsidizationAmount made Relay treat the cap as 0 (`capHit: true`,
 * sponsored $0, user ate the full $1.21 execution fee on a real 20.5 USDC
 * deposit, 2026-07-18) — and with deposit addresses a hit cap shifts ALL
 * fees to the user, no partial sponsorship. */
export function depositQuoteBody(
  user: string,
  chain: DepositChain,
  appFees?: { recipient: string; fee: string }[],
  subsidyCapUsdc?: string,
) {
  return {
    user,
    recipient: user,
    originChainId: chain.chainId,
    destinationChainId: HL_CHAIN_ID,
    originCurrency: chain.usdc,
    destinationCurrency: HL_USDC,
    // Representative size for the preview quote; an open deposit address
    // re-quotes per actual deposit, so this doesn't cap what they can send.
    amount: "100000000",
    tradeType: "EXACT_INPUT" as const,
    useDepositAddress: true,
    // Failed/too-small deposits refund here, on the origin chain.
    refundTo: user,
    ...(appFees?.length ? { appFees } : {}),
    ...(subsidyCapUsdc
      ? { subsidizeFees: true, maxSubsidizationAmount: subsidyCapUsdc }
      : {}),
  }
}
