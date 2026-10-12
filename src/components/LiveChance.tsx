"use client"

import { midOf, useLiveMids } from "@/lib/useLiveMids"

/**
 * Header "Yes chance". Per HIP-4 the contract price *is* the implied
 * probability, and allMids is the book mid (last trade only when the book is
 * empty) — the same number the chance chart holds its tail to.
 */
export function LiveChance({
  coin,
  initial, // server-rendered mid, so the first paint isn't a dash
}: {
  coin: string
  initial: number | null
}) {
  const { mids } = useLiveMids({})
  const mid = midOf(mids, coin) ?? initial
  return <>{mid !== null ? `${Math.floor(mid * 100)}%` : "—"}</>
}
