// Display helpers for the /leaderboard page. The dashboard API returns raw
// Privy login identities (full emails, twitter handles) — privacy demands we
// never render those whole on a public page.

export type LeaderboardOwner = { type: string; id: string }

export type LeaderboardRow = {
  rank: number
  owner?: LeaderboardOwner
  address: string
  walletSource?: string
  tradeCount: number
  hip4VolumeUSDC: number
  totalValue?: number
}

export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/** Public display name: masked email/handle, else shortened wallet address. */
export function maskOwner(
  owner: LeaderboardOwner | undefined,
  address: string,
): string {
  if (owner?.id.includes("@") && owner.type !== "wallet") {
    const [local, domain] = owner.id.split("@")
    return `${local.slice(0, 2)}•••@${domain}`
  }
  if (owner?.type === "twitter") return `@${owner.id.slice(0, 2)}•••`
  return shortAddr(address)
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
})

export function formatVolume(n: number): string {
  return usd.format(n)
}

/** Next round goal strictly above n: 1/2/5 × power of ten, min $100 ($8k → $10k). */
export function nextGoal(n: number): number {
  for (let mag = 100; ; mag *= 10)
    for (const m of [1, 2, 5]) if (mag * m > n) return mag * m
}
