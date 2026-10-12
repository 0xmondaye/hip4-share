// Daimo Pay onramp (docs.daimo.com) — card, Apple Pay, bank rails, exchanges
// or crypto from ~13 chains in, USDC delivered straight into the user's
// Hyperliquid account. Sits beside the Relay deposit address in
// DepositDialog: same destination, a different way in for users who have no
// crypto to send. Pure logic only; no I/O.
//
// How it reaches HyperCore: Daimo delivers USDC on HyperEVM to their
// Hypercore deposit adapter, whose `deposit(recipient, destinationDex)` call
// forwards it into HyperCore via Hyperliquid's CoreDepositWallet.
// See https://docs.daimo.com/advanced/hyperliquid.

/** Daimo is MAINNET-ONLY (no sandbox/testnet) and its own API key is the
 *  gate, so the button is a plain env flag. */
export const daimoEnabled = process.env.NEXT_PUBLIC_DAIMO_ENABLED === "1"

export const DAIMO_API = "https://api.daimo.com"

/** HyperEVM — Daimo's delivery chain for HyperCore deposits. */
export const HYPEREVM_CHAIN_ID = 999
export const HYPEREVM_USDC = "0xb88339CB7199b77E23DB6E890353E22632Ba630f"

/** Daimo's Hypercore deposit adapter (docs.daimo.com/advanced/hyperliquid). */
export const HYPERCORE_DEPOSIT_ADAPTER = "0x3Df610B9168472EfC3CD37ed5005c0e78946c308"

/** Which HyperCore book the funds land in. The app normalises everything to
 *  spot (deposits via Relay credit perps and get swept — see
 *  hl-exchange.sweepPerpsToSpot), so delivering straight to spot skips the
 *  sweep and the user signature it needs. */
const DEX_SPOT = 4294967295 // 0xFFFFFFFF; 0 would be perps

/** `deposit(address,uint32)` calldata for the adapter. Selector verified with
 *  viem's toFunctionSelector; both args are static words, so hand-padding
 *  beats pulling an ABI encoder into this module.
 *  ponytail: hardcoded selector — regenerate if the adapter ABI ever changes. */
export function hypercoreDepositCalldata(recipient: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw new Error("bad recipient")
  const addr = recipient.slice(2).toLowerCase().padStart(64, "0")
  const dex = DEX_SPOT.toString(16).padStart(64, "0")
  return `0xdd1d708b${addr}${dex}`
}

/** Daimo's hosted checkout for an inline iframe. `layout=embed` renders the
 *  picker as page content and posts `contentHeightChanged`, which DaimoDeposit
 *  uses to size the frame; `center` would fill a fixed-height frame instead.
 *  The clientSecret is per-session and safe in a URL — it can only set this
 *  session's payment method and read its status. */
export const daimoWebviewUrl = (sessionId: string, clientSecret: string) =>
  `https://daimo.com/webview?session=${encodeURIComponent(sessionId)}&cs=${encodeURIComponent(clientSecret)}&layout=embed&theme=dark`
