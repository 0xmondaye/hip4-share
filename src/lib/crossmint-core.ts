// Crossmint onramp checkout (docs.crossmint.com) — card in, USDC delivered
// on-chain to the user's own Solana pack wallet. Exactly Coinflow's slot: a
// funded wallet re-enters doPull at the skip-bridge check, nothing downstream
// changes. Pure logic only; no I/O.
//
// Economics differ from Coinflow: Crossmint's onramp is exact-in (the card is
// charged `amount`, fees come OUT of it, the remainder lands as USDC) and has
// no partner-fee field. So the card is charged the same displayed total
// (price + markup) and the markup headroom absorbs Crossmint's fee instead of
// settling to us. The server refuses the order when Crossmint's quoted
// guaranteed delivery doesn't cover the bare Slabz price.
// ponytail: house revenue on this rail is whatever fee headroom Crossmint
// doesn't eat — delivered to the USER as excess USDC, not to us. Revisit if
// Crossmint ships partner fees or a negotiated rate.

export const CROSSMINT_CLIENT_KEY = process.env.NEXT_PUBLIC_CROSSMINT_CLIENT_KEY ?? ""

const RAW_ENV = process.env.NEXT_PUBLIC_CROSSMINT_ENV ?? "staging"
/** Only the two envs we deploy against — anything else clamps to staging so a
 *  typo can never take real card payments. */
export const CROSSMINT_ENV: "production" | "staging" =
  RAW_ENV === "production" ? "production" : "staging"

/** Crossmint checkout exists only when the client key is configured. */
export const crossmintEnabled = CROSSMINT_CLIENT_KEY !== ""

export const CROSSMINT_API =
  CROSSMINT_ENV === "production" ? "https://www.crossmint.com" : "https://staging.crossmint.com"

/** USDC token locator for onramp orders — mainnet vs devnet mint. */
export const CROSSMINT_USDC_LOCATOR =
  CROSSMINT_ENV === "production"
    ? "solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    : "solana:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"

/** "12.34" → 12_340_000n (USDC has 6 decimals). Extra decimals truncate —
 *  conservative for a ≥ coverage check. Throws on non-numeric garbage so a
 *  malformed Crossmint quote fails closed instead of comparing as zero. */
export function usdcStrToUnits6(s: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim())
  if (!m) throw new Error(`bad USDC amount: ${s}`)
  return BigInt(m[1]) * BigInt(1_000_000) + BigInt((m[2] ?? "").slice(0, 6).padEnd(6, "0"))
}

/** Integer cents → "12.34" for Crossmint's USD `amount` field. */
export function centsToUsd(cents: number): string {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error("bad cents")
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`
}

/** Does Crossmint's guaranteed-minimum delivery (quote quantityRange
 *  lowerBound, a USDC decimal string) cover the bare Slabz price? Must match
 *  doPull's skip-bridge threshold or the resumed pull would bridge from HL on
 *  top of the card. */
export function coversPull(lowerBound: string, subtotalCents: number): boolean {
  return usdcStrToUnits6(lowerBound) >= BigInt(subtotalCents) * BigInt(10_000)
}
