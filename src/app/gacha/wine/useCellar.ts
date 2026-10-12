"use client"

// The Cellar's wiring — the on-chain wine gacha (InstantGacha.sol, HyperEVM)
// as a hook the pack stage drives. It used to be its own component with its
// own shelf grid, pull bar and reveal, rendered in the stage's centre track:
// a second storefront with a second design. Now the stage renders the Cellar
// EXACTLY as it renders a card pack — same 3D pack, same buy cluster, same rip
// → grading → reveal theater — and this file only knows about the chain.
//
// Flow: the player signs ONE EIP-3009 authorization (no gas, no approval, no
// transaction) over a Request that names their seed, an already-published
// drand round and the shelf they saw (`minAvailable`, `stockEpoch`); the house
// submits `openPack` and payment + bottles move in the same transaction —
// about one block. The house mixes in a seed from a pre-committed hash chain,
// so neither side can grind a value the other pinned first.
//
// No NEXT_PUBLIC_WINE_GACHA_ADDRESS => mock mode: same draw math (replayDraws
// mirrors the contract), fake shelf, fake quotes. Dev-only.

import { useCallback, useEffect, useState } from "react"
import { usePrivy, type ConnectedWallet } from "@privy-io/react-auth"
import { makeSigner } from "@/lib/privy-signer"
import { HL_USDC_EVM, moveUsdcToHyperEvm } from "@/lib/hl-exchange"
import { privyAuthHeaders } from "@/lib/privy-tokens"
import {
  ceilUsd,
  decodePrize,
  drawSeed,
  encodePrize,
  pickPayToken,
  publishedRound,
  randomSeed,
  receiveAuthTypedData,
  replayDraws,
  requestId,
  skuIdOf,
} from "@/lib/wine-core"
import {
  GACHA_ABI,
  readBalances,
  readOffer,
  readShelf,
  tokenDomain,
  WINE_CHAIN,
  WINE_GACHA_ADDRESS,
  wineConfigured,
  winePublicClient,
  type BottleOffer,
  type WineBalances,
  type WineShelf,
} from "@/lib/wine"
import { bottleImg, bottleName, mockQuote, mockShelf, WINE_BUYBACK_RATIO, wineTier } from "@/lib/wine-shelf"
import type { OpenedCard } from "@/lib/slabz"

export interface WinePrize {
  collection: `0x${string}`
  tokenId: string
  deferred?: boolean
}

export const prizeKey = (p: { collection: string; tokenId: string | bigint }) =>
  `${p.collection}:${p.tokenId}`

/** A bottle in the shape the stage's reveal already renders. The rarity is the
 *  tier of what the house will pay for it — the one honest signal (see
 *  wineTier) — and the value is the bottle's worth, i.e. that payout grossed
 *  back up from the 90% buyback (WINE_BUYBACK_RATIO). */
export function toCard(
  p: WinePrize,
  offer: BottleOffer | undefined,
  /** the live pull price the tier bands scale against; the mainnet price when unknown */
  pullUnits6?: bigint,
): OpenedCard {
  const q = offer?.priceUnits6
  return {
    nftMint: prizeKey(p),
    name: bottleName(p),
    rarity: wineTier(q, pullUnits6).label,
    insuredValueCents: q ? Math.round((ceilUsd(q) * 100) / WINE_BUYBACK_RATIO) : 0,
    imageUrl: bottleImg(p),
    autoSold: false,
    autoSoldCents: null,
  }
}

async function api<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { ...(await privyAuthHeaders()), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as T & {
    error?: { code?: string; message?: string }
  }
  if (!res.ok) {
    const err = new Error(json.error?.message ?? `HTTP ${res.status}`) as Error & { code?: string }
    err.code = json.error?.code ?? `HTTP_${res.status}`
    throw err
  }
  return json
}

export function useCellar(wallet: ConnectedWallet | undefined, enabled: boolean) {
  const { login } = usePrivy()
  const [shelf, setShelf] = useState<WineShelf | null>(null)
  const [shelfErr, setShelfErr] = useState<string | null>(null)
  // buyback quote per WINE (skuId) for the shelf on show — a quote covers a
  // whole wine, so one read per sku, not per bottle. Folds into the multicall.
  const [shelfOffers, setShelfOffers] = useState<Record<number, BottleOffer>>({})
  // pay-token balances on HyperEVM. null = not read yet (or no wallet); a
  // failed read stays null and the button reads "Checking balance…" until
  // the next successful read
  const [bal, setBal] = useState<WineBalances | null>(null)
  // "Move from balance" in flight: signing, then waiting for the bridge to land
  const [moving, setMoving] = useState<null | "signing" | "landing">(null)

  const loadShelf = useCallback(() => {
    if (!enabled) return
    if (!wineConfigured()) {
      const s = mockShelf()
      setShelf(s)
      setShelfOffers(
        Object.fromEntries(
          s.prizes.map((p) => [skuIdOf(p.tokenId), { priceUnits6: mockQuote(p.tokenId), sellable: true }]),
        ),
      )
      return
    }
    readShelf()
      .then((s) => {
        setShelf(s)
        const reps = new Map<number, (typeof s.prizes)[number]>()
        for (const p of s.prizes) if (!reps.has(skuIdOf(p.tokenId))) reps.set(skuIdOf(p.tokenId), p)
        return Promise.all(
          [...reps].map(async ([sku, p]) => [sku, await readOffer(p.collection, p.tokenId)] as const),
        )
          .then((rows) => setShelfOffers(Object.fromEntries(rows)))
          .catch(() => {}) // grades fall back to Entry; the shelf still shows
      })
      .catch((e) =>
        setShelfErr(
          // viem's "returned no data" = no code at the address: the deploy
          // hasn't landed on this network. Say that instead of pasting docs.
          /returned no data/.test(String(e?.message))
            ? `The Cellar's contract isn't live on ${WINE_CHAIN.name} yet.`
            : String(e?.shortMessage ?? e?.message ?? e),
        ),
      )
  }, [enabled])
  useEffect(loadShelf, [loadShelf])

  // Balance detection: which token can pay, and whether it can. Re-read on
  // every shelf load (a settle changes both).
  const loadBalances = useCallback(() => {
    if (!wallet || !wineConfigured() || !shelf) return
    readBalances(wallet.address as `0x${string}`, shelf.tokens)
      .then(setBal)
      .catch(() => {})
  }, [wallet, shelf])
  useEffect(loadBalances, [loadBalances])

  /** The pull. Signs (gasless), then POSTs; `onSigned` fires between the two
   *  so the stage can move from "signing" to "opening". Throws on failure —
   *  the stage owns the error surface. Resolves to the prizes.
   *
   *  The signature pins the pool: `epoch` (its contents — bumped by every deposit,
   *  sweep AND sellback) and `minAvailable` (its size — shrunk by every draw). Both
   *  used to come from the shelf read at page load, so pull → sell → pull failed
   *  every time (the sale bumped the epoch) and any other player's pull or sale in
   *  between did the same. Now: fresh pins read seconds before signing, size pinned
   *  only to what this pack draws, and ONE automatic re-sign when the pool still
   *  moved underneath — an embedded wallet re-signs headlessly. */
  async function play(count: number, onSigned: () => void): Promise<WinePrize[]> {
    try {
      return await playOnce(count, onSigned)
    } catch (e) {
      if ((e as { code?: string })?.code !== "STALE_SHELF") throw e
      loadShelf()
      return playOnce(count, onSigned)
    }
  }

  async function playOnce(count: number, onSigned: () => void): Promise<WinePrize[]> {
    if (!shelf) throw new Error("The shelf hasn't loaded yet — try again in a moment.")
    const seed = randomSeed()
    if (!wineConfigured()) {
      // mock: the contract's exact draw over the mock pool, random beacon and
      // house seed, behind a beat so the theater has something to wait on
      onSigned()
      const user = (wallet?.address ?? "0x0000000000000000000000000000000000000001") as `0x${string}`
      const pool = mockShelf().prizes.map((p) => encodePrize(p.collection, p.tokenId))
      const s = drawSeed(seed, randomSeed(), randomSeed(), BigInt(1), BigInt(Math.floor(Date.now() / 1000)))
      await new Promise((r) => setTimeout(r, 900))
      return replayDraws(s, user, pool, count).map((w) => {
        const d = decodePrize(w)
        return { collection: d.collection, tokenId: d.tokenId.toString() }
      })
    }
    if (!wallet) {
      login()
      throw new Error("Sign in to pull.")
    }
    const user = wallet.address as `0x${string}`
    // Fresh read, not the render-time snapshot: pull() may have just moved money into this
    // wallet, and the closure's `bal` predates it.
    const live = await readBalances(user, shelf.tokens).catch(() => bal)
    const pick = pickPayToken(shelf.tokens, live?.byToken ?? {}, count)
    if (!pick) throw new Error("No payment token is priced right now.")
    const payToken = pick.token
    const g = { address: WINE_GACHA_ADDRESS as `0x${string}`, abi: GACHA_ABI } as const
    const c = winePublicClient()
    // one multicall: the token's domain plus the pins, read NOW rather than at page load
    const [domain, epoch] = await Promise.all([
      tokenDomain(payToken.address),
      c.readContract({ ...g, functionName: "stockEpoch" }),
    ])
    const validBefore = Math.floor(Date.now() / 1000) + 3600
    // the pool the player is drawing from, and a beacon that already exists —
    // all of it signature-bound through the nonce
    const req = {
      user, payToken: payToken.id, count, userSeed: seed,
      minAvailable: count, epoch, round: publishedRound(Date.now()),
    }
    // Embedded wallets sign only at their active chain (HANDOFF) — switch
    // first, headless. External wallets sign any domain.
    if (wallet.walletClientType === "privy") await wallet.switchChain(WINE_CHAIN.id)
    const signer = await makeSigner(wallet)
    const typed = receiveAuthTypedData({
      domain,
      from: user,
      to: WINE_GACHA_ADDRESS as `0x${string}`,
      value: payToken.priceUnits6 * BigInt(count),
      validAfter: BigInt(0),
      validBefore: BigInt(validBefore),
      nonce: requestId(req),
    })
    const signature = await (
      signer.signTypedData as (a: typeof typed) => Promise<`0x${string}`>
    )(typed)
    onSigned()
    const out = await api<{ prizes: WinePrize[] }>("/api/wine/play", {
      ...req,
      round: req.round.toString(),
      validBefore,
      signature,
    })
    loadShelf()
    return out.prizes
  }

  /** Live buyback quotes for won bottles — one multicall. The quotes drive
   *  the grade, so they are read before the first card turns. A failed read
   *  grades everything Entry, the calm treatment. */
  async function offersFor(prizes: WinePrize[]): Promise<Record<string, BottleOffer>> {
    if (!wineConfigured())
      return Object.fromEntries(
        prizes.map((p) => [prizeKey(p), { priceUnits6: mockQuote(BigInt(p.tokenId)), sellable: true }]),
      )
    return Promise.all(
      prizes.map(async (p) => [prizeKey(p), await readOffer(p.collection, BigInt(p.tokenId))] as const),
    )
      .then((rows) => Object.fromEntries(rows))
      .catch(() => ({}))
  }

  // The HL balance can fund the wallet only when the shelf's USDC IS the token
  // the Core→EVM bridge delivers — mainnet native USDC. Anywhere else the
  // button would move money to a token the contract doesn't take.
  const usdcToken = shelf?.tokens.find((t) => t.id === 0)
  const fundable =
    WINE_CHAIN.id === 999 &&
    !!usdcToken &&
    usdcToken.address.toLowerCase() === HL_USDC_EVM.toLowerCase()

  /** Bridge `short` (6dp) of USDC from the HL balance to the HyperEVM wallet,
   *  then poll until the balance covers it (≤30s). Throws on failure. */
  async function moveFromBalance(short: bigint) {
    if (!wallet || !shelf || short === BigInt(0)) return
    const need = ceilUsd(short)
    const target = (bal?.byToken[0] ?? BigInt(0)) + short
    try {
      setMoving("signing")
      await moveUsdcToHyperEvm(wallet, need)
      setMoving("landing")
      // the bridge is a system tx ~2s out; poll until the balance covers the
      // pull or give up after 30s and leave the line for the user to read
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 2000))
        const b = await readBalances(wallet.address as `0x${string}`, shelf.tokens).catch(() => null)
        if (!b) continue
        setBal(b)
        if ((b.byToken[0] ?? BigInt(0)) >= target) break
      }
    } finally {
      setMoving(null)
    }
  }

  // what one pull costs right now, off the chain — the price on the button and the
  // scale the tier bands grade against. Same in every pay token by deploy convention.
  const pullUnits6 = shelf?.tokens.find((t) => t.priceUnits6 > BigInt(0))?.priceUnits6

  return {
    shelf,
    pullUnits6,
    loadShelf,
    shelfErr,
    shelfOffers,
    bal,
    moving,
    fundable,
    play,
    offersFor,
    moveFromBalance,
  }
}
