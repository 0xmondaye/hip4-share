"use client"

// /gacha is not a place any more — it's a doorway.
//
// It used to be a grid of pack tiles, so opening a pack cost two navigations:
// pick a family here, then pick a tier and pull over there. Everything the grid
// offered (families, tiers, prices, the free-open marking) now sits on the pack
// stage itself, visible without a tap — so this route just picks a pack and
// hands the user the stage, the way slabz.com opens straight onto the rip.
//
// The old free-entitlement lookup moved with it: the stage marks a free open on
// the tier it applies to, which is where the button is.

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { usePrivy } from "@privy-io/react-auth"
import { useWallets as useSolanaWallets } from "@privy-io/react-auth/solana"
import { listGifts, listPacks, SlabzError, NOT_CONFIGURED } from "@/lib/slabz"
import { pickPrivySolWallet } from "@/lib/gacha-bridge"
import { creditMatches, groupByFamily, packHidden } from "@/lib/gacha-core"
import { getFreeCredits } from "@/lib/gacha-quotes"

export default function GachaPage() {
  const router = useRouter()
  const [err, setErr] = useState<SlabzError | null>(null)
  const { authenticated, ready } = usePrivy()
  const { wallets: solWallets } = useSolanaWallets()
  const solWallet = pickPrivySolWallet(solWallets)
  // Catalog fetch starts on mount, not on Privy `ready` — it's public, and
  // gating it serialized Privy's hydration round trips in front of it.
  const [packsP] = useState(() => {
    if (typeof window === "undefined") return null
    const p = listPacks()
    p.catch(() => {}) // consumed in the effect; don't log unhandled on early unmount
    return p
  })

  useEffect(() => {
    // Wait for Privy before choosing: a free open should land the user on the
    // pack it can actually open, and both entitlement reads need auth. They
    // fail soft — a broken lookup costs a shortcut, never the store.
    if (!ready) return
    const free = authenticated
      ? Promise.all([
          getFreeCredits()
            .then((r) => r.credits)
            .catch(() => []),
          solWallet
            ? listGifts(solWallet.address)
                .then((gs) => gs.filter((g) => g.status === "confirmed" && g.packsRemaining > 0))
                .catch(() => [])
            : Promise.resolve([]),
        ])
      : Promise.resolve([[], []] as const)

    Promise.all([packsP ?? listPacks(), free])
      .then(([all, [credits, gifts]]) => {
        const active = all.filter((p) => p.isActive && !packHidden(p))
        const gifted = active.find((p) => gifts.some((g) => g.packId === p.id))
        const gift = gifted && gifts.find((g) => g.packId === gifted.id)
        if (gifted) return router.replace(`/gacha/${gifted.id}?gift=${gift!.giftId}`)
        const credited = active.find((p) => credits.some((c) => creditMatches(c, p.name)))
        // no entitlement: the first family's entry tier — cheapest way in
        const first = groupByFamily(active)[0]?.[0]
        const target = credited ?? first
        if (target) router.replace(`/gacha/${target.id}`)
        else setErr(new SlabzError("EMPTY", "No packs live right now. Check back soon.", 200))
      })
      .catch((e) => setErr(e instanceof SlabzError ? e : new SlabzError("UNKNOWN", String(e), 0)))
  }, [ready, authenticated, solWallet?.address, router, packsP])

  if (err) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-8 text-center text-sm text-muted-foreground">
        {err.code === NOT_CONFIGURED ? (
          <>
            Pack service isn&apos;t configured — set{" "}
            <code className="font-mono">SLABZ_API_KEY</code> in the server environment.
          </>
        ) : (
          <>Couldn&apos;t load packs: {err.message}</>
        )}
      </div>
    )
  }
  // Shaped like the stage it's about to become, not like a spinner.
  return (
    <div className="grid gap-4 lg:grid-cols-[240px_1fr] lg:gap-6">
      <div className="h-40 animate-pulse rounded-2xl border border-border bg-surface" />
      <div className="h-[42vh] min-h-64 animate-pulse rounded-2xl border border-border bg-surface lg:h-[58vh]" />
    </div>
  )
}
