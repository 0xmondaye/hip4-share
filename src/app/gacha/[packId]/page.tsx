"use client"

import Link from "next/link"
import { bottlesOwned, readOffer, signSellAuthorization, wineConfigured, type BottleOffer } from "@/lib/wine"
import { ceilUsd, pickPayToken, skuIdOf } from "@/lib/wine-core"
import { prizeKey, toCard, useCellar } from "@/app/gacha/wine/useCellar"
import { privyAuthHeaders } from "@/lib/privy-tokens"
import { explainSignError } from "@/lib/sign-error"
import { Fragment, use, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { usePrivy, useWallets } from "@privy-io/react-auth"
import {
  useCreateWallet,
  useSignMessage,
  useSignTransaction,
  useWallets as useSolanaWallets,
  type ConnectedStandardSolanaWallet,
} from "@privy-io/react-auth/solana"
import {
  b64ToBytes,
  bytesToB64,
  bulkPurchasePacks,
  buybackQuote,
  getGift,
  getPack,
  getPackCards,
  getTransaction,
  listPacks,
  listTransactions,
  openPack,
  purchasePack,
  submitSigned,
  usd,
  usdWhole,
  NOT_CONFIGURED,
  SlabzError,
  type Gift,
  type OpenedCard,
  type Pack,
  type PackCard,
  type SlabzTx,
} from "@/lib/slabz"
import {
  creditMatches,
  displayCents,
  freeState,
  groupByFamily,
  heldCards,
  nextPullAction,
  packCategory,
  packFamily,
  packHidden,
  rarityText,
  SELLBACK_WINDOW_H,
  type FreeCredit,
  type PullJournal,
} from "@/lib/gacha-core"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import { GetHelp } from "@/components/GetHelp"
import { HoldToSell } from "@/components/gacha/HoldToSell"
import { PackFooter } from "@/components/gacha/PackFooter"
import { GradingReveal } from "@/components/gacha/GradingReveal"
import { UrFlare } from "@/components/gacha/UrFlare"
import {
  claimFreeCredit,
  getFreeCredits,
  getPayinQuote,
  GachaApiError,
} from "@/lib/gacha-quotes"
import {
  bridgeBackToBalance,
  claimGiftPack,
  pickPrivySolWallet,
  relayStatus,
  sellToSlabz,
  takeMoneyLock,
  SellSettlingError,
  SoldBridgePendingError,
  SOLANA_CHAIN,
  type SignSolanaMessage,
  type SignSolanaTx,
} from "@/lib/gacha-bridge"
import { coreAssetsOwned, usdcUnits6 } from "@/lib/solana-client"
import { getBalanceParts } from "@/lib/hyperliquid"
import { coverPerpsFromSpot } from "@/lib/hl-exchange"
import { HYPEREVM_ENABLED, moveUsdcToHyperCore, readHyperEvmFunds } from "@/lib/hyperevm-funds"
import {
  executeWithdraw,
  isUserRejection,
  WithdrawTrackableError,
} from "@/lib/relay-withdraw"
import nextDynamic from "next/dynamic"
import { coinflowEnabled } from "@/lib/coinflow-core"
import { crossmintEnabled } from "@/lib/crossmint-core"

// Which processor runs a card charge is OUR decision, not a checkout question.
// Both rails buy the identical pack, so two "Pay with card (Coinflow)" /
// "(Crossmint)" buttons only asked the user to pick between two words they
// have no basis to choose between. Coinflow first when both flags are on.
// Turbo means Slabz auto-sells the pull for USDC instead of minting the NFT, so
// it must never be applied silently — this is what the user is asked to accept.
const TURBO_CONSENT =
  "This pack is out of card stock. Pulling now pays out in USDC instead of a graded card."

const CARD_RAIL = coinflowEnabled ? "coinflow" : crossmintEnabled ? "crossmint" : null

// Coinflow + its @solana/web3.js peer load only when the card dialog opens
const CardCheckout = nextDynamic(
  () => import("@/components/gacha/CardCheckout").then((m) => m.CardCheckout),
  { ssr: false },
)
// Crossmint SDK loads only when its card dialog opens
const CrossmintCheckout = nextDynamic(
  () => import("@/components/gacha/CrossmintCheckout").then((m) => m.CrossmintCheckout),
  { ssr: false },
)
// three.js (~700KB of route chunk) rides with PackRip/packModel — split out so
// the page shell paints and prices are tappable while the 3D stage streams in
const PackRip = nextDynamic(() => import("@/components/gacha/PackRip"), { ssr: false })
const prebuildPack = (ccPackType?: string | null) =>
  import("@/components/gacha/packModel").then((m) => m.prebuildPack(ccPackType))

/** cac's reveal visuals key off a 1–5 tier ladder (C·U·R·SR·UR); Slabz ships
 *  rarity strings. Legendary takes the UR slot — it's the top of the ladder
 *  here, so it gets the rainbow. Unknown rarity = 1, the calmest treatment. */
const RARITY_TIER: Record<string, number> = {
  common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5,
  // the Cellar's ladder (wine-shelf WINE_TIERS) — same five rungs, same visuals
  entry: 1, cellar: 2, reserve: 3, icon: 4, "grand prize": 5,
}
/** a bottle's buyback offer, in the cents every reveal surface speaks */
const offerCents = (o: BottleOffer) => Math.round(ceilUsd(o.priceUnits6) * 100)
const rarityTier = (r: string) => RARITY_TIER[r.toLowerCase()] ?? 1
/** tier → bloom/halo color, hip4 tokens (cac's glowColor). */
const glowColor = (tier: number) =>
  tier >= 5 ? "var(--brand)"
  : tier === 4 ? "#c084fc"
  : tier === 3 ? "#38bdf8"
  : tier === 2 ? "#94a3b8"
  : "#64748b"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- pull journal + cross-tab money lock (localStorage) --------------------
// The journal makes every money step resumable (see gacha-core.PullJournal);
// the lock keeps two tabs from racing one wallet balance.

const journalKey = (solAddr: string) => `gacha:pull:${solAddr}`

function loadJournal(solAddr: string): PullJournal | null {
  try {
    const raw = localStorage.getItem(journalKey(solAddr))
    return raw ? (JSON.parse(raw) as PullJournal) : null
  } catch {
    return null
  }
}
const saveJournal = (solAddr: string, j: PullJournal) => {
  try {
    localStorage.setItem(journalKey(solAddr), JSON.stringify(j))
  } catch {}
}
const clearJournal = (solAddr: string) => {
  try {
    localStorage.removeItem(journalKey(solAddr))
  } catch {}
}

type Phase =
  | { step: "idle" }
  | { step: "preparing" | "funding" | "signing" | "confirming" | "claiming" | "opening" }
  | { step: "revealed"; card: OpenedCard; sellTarget: SellTarget; soldCents: number | null }
  /** bulk pull result — one grid instead of N rip theaters. `missing` counts
   *  packs that never charged (stock shortfall / dead txs); `pending` ones
   *  are still opening and resume from the journal on the next pull. */
  | { step: "revealed_bulk"; cards: OpenedCard[]; missing: number; pending: number }
  /** Still minting after our poll budget. NOT an error: open is idempotent and
   *  `confirmed` has no deadline, so the pack is not lost — the journal stays
   *  and the next pull resumes at the open. */
  | { step: "still_opening" }
  /** Slabz is out of card stock for this pack, so a pull would auto-sell for
   *  USDC instead of minting a slab. A materially different product, so it gets
   *  its own state and its own CTA label — this used to be collected through the
   *  red error box with a button that still said "Pull". */
  | { step: "turbo_offer" }
  | { step: "error"; message: string }

/** Bulk pulls: 10 packs = 1 create + 10 submits + 10 opens, well inside
 *  Slabz's 60 req/min key limit; also caps how much one bridge moves. */
// One-tap quantity presets, same row the Cellar uses — the −/+/Max stepper
// took up to nine taps to say "ten". The last preset IS the bulk cap. Odd
// counts from old resumed journals still pull fine: the journal pins its own
// count.
const QTY_PRESETS = [1, 3, 5, 10] as const

// Universe glyphs for the picker rail — a row of icons reads as a chooser at a
// glance where a row of words reads as prose. Unknown families fall back to a
// card glyph, never to a blank tile.
// ponytail: hardcoded map, matched on the family name. Ask Slabz for a category
// icon field if the catalog ever outgrows a dozen lines.
const UNIVERSE_ICON: Record<string, string> = {
  pokemon: "\u26a1",
  "one piece": "\ud83c\udff4\u200d\u2620\ufe0f",
  soccer: "\u26bd",
  football: "\ud83c\udfc8",
  baseball: "\u26be",
  basketball: "\ud83c\udfc0",
  sports: "\ud83c\udfc6",
  wine: "\ud83c\udf77",
}
const universeIcon = (family: string) =>
  UNIVERSE_ICON[family.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")] ??
  "\ud83c\udccf"

/** When a wait stops being ordinary. Past this the copy starts counting
 *  seconds, says the pack is paid for, and offers the escape hatch — none of
 *  which belongs on screen at second two. */
const SLOW_AFTER_S = 12

// Tier/family switches happen in place (packId is state, URL via
// history.replaceState — no Next navigation, no remount). These caches make
// revisits instant and seed a fresh mount from a previous visit.
const packCache = new Map<string, Pack>()
const cardsCache = new Map<string, PackCard[]>()
let lastPack: Pack | undefined
let familiesCache: Pack[][] = []

type SellTarget =
  | { kind: "slabz"; txId: string }
  // a bottle from the Cellar — sellback is an EIP-712 authorisation the house relays
  | { kind: "wine"; collection: `0x${string}`; tokenId: bigint }
  // The public "Try a demo rip" flow AND the dev rarity row — not dev-only.
  // Canned quote/sell; Reveal hides the sell button for it outside development.
  | { kind: "demo" }

type SellQuoteView = { available: boolean; offerCents: number; payoutCents: number }

// structural props, not PackCard: held cards from the collection panel reuse it
function CardThumb({
  card,
  contain = false,
}: {
  card: Pick<PackCard, "name" | "rarity" | "insuredValueCents"> & {
    imageUrl?: string | null
  }
  /** Bottle scans are tall cut-outs on transparency, not 3/5 slab photos: box them
   *  in the card's aspect and let them stand, or one shelf tile is four rows high. */
  contain?: boolean
}) {
  return (
    <div className="relative rounded-lg overflow-hidden border border-border">
      {card.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={card.imageUrl}
          alt={card.name}
          className={contain ? "aspect-[3/5] w-full bg-surface-2 object-contain p-2 pb-8" : "w-full"}
        />
      ) : (
        // held cards (OpenedCard) can arrive without art — name tile, not a broken img
        <div className="grid aspect-[3/5] w-full place-items-center bg-surface-2 p-2 text-center text-xs">
          {card.name}
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-2 pb-1.5 pt-6">
        <p className="truncate text-[11px] font-medium text-white">{card.name}</p>
        <p className={`text-[10px] font-mono capitalize ${rarityText(card.rarity)}`}>
          {card.rarity} · {usd(card.insuredValueCents)}
        </p>
      </div>
    </div>
  )
}

/** The card, revealed — sell-back included. The slab is already in the user's
 *  wallet, so there is nothing to "keep" and closing is enough. Art comes from
 *  the open response's imageUrl; name-match against the pack card list is a
 *  fallback.
 *
 *  The cover is pulled off by hand — drag it up or down past ~25% (or flick
 *  it), tap it, or press Enter on it. The tap and key paths exist because the
 *  cover used to be a bare <img> with pointer handlers only: a first-timer's
 *  instinct is to tap, which did nothing under the drag threshold, and a
 *  keyboard-only user could not reveal a card they had paid for at all.
 *
 *  Every rarity tell stays behind the cover until it comes off — the flare, the
 *  bloom, the slab halo and the art all gate on `pulled`, or the reveal is
 *  spoiled before the user touches it. */
function Reveal({
  card,
  image,
  soldCents: initialSold,
  note,
  demo = false,
  initialQuote,
  fetchQuote,
  sell,
  onClose,
  noun = "card",
}: {
  card: OpenedCard
  image?: string
  soldCents: number | null
  /** auto-sold bridge progress, shown in the status slot */
  note?: string | null
  /** free demo rip — nothing charged, no card minted; the sell button hides
   *  (its canned quote would read as a broken price on a real-looking card),
   *  EXCEPT in development where it stays for testing the sell flow, and the
   *  collection link drops (the card isn't there) */
  demo?: boolean
  /** Quote fetched back when the phase went `revealed`, so the Sell button is
   *  priced on first paint instead of ~6s after the user first sees it. */
  initialQuote?: SellQuoteView | null
  fetchQuote: () => Promise<SellQuoteView | null>
  /** `onSold` fires the instant the sale is terminal (NFT burned, USDC in the
   *  pack wallet). The bridge to the HL balance runs after it, so the UI must
   *  commit to "sold" on the callback rather than on the resolved promise. */
  sell: (minOfferCents: number, onSold?: (cents: number) => void) => Promise<number>
  onClose: () => void
  /** what's under the cover — the Cellar reveals bottles through the same theater */
  noun?: "card" | "bottle"
}) {
  // pull cover reveal (ported from cac's PullDownReveal, framer-motion swapped
  // for pointer events): drag the card up OR down past ~25% to reveal
  const [pulled, setPulled] = useState(false)
  const [dy, setDy] = useState(0)
  // which way the cover flies off — sign of the release drag
  const pullDir = useRef(1)
  // card art must not flash through before the cover paints
  const [coverReady, setCoverReady] = useState(false)
  // y/t/v = rolling velocity sample, so a fast flick releases like framer's
  const drag = useRef<{ startY: number; h: number; y: number; t: number; v: number } | null>(null)
  const [quote, setQuote] = useState<SellQuoteView | null>(initialQuote ?? null)
  const [selling, setSelling] = useState(false)
  const [sold, setSold] = useState<number | null>(initialSold)
  const [err, setErr] = useState<string | null>(null)
  /** ONE status line. This used to be five sibling slots that could all be live
   *  at once, two of them saying the same thing in different words. Carries: a
   *  payout still in flight, or a settlement that outran our poll (no price —
   *  we never saw `completed`, so naming one would be a guess). */
  const [status, setStatus] = useState<string | null>(null)
  const tier = rarityTier(card.rarity)
  const glow = glowColor(tier)

  // the hoisted quote can still land after this mounts
  useEffect(() => {
    if (initialQuote) setQuote(initialQuote)
  }, [initialQuote])

  useEffect(() => {
    // Gate on the autoSold FLAG, not on the cents. `autoSoldCents` is
    // `number | null`, so a turbo auto-sell that reports no amount used to read
    // as "not sold" here and fire a buyback quote for an NFT the wallet never
    // received — offering to sell a card that does not exist.
    if (initialSold != null || card.autoSold || initialQuote?.available) return
    // Fallback for a hoisted quote that failed or hasn't landed: a slab minted
    // seconds ago isn't always quotable. Bounded — 60 req/min key.
    let stop = false
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = async () => {
      const q = await fetchQuote().catch(() => null)
      if (stop) return
      setQuote((prev) => (prev?.available ? prev : q))
      if (!q?.available && ++tries < 5) timer = setTimeout(ask, 3000)
    }
    void ask()
    return () => {
      stop = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function onSell() {
    if (!quote) return
    setSelling(true)
    setErr(null)
    try {
      const cents = await sell(quote.offerCents, (c) => {
        setSold(c)
        setStatus("Moving your payout to your balance — you can keep browsing.")
      })
      setSold(cents)
      setStatus(null) // bridge landed too — drop the in-flight note
    } catch (e) {
      if (e instanceof SellSettlingError) {
        // Slabz said `submitted`: the sale is in flight, so retire the Sell
        // button and say so plainly rather than painting good news red.
        setStatus(e.message)
      } else if (e instanceof SoldBridgePendingError) {
        // the sale went through and only the payout is still moving. Showing
        // it as a plain error leaves a live Sell button on an already-sold
        // card AND paints good news red.
        setSold(e.soldCents)
        setStatus(e.message)
      } else {
        // any other failure: re-ask for the quote. It comes back unavailable
        // once the card carries a buyback ("already initiated"), which drops
        // the Sell button; a moved offer (QUOTE_CHANGED) just re-prices it.
        fetchQuote().then(setQuote).catch(() => {})
        setErr(
          e instanceof GachaApiError && e.code === "QUOTE_CHANGED"
            ? "The buyback offer changed — check the new price."
            : e instanceof Error
              ? e.message
              : String(e),
        )
      }
    } finally {
      setSelling(false)
    }
  }

  return (
    // scrollable outer + min-h-full centered inner: short screens scroll
    // instead of clipping the slab/buttons off both ends
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Your ${noun}`}
      className="theater fixed inset-0 z-50 overflow-y-auto overflow-x-hidden bg-background/95 backdrop-blur-sm"
    >
      {/* Rarity tells stay locked until the cover comes off — leaking them
          around the cover spoils the pull (cac gates all three on coverPulled). */}
      {pulled && (
        // cac's theater has nothing under the card, so it runs the flare full-bleed.
        // Here the name/value/buttons sit directly below — unmasked, the burst
        // blows the copy out. Keep it around the slab and fade before the text.
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-0"
          style={{ maskImage: "radial-gradient(closest-side at 50% 34%, #000 42%, transparent 82%)" }}
        >
          <UrFlare tier={tier} className="h-full w-full opacity-90 mix-blend-screen" />
        </div>
      )}
      {/* one-shot flood, chase pulls only — a common keeps just its slab halo */}
      {pulled && tier >= 3 && (
        <div
          aria-hidden
          className="tear-bloom pointer-events-none fixed left-1/2 top-[42%] z-0 h-[120vmin] w-[120vmin] -translate-x-1/2 -translate-y-1/2"
          style={{ "--bloom-color": glow } as React.CSSProperties}
        />
      )}
      <div className="relative z-10 flex min-h-full flex-col items-center justify-center gap-6 p-6">
      <div className="w-56">
        {/* slab photos are ~0.6 aspect — 3/4 cropped the grade label off the top */}
        <div className="relative aspect-[3/5]">
          {/* slab halo — the sub-UR rarity read. UR skips it: the flare above
              already floods the theater and a halo under it just muddies. */}
          {pulled && tier < 5 && (
            <div
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[130%] w-[150%] -translate-x-1/2 -translate-y-1/2"
              style={{ background: `radial-gradient(closest-side, ${glow}, transparent 76%)`, opacity: 0.9, filter: "blur(30px)" }}
            />
          )}
          {/* drawn card — beneath the cover, teased as it slides. The rarity
              glow only lands after the pull; leaking it around the cover spoils
              the reveal. */}
          <div
            className={`absolute inset-0 rounded-xl overflow-hidden transition-opacity ${
              // a bottle is a cut-out, not a slab: no box, no box shadow — the flare
              // and the halo are what light it, and a rectangle over them blocks both
              !pulled || noun === "bottle"
                ? ""
                : card.rarity.toLowerCase() === "legendary" || card.rarity.toLowerCase() === "epic"
                  ? "shadow-[0_0_60px_-10px_var(--brand)]"
                  : "shadow-2xl"
            }`}
            style={{ opacity: coverReady || pulled ? 1 : 0 }}
          >
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={image}
                alt={card.name}
                className={
                  noun === "bottle"
                    // no filter: Safari casts drop-shadow from the image BOX, not its
                    // alpha, which drew a dark slab behind the bottle over the flare
                    ? "h-full w-full object-contain"
                    : "h-full w-full object-cover"
                }
              />
            ) : (
              <div className="grid h-full w-full place-items-center bg-gradient-to-b from-brand/25 to-surface-2 p-4 text-center">
                <span className="font-heading text-lg">{card.name}</span>
              </div>
            )}
          </div>
          {/* cover card: drag past ~25%, flick, tap, or press Enter */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/gacha/back.svg"
            alt=""
            draggable={false}
            role="button"
            tabIndex={pulled ? -1 : 0}
            aria-label={`Reveal your ${noun}`}
            autoFocus
            // onLoad can miss a cached image that finished before the handler attached
            ref={(el) => { if (el?.complete) setCoverReady(true) }}
            onLoad={() => setCoverReady(true)}
            onKeyDown={(e) => {
              if (pulled || (e.key !== "Enter" && e.key !== " ")) return
              e.preventDefault()
              setPulled(true)
            }}
            onPointerDown={(e) => {
              if (pulled) return
              e.currentTarget.setPointerCapture(e.pointerId)
              const h = e.currentTarget.clientHeight
              drag.current = { startY: e.clientY, h, y: e.clientY, t: e.timeStamp, v: 0 }
            }}
            onPointerMove={(e) => {
              const d = drag.current
              if (!d || pulled) return
              // framer reads velocity off ~100ms of pointer history; a >30ms
              // window is close enough and keeps one jittery frame from firing
              const dt = e.timeStamp - d.t
              if (dt > 30) {
                d.v = ((e.clientY - d.y) / dt) * 1000
                d.y = e.clientY
                d.t = e.timeStamp
              }
              // dragElastic 0.9, both directions
              setDy((e.clientY - d.startY) * 0.9)
            }}
            onPointerUp={(e) => {
              const d = drag.current
              if (!d) return
              drag.current = null
              // cac thresholds the RAW offset, not the elastic-damped one
              const off = e.clientY - d.startY
              // A tap is not a failed drag. Under the threshold it used to snap
              // back and do nothing, which is exactly what a first-timer tries.
              if (Math.abs(off) < 6 && Math.abs(d.v) < 200) {
                setDy(0)
                setPulled(true)
                return
              }
              if (Math.abs(off) > d.h * 0.25 || Math.abs(d.v) > 800) {
                pullDir.current = Math.sign(off || d.v) || 1
                setPulled(true)
              } else setDy(0)
            }}
            onPointerCancel={() => {
              drag.current = null
              setDy(0)
            }}
            // slab overhangs the card 6% — acrylic case reads bigger than what's inside
            className="absolute -inset-[3%] z-10 h-[106%] w-[106%] rounded-xl object-cover select-none"
            style={{
              transform: pulled
                ? `translateY(${pullDir.current * 140}%) rotate(${pullDir.current * 6}deg)`
                : `translateY(${dy}px)`,
              opacity: pulled ? 0 : 1,
              transition: drag.current
                ? "none"
                : pulled
                  ? "transform .55s cubic-bezier(.32,.72,0,1), opacity .55s"
                  // dragSnapToOrigin springs back with overshoot; back-out ease
                  // is the CSS-native stand-in
                  : "transform .5s cubic-bezier(.34,1.36,.64,1)",
              touchAction: "none",
              pointerEvents: pulled ? "none" : undefined,
              cursor: pulled ? undefined : "grab",
            }}
          />
        </div>
        <p
          className={`mt-3 text-center text-[11px] uppercase tracking-widest text-muted-foreground transition-opacity ${
            pulled ? "opacity-0" : "opacity-100"
          }`}
        >
          Pull to reveal — or tap
        </p>
      </div>

      <div
        className={`flex max-w-full flex-col items-center gap-1 text-center transition-opacity duration-500 ${
          pulled ? "opacity-100" : "opacity-0"
        }`}
      >
        <span className={`text-[11px] uppercase tracking-widest font-medium ${rarityText(card.rarity)}`}>
          {card.rarity}
        </span>
        {/* pixel font + long slab names: force wrap on devices where the
            name would otherwise clip off both edges */}
        <span className="font-heading text-xl max-w-full [overflow-wrap:anywhere]">{card.name}</span>
        <span className="mt-1 font-mono text-sm">{usd(card.insuredValueCents)}</span>
        {(sold != null || card.autoSold) && (
          <span className="mt-1 text-xs text-brand">
            {sold != null
              ? `Sold back for ${usd(sold)}${card.autoSold ? " (auto)" : ""}`
              : // flag set but no amount reported — say what happened rather
                // than inventing a number or claiming the card is in the wallet
                "Auto-sold for USDC — paid to your balance"}
          </span>
        )}
        {/* the one status slot, highest priority first */}
        {err ? (
          <>
            <span className="mt-1 max-w-xs text-xs text-no">{err}</span>
            <GetHelp className="mt-1" />
          </>
        ) : status ? (
          <span className="mt-1 max-w-xs text-xs text-brand">{status}</span>
        ) : note ? (
          <span className="mt-1 text-xs text-muted-foreground">{note}</span>
        ) : null}
      </div>

      <div
        className={`flex gap-3 transition-opacity duration-500 ${
          pulled ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        {sold == null && !status && (!demo || process.env.NODE_ENV === "development") && (
          // same hold-to-confirm as the collection grid — one interaction for
          // an irreversible sale everywhere it exists
          <HoldToSell
            onCommit={onSell}
            disabled={selling || !quote?.available}
            className="rounded-full border border-border bg-surface px-5 py-2.5 text-sm font-medium hover:bg-surface-2 transition disabled:opacity-50"
            label={
              selling
                ? "Selling…"
                : quote?.available
                  ? `Hold to sell · ${usd(quote.payoutCents)}`
                  : quote
                    ? "Sell-back unavailable"
                    : "Pricing…"
            }
          />
        )}
        <button
          onClick={onClose}
          // `selling` stays true through the bridge to the HL balance, which
          // runs AFTER the sale is terminal and can take minutes. Disabling the
          // only exit for that whole window while the status line says "you can
          // keep browsing" made a liar of the copy and trapped the user. Once
          // `sold` is set the slab is gone and the payout finishes on its own —
          // closing is safe, and the sweeper doesn't care if this is mounted.
          disabled={selling && sold == null}
          className="btn-brand px-6 py-2.5 text-sm font-semibold transition-transform duration-150 ease-(--ease-smooth-out) active:scale-[0.97] disabled:opacity-50"
        >
          {/* packs.com's two verbs: the choice at the reveal is Sell or Keep.
              Once the card is sold there's nothing left to keep — plain Done.
              Demo rips too: "Keep" on a card that is never minted is a lie. */}
          {sold != null || card.autoSold || demo ? "Done" : "Keep"}
        </button>
      </div>
      {demo && (
        <p
          className={`text-xs text-muted-foreground transition-opacity duration-500 ${
            pulled ? "opacity-100" : "opacity-0"
          }`}
        >
          Demo rip — nothing charged, no card minted.
        </p>
      )}
      {/* where "Keep" puts it — the reveal used to end in a dead end */}
      {!demo && sold == null && !card.autoSold && (
        <Link
          href="/gacha/collection"
          className={`text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline transition-opacity duration-500 ${
            pulled ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          Kept {noun}s live in your collection →
        </Link>
      )}
      </div>
    </div>
  )
}

/** Bulk pull results: one grid instead of N rip theaters. Cards are already
 *  in the wallet (sell/redeem lives in the collection). */
function BulkReveal({
  cards,
  missing,
  pending,
  note,
  onClose,
  noun = "card",
}: {
  cards: OpenedCard[]
  missing: number
  pending: number
  note?: string | null
  onClose: () => void
  noun?: "card" | "bottle"
}) {
  const total = cards.reduce((a, c) => a + c.insuredValueCents, 0)
  const sold = cards.reduce((a, c) => a + (c.autoSold ? (c.autoSoldCents ?? 0) : 0), 0)
  return (
    <div className="theater fixed inset-0 z-50 overflow-y-auto bg-background/95 backdrop-blur-sm">
      <div className="mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center gap-5 p-6">
        <div className="text-center">
          <h2 className="font-heading text-2xl">Your {noun}s</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {cards.length} {noun}{cards.length === 1 ? "" : "s"} · total value{" "}
            <span className="font-mono text-foreground">{usd(total)}</span>
            {sold > 0 && <> · {usd(sold)} auto-sold</>}
          </p>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-3">
          {cards.map((c, i) => (
            <div key={i} className="rounded-xl border border-border bg-surface p-2 text-center">
              {c.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.imageUrl} alt="" className="mx-auto h-36 rounded object-contain" />
              )}
              <p className="mt-1.5 truncate text-xs font-medium">{c.name}</p>
              <p className={`text-[11px] font-mono capitalize ${rarityText(c.rarity)}`}>
                {c.rarity} · {usd(c.insuredValueCents)}
                {c.autoSold ? " · sold" : ""}
              </p>
            </div>
          ))}
        </div>
        {missing > 0 && (
          <p className="max-w-md text-center text-xs text-muted-foreground">
            {missing} pack{missing > 1 ? "s" : ""} couldn&apos;t be completed — unspent funds stay
            in your pack wallet, and we move it back to your balance automatically.
          </p>
        )}
        {pending > 0 && (
          <p className="max-w-md text-center text-xs text-muted-foreground">
            {pending} pack{pending > 1 ? "s" : ""} still opening — pull again in a minute to
            resume.
          </p>
        )}
        {note && <p className="max-w-md text-center text-xs text-muted-foreground">{note}</p>}
        <p className="max-w-md text-center text-xs text-muted-foreground">
          Kept {noun}s are in{" "}
          <Link href="/gacha/collection" className="underline underline-offset-2 hover:text-foreground">
            your collection
          </Link>{" "}
          {noun === "bottle"
            ? "— sell-back doesn't expire."
            : `— sell-back stays open for ${SELLBACK_WINDOW_H}h after the pull.`}
        </p>
        {(missing > 0 || pending > 0) && <GetHelp />}
        <button onClick={onClose} className="btn-brand px-6 py-2.5 text-sm font-semibold">
          Done
        </button>
      </div>
    </div>
  )
}

/** Read-only trophy case for the side panel: what the wallet holds, best
 *  first. Sell/redeem stay on the full collection page — the panel is a
 *  glance, not a money surface. */
function CollectionPanel({
  authenticated,
  walletsReady,
  address,
  evmAddress,
}: {
  authenticated: boolean
  /** Privy's Solana wallet list has hydrated — before this, a missing
   *  `address` means "not loaded yet", not "no wallet". */
  walletsReady: boolean
  address?: string
  /** HyperEVM wallet — where Cellar bottles land. Slabs and bottles are one
   *  collection here, best first, whichever chain holds them. */
  evmAddress?: string
}) {
  // undefined = loading, null = failed, [] = empty
  const [cards, setCards] = useState<
    (OpenedCard & { transactionId: string })[] | null | undefined
  >(undefined)
  useEffect(() => {
    if (!address) return
    let live = true
    listTransactions(address, 100)
      .then(async (txs) => {
        const mints = txs
          .map((t) => (t.card && "nftMint" in t.card ? t.card.nftMint : null))
          .filter((m): m is string => !!m)
        const owned = await coreAssetsOwned(address, mints)
        if (live) setCards(heldCards(txs, owned))
      })
      .catch(() => live && setCards(null))
    return () => {
      live = false
    }
  }, [address])
  // Bottles ride the same tile, graded and valued off their live quote, exactly
  // as the reveal showed them. Fails soft to none: a wine read must never take
  // the slabs down with it.
  const wineOn = wineConfigured() && !!evmAddress
  const [bottles, setBottles] = useState<OpenedCard[] | undefined>(undefined)
  useEffect(() => {
    if (!wineOn) return
    let live = true
    bottlesOwned(evmAddress as `0x${string}`)
      .then((bs) =>
        Promise.all(
          bs.map(async (b) =>
            toCard(
              { collection: b.collection, tokenId: b.tokenId.toString(), deferred: b.deferred },
              await readOffer(b.collection, b.tokenId).catch(() => undefined),
            ),
          ),
        ),
      )
      .then((cs) => live && setBottles(cs))
      .catch(() => live && setBottles([]))
    return () => {
      live = false
    }
  }, [wineOn, evmAddress])

  if (!authenticated)
    return <p className="text-sm text-muted-foreground">Sign in to see your collection.</p>
  const slabsLoading = !!address && cards === undefined
  // no Solana wallet after hydration = no card pulls yet, not "loading forever"
  const slabsPending = !walletsReady && !address
  const bottlesLoading = wineOn && bottles === undefined
  const items = [...(cards ?? []), ...(bottles ?? [])].sort(
    (a, b) => b.insuredValueCents - a.insuredValueCents,
  )
  if ((slabsLoading || slabsPending || bottlesLoading) && items.length === 0)
    return (
      <div className="grid grid-cols-3 gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="aspect-[3/5] animate-pulse rounded-lg border border-border bg-surface" />
        ))}
      </div>
    )
  if (items.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        {cards === null
          ? "Couldn't load your collection — try again in a moment."
          : "Nothing here yet — cards and bottles you keep land in your collection."}
      </p>
    )
  const bottleKeys = new Set((bottles ?? []).map((b) => b.nftMint))
  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        {items.map((c) => (
          <CardThumb key={c.nftMint} card={c} contain={bottleKeys.has(c.nftMint)} />
        ))}
      </div>
      <Link
        href="/gacha/collection"
        className="mt-3 block text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Sell or ship in the full collection →
      </Link>
    </>
  )
}

/** Turbo escalation as an explicit choice: an Accept/Cancel pair, never a
 *  relabel of the button the user just pressed. Turbo pays USDC instead of
 *  minting a slab — a materially different product needs a real consent UI. */
function TurboConsent({
  price,
  onAccept,
  onCancel,
}: {
  price: string
  onAccept: () => void
  onCancel: () => void
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <p className="text-xs text-muted-foreground">{TURBO_CONSENT}</p>
      <div className="mt-3 flex gap-2">
        <button
          onClick={onCancel}
          className="flex-1 rounded-xl border border-border bg-surface-2 py-2.5 text-sm font-medium hover:text-foreground"
        >
          Cancel
        </button>
        <button onClick={onAccept} className="btn-brand flex-1 py-2.5 text-sm font-semibold">
          Open for USDC · {price}
        </button>
      </div>
    </div>
  )
}

export default function PackPage({ params }: { params: Promise<{ packId: string }> }) {
  // The route param only seeds the first mount. Every selector switch after
  // that is setPackId + history.replaceState — SPA, never a Next navigation,
  // so the stage, WebGL pack, and all state stay mounted through a switch.
  const { packId: routePackId } = use(params)
  const [packId, setPackId] = useState(routePackId)
  // The Cellar is a universe on this stage, not a route: `cellar` is the
  // packId sentinel. It IS a pack here — same 3D pack on the ground, same buy
  // cluster, same rip → grading → reveal theater; only the money and the
  // prizes come from HyperEVM (useCellar) instead of Slabz. Live once the
  // contract address is configured; dev always, so the mock shelf stays
  // reviewable.
  const cellar = packId === "cellar"
  const cellarLive = wineConfigured() || process.env.NODE_ENV === "development"
  // `lastPack` keeps the chrome up (as stale) while a fresh mount loads.
  const [pack, setPack] = useState<Pack | null | undefined>(
    () => packCache.get(packId) ?? lastPack,
  )
  // null = loading (skeleton), [] = fetched but genuinely unavailable
  const [cards, setCards] = useState<PackCard[] | null>(() => cardsCache.get(packId) ?? null)
  const [showAll, setShowAll] = useState(false)
  // The stage slot has three states and shows exactly one: the pack, the card
  // list, or the FAQ. Nothing stacks below it — the page never scrolls.
  const [panel, setPanel] = useState<null | "inside" | "help" | "collection">(null)
  // Mobile-only bottom sheet for the universe picker (slabz-style).
  const [universeSheet, setUniverseSheet] = useState(false)
  // Edge fades on the mobile price rail, shown only while content is actually
  // hidden past that edge. Synced on scroll AND after every render — pills
  // change with the pack catalog and a pack switch, neither of which scrolls.
  const priceRail = useRef<HTMLDivElement | null>(null)
  const [railFade, setRailFade] = useState({ l: false, r: false })
  const syncRailFade = useCallback(() => {
    const el = priceRail.current
    if (!el) return
    const l = el.scrollLeft > 4
    const r = el.scrollLeft < el.scrollWidth - el.clientWidth - 4
    setRailFade((p) => (p.l === l && p.r === r ? p : { l, r }))
  }, [])
  useEffect(syncRailFade)
  // Gates the docked desktop column so mobile never pays the collection fetch
  // for a column it can't see. Post-hydration + a change listener: an SSR'd
  // useState initializer runs without window and never re-runs, and a one-shot
  // read can sample the viewport before the window settles at its real size.
  // The buy cluster's own height, measured, so the pack can centre in the band
  // above it. It swings ~80px between signed-out and signed-in and again with
  // the card rail, and it is exactly the thing this page keeps redesigning — a
  // constant in PackRip went stale the last two times. undefined until the
  // first measurement; PackRip falls back to its own default for those frames.
  const [chromeBottom, setChromeBottom] = useState<number | undefined>(undefined)
  // A callback ref, not useRef + an effect: this page early-returns a skeleton
  // while the pack loads, so the cluster is absent from the first commit and a
  // []-dep effect would observe null and never retry.
  const controlsRO = useRef<ResizeObserver | null>(null)
  const controlsRef = useCallback((el: HTMLDivElement | null) => {
    controlsRO.current?.disconnect()
    if (!el) return
    controlsRO.current = new ResizeObserver(() =>
      // Distance from the cluster's TOP edge to the bottom of the screen, not its
      // own height: a cluster that floats above the edge reserves both.
      setChromeBottom(window.innerHeight - el.getBoundingClientRect().top),
    )
    controlsRO.current.observe(el)
  }, [])
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)")
    const sync = () => setIsDesktop(mq.matches)
    sync()
    mq.addEventListener("change", sync)
    return () => mq.removeEventListener("change", sync)
  }, [])

  const [phase, setPhase] = useState<Phase>({ step: "idle" })
  const [qty, setQty] = useState(1)
  // The rip is the gate, cac-style: the card modal waits for the user to tear
  // the pack open, so the theater covers the open-poll instead of a spinner.
  const [poppedOpen, setPoppedOpen] = useState(false)
  // Grading sheet (year/category/grade/rarity) plays between the rip and the
  // card — the card modal waits for it, so the tier lands as a stamp, not a
  // glow leaking around the cover.
  const [statsDone, setStatsDone] = useState(false)
  const [autoBridge, setAutoBridge] = useState<null | "sending" | "done" | "failed">(null)
  // Arms the rip theater. NOT the same as `busy`: payWithCard also parks the
  // phase on "preparing" while it checks the journal and the wallet balance,
  // and a theater over THAT would flash a tearable pack in front of a card
  // checkout that hasn't charged anything yet.
  const [pulling, setPulling] = useState(false)
  // Priced before the reveal paints. The quote used to be requested inside
  // Reveal, which doesn't mount until after the tear AND the grading sheet — so
  // the Sell button sat disabled for seconds on a card that was sellable the
  // whole time. Same single Slabz request, just earlier.
  const [revealQuote, setRevealQuote] = useState<SellQuoteView | null>(null)
  // Seconds since the pull started. A number that increments is the strongest
  // liveness proof there is, and unlike a progress bar it's honest — you cannot
  // draw a determinate bar over a Relay fill.
  const [elapsed, setElapsed] = useState(0)
  // card checkout target — set once the embedded Solana wallet exists
  const [cardFor, setCardFor] = useState<ConnectedStandardSolanaWallet | null>(null)
  const [cardRail, setCardRail] = useState<"coinflow" | "crossmint">("coinflow")

  const { authenticated, login } = usePrivy()
  const { wallets: evmWallets } = useWallets()
  const { wallets: solWallets, ready: solReady } = useSolanaWallets()
  const { createWallet } = useCreateWallet()
  const { signTransaction } = useSignTransaction()
  const { signMessage } = useSignMessage()
  // async flows poll these refs — hook state doesn't reach a running closure
  const solWalletsRef = useRef(solWallets)
  solWalletsRef.current = solWallets
  const solReadyRef = useRef(solReady)
  solReadyRef.current = solReady
  const solWallet = pickPrivySolWallet(solWallets)
  // privy-first like every other money surface (DepositDialog, Withdraw…):
  // a connected external wallet must not shadow the embedded HL account
  const evmWallet =
    evmWallets.find((w) => w.walletClientType === "privy") ?? evmWallets[0]
  // The Cellar's chain wiring (shelf, balances, the gasless pull). Idle unless
  // this stage IS the Cellar — no wine RPC traffic from a pack.
  const wine = useCellar(evmWallet, cellar)
  // The Cellar opens one pack at a time, always — every bottle gets its rip and
  // its reveal. A ×N chosen on a card pack must not carry over.
  useEffect(() => {
    if (cellar) setQty(1)
  }, [cellar])
  // Which print the 3D pack wears, idle stage and theater alike. The Cellar
  // is a pack too, wearing pack-art/cellar_front.webp.
  const artKey = cellar ? "cellar" : pack?.ccPackType

  // closed-beta gate: no pre-check route anymore — flip to the panel when a
  // gated call answers NOT_ALLOWLISTED
  const [allowed, setAllowed] = useState(true)

  // gift claim entry (?gift=<id>, from the packs-page banner). Read from
  // location — useSearchParams would force a Suspense boundary for one param.
  // Any failure (unauth'd deep link, foreign pack, exhausted gift) silently
  // falls back to the normal paid pull. Re-fetched on sign-in: the read is
  // auth-gated, so a signed-out deep link fails silently and would otherwise
  // leave the visitor staring at a paid pull after they log in.
  // undefined until the peek lands — see freeState()
  const [gift, setGift] = useState<Gift | null>()
  useEffect(() => {
    if (!authenticated) return
    const id = new URLSearchParams(window.location.search).get("gift")
    if (!id) {
      setGift(null)
      return
    }
    getGift(id)
      .then((g) =>
        setGift(
          g.status === "confirmed" && g.packsRemaining > 0 && g.packId === packId
            ? g
            : null,
        ),
      )
      .catch(() => setGift(null))
  }, [packId, authenticated])

  // Free-pack entitlement (gacha_credits: whitelist beta, referral reward,
  // goodwill). The peek is read-only and spends nothing; the gift is minted
  // from house funds on the CLICK, in pull(). Any failure reads as "no
  // credit" and falls back to the normal paid pull — never blocks.
  const [credit, setCredit] = useState<FreeCredit | null>()
  useEffect(() => {
    if (!authenticated || !pack) return
    let live = true
    // back to "not known yet" on every re-peek: a credit read for the previous
    // pack (or a spent one) must never keep the button promising free
    setCredit(undefined)
    getFreeCredits()
      .then(({ credits }) => {
        if (!live) return
        setCredit(credits.find((c) => creditMatches(c, pack.name)) ?? null)
        // the peek passed the same gate a pull uses — clear a stale block
        // (e.g. one transient 403) instead of walling the page until remount
        setAllowed(true)
      })
      // a failed peek reads as "no credit" — never a hang on "Loading…".
      // The peek runs through the same allowlist gate as a pull, so its 403
      // doubles as the closed-beta pre-check: gate the page here, up front,
      // instead of letting the user discover it by a failed first click.
      .catch((e) => {
        if (!live) return
        setCredit(null)
        if (e instanceof GachaApiError && e.code === "NOT_ALLOWLISTED") setAllowed(false)
      })
    return () => {
      live = false
    }
    // re-peeks when a gift is spent down, so a user holding two entitlements
    // (beta + referral, say) sees the next one without a reload. The consumed
    // row is already excluded server-side, so this can't re-offer it.
  }, [authenticated, pack?.name, gift?.packsRemaining])
  // one gate for "this pull costs the user nothing", whether the gift already
  // exists (?gift= deep link, packs-page banner) or is still an unredeemed
  // credit. A spent gift falls back to the credit rather than to a paid pull.
  // Free entitlements are Slabz packs' — the Cellar's stand-in pack (see
  // below) must never make a bottle read as a free claim.
  const free0 = freeState(gift, credit)
  const freeActive = !cellar && free0.free
  const freeUnknown = !cellar && free0.unknown
  const freePacksLeft = free0.packsLeft
  const showPaid = cellar || free0.showPaid

  const [loadErr, setLoadErr] = useState(false)
  // out-of-order guard — switches happen in place now, so a slow fetch for the
  // previous pack must not land over the current one
  const packIdRef = useRef(packId)
  packIdRef.current = packId
  const load = useCallback(() => {
    setLoadErr(false)
    // "cellar" is not a Slabz pack — nothing to fetch, and a 404 here would
    // render "Pack not found" over the wine shelf
    if (packId === "cellar") return
    const fresh = (fn: () => void) => packIdRef.current === packId && fn()
    // the /api/gacha proxy retries Slabz's random 500s for us; only a real
    // 404 means the pack doesn't exist — anything else is upstream flaking
    getPack(packId)
      .then((p) => {
        packCache.set(packId, p)
        fresh(() => {
          lastPack = p
          setPack(p)
        })
      })
      .catch((e) => {
        if (e instanceof SlabzError && e.status === 404) fresh(() => setPack(null))
        else fresh(() => setLoadErr(true))
      })
    // one fetch per rarity filter — unfiltered, Slabz returns only the
    // top-value slice of the pool (all legendary). The filter enum is
    // common|rare|epic|legendary and is shifted one tier vs the labels it
    // returns (rare→epic cards, epic→legendary, legendary→empty), so we
    // fetch every filter, dedupe, and group by the label on each card.
    Promise.all(
      ["common", "rare", "epic", "legendary"].map((r) =>
        getPackCards(packId, 20, r).catch(() => [] as PackCard[]),
      ),
    )
      .then((groups) => {
        const byId = new Map(groups.flat().map((c) => [c.nftId, c]))
        const list = [...byId.values()]
        // don't cache a flaked-out empty fetch — a revisit should skeleton
        // and refetch, not flash "unavailable"
        if (list.length) cardsCache.set(packId, list)
        fresh(() => setCards(list))
      })
      .catch(() => fresh(() => setCards([])))
  }, [packId])
  useEffect(load, [load])
  // stale = still showing the previous tier's data; every money surface must
  // gate on it — a pull while stale would charge the wrong pack
  const stale = !!pack && pack.id !== packId

  const artByName = useMemo(
    () => new Map((cards ?? []).map((c) => [c.name, c.imageUrl])),
    [cards],
  )

  // grid: legendary→common, value-desc inside a tier; preview shows 3 per
  // tier so cheap packs don't read as all-legendary
  const gridCards = useMemo(
    () =>
      [...(cards ?? [])].sort(
        (a, b) =>
          rarityTier(b.rarity) - rarityTier(a.rarity) ||
          b.insuredValueCents - a.insuredValueCents,
      ),
    [cards],
  )
  const gridPreview = useMemo(() => {
    const seen: Record<string, number> = {}
    return gridCards.filter((c) => (seen[c.rarity] = (seen[c.rarity] ?? 0) + 1) <= 3)
  }, [gridCards])
  // posted odds by tier, for the show-all grid's section headers
  const oddsPct = useMemo<Record<string, number>>(
    () => Object.fromEntries((pack?.odds ?? []).map((o) => [o.tier.toLowerCase(), o.probability])),
    [pack],
  )

  // category + tier selectors, phygitals-style: the full catalog grouped by
  // family. Switching either one is a state change here — the URL follows via
  // replaceState so deep links keep working, but Next never navigates and the
  // stage never remounts. Money paths gate on `stale` exactly as before.
  const selectPack = useCallback((id: string) => {
    setPackId(id)
    setCards(cardsCache.get(id) ?? null) // never show the previous pack's cards
    window.history.pushState(null, "", `/gacha/${id}`)
  }, [])
  // pushState above gives every switch a history entry; this makes the back/
  // forward buttons actually traverse them by syncing state off the URL.
  useEffect(() => {
    const onPop = () => {
      const id = window.location.pathname.match(/^\/gacha\/([^/]+)$/)?.[1]
      if (id && id !== packIdRef.current) {
        setPackId(id)
        setCards(cardsCache.get(id) ?? null)
      }
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])
  const [families, setFamilies] = useState<Pack[][]>(familiesCache)
  useEffect(() => {
    listPacks()
      .then((all) => {
        familiesCache = groupByFamily(all.filter((p) => p.isActive && !packHidden(p)))
        setFamilies(familiesCache)
      })
      // keep whatever the cache had — wiping it drops the selectors mid-switch
      .catch(() => {})
  }, [])
  const familyName = pack && !cellar ? packFamily(pack.name) : null
  const siblings = families.find((ps) => packFamily(ps[0].name) === familyName) ?? []
  // A cold load of /gacha/cellar has no pack. The stage below is written
  // against one (prices, art keys, gates), so borrow the first catalog pack as
  // a silent stand-in — every Slabz money surface is gated on `stale`, which
  // is true for it, and every value the cluster shows is switched on `cellar`
  // (unitCents, ctaLabel, ctaDisabled, balanceLine, freeActive).
  // ponytail: the Cellar therefore needs the Slabz catalog up, like the stage.
  useEffect(() => {
    if (cellar && pack === undefined && families[0]?.[0]) setPack(families[0][0])
  }, [cellar, pack, families])

  const inFlight = useRef(false)

  /** Embedded Solana wallet, created on demand (web3-login users don't get
   *  one automatically). Waits for the hook's `ready` before deciding to
   *  create — a pre-hydration createWallet call throws spuriously when the
   *  wallet exists. createWallet also throws when one already exists — treat
   *  any throw as "maybe exists" and let the poll be the arbiter. */
  async function ensureSolWallet(): Promise<ConnectedStandardSolanaWallet> {
    for (let i = 0; i < 12 && !solReadyRef.current; i++) await sleep(250)
    const existing = pickPrivySolWallet(solWalletsRef.current)
    if (existing) return existing
    try {
      await createWallet()
    } catch {
      /* already exists or user exited — poll below decides */
    }
    for (let i = 0; i < 20; i++) {
      const w = pickPrivySolWallet(solWalletsRef.current)
      if (w) return w
      await sleep(250)
    }
    throw new Error("Wallet isn't ready yet — try again in a moment.")
  }

  const makeSign =
    (wallet: ConnectedStandardSolanaWallet): SignSolanaTx =>
    async (tx) =>
      (await signTransaction({ transaction: tx, wallet, chain: SOLANA_CHAIN })).signedTransaction


  /** Poll a Relay fill until terminal or timeout. On timeout returns the last
   *  raw status seen ("waiting" = Relay never saw a deposit) so the caller can
   *  tell a dead quote from a slow fill; "pending" when nothing was readable. */
  async function pollFill(checkEndpoint: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs
    let last = "pending"
    while (Date.now() < deadline) {
      const s = await relayStatus(checkEndpoint)
      if (s === "success" || s === "failure" || s === "refund") return s
      if (s) last = s
      await sleep(2500)
    }
    return last
  }

  // bulk pulls skip the tear-to-reveal (there's no single card behind the
  // pack) — the rip just sways as a cover until the results grid shows
  const bulkRun = useRef(false)

  /** The user has been told this pack pays USDC instead of a card (turbo) and
   *  pulled anyway. Per-mount, and set on the FIRST refusal so the second click
   *  is the consent — Slabz consumes nothing on PARTNER_TURBO_REQUIRED, so the
   *  refusal is free. */
  const turboOk = useRef(false)

  /** openPack that rides out 429s and Slabz's random 5xxs — a bulk pull fires
   *  10 concurrent opens against the shared 60 req/min key, so a rate-limit
   *  hit is "try again", not a dead pull. A 409 (already open/completed)
   *  still throws: the journal resume reads the card via GET. */
  async function openPackPatient(txId: string, addr: string) {
    for (let i = 0; ; i++) {
      try {
        return await openPack(txId, addr)
      } catch (e) {
        if (e instanceof SlabzError && (e.status === 429 || e.status >= 500) && i < 3)
          // honour the server's own Retry-After when it sent one — a 429 says
          // exactly how long the window has left, and guessing under it just
          // burns another request
          await sleep(Math.max(e.retryAfterMs ?? 0, 2500 * (i + 1)))
        else throw e
      }
    }
  }

  /** submitSigned with the same patience. 429 = rate-limited, never processed
   *  — retry is free. 5xx = ambiguous, but a replay of a landed submit answers
   *  409, and 409 means "already advanced" — swallowed, not fatal. Only a
   *  genuine rejection throws. */
  async function submitPatient(txId: string, signedTx: string): Promise<void> {
    for (let i = 0; ; i++) {
      try {
        await submitSigned(txId, signedTx)
        return
      } catch (e) {
        if (e instanceof SlabzError && e.status === 409) return
        if (e instanceof SlabzError && (e.status === 429 || e.status >= 500) && i < 2)
          await sleep(Math.max(e.retryAfterMs ?? 0, 2500 * (i + 1)))
        else throw e
      }
    }
  }

  /** Ask for the buyback price the moment a card exists, not when the Reveal
   *  finally mounts. Failure is silent: Reveal retries on its own. */
  function primeQuote(txId: string, autoSold: boolean) {
    setRevealQuote(null)
    if (autoSold) return // nothing to sell — Slabz already bought it back
    sellHandlers({ kind: "slabz", txId })
      .fetchQuote()
      .then(setRevealQuote)
      .catch(() => {})
  }

  async function openAndReveal(sol: ConnectedStandardSolanaWallet, txId: string) {
    bulkRun.current = false
    setPhase({ step: "opening" })
    let open = await openPackPatient(txId, sol.address)
    for (let i = 0; open.status === "opening" && i < 20; i++) {
      await sleep(open.retryAfterMs || 3000)
      open = await openPackPatient(txId, sol.address)
    }
    if (open.status !== "completed") {
      // Provably NOT lost: open is idempotent and a `confirmed` transaction has
      // no deadline, so the pack sits there until someone opens it. Throwing
      // painted that as a red failure on a pack the user had already paid for;
      // the journal stays and the next pull resumes right here.
      setPhase({ step: "still_opening" })
      return
    }
    clearJournal(sol.address)
    setPhase({
      step: "revealed",
      card: open.card,
      sellTarget: { kind: "slabz", txId: open.transactionId },
      soldCents: open.card.autoSold ? open.card.autoSoldCents : null,
    })
    primeQuote(open.transactionId, open.card.autoSold)
    if (open.card.autoSold) await bridgeAutoSold(sol)
  }

  /** One tx of a bulk batch: poll open to completion, return the card. */
  async function openOneCard(sol: ConnectedStandardSolanaWallet, txId: string): Promise<OpenedCard> {
    let open = await openPackPatient(txId, sol.address)
    for (let i = 0; open.status === "opening" && i < 20; i++) {
      await sleep(open.retryAfterMs || 3000)
      open = await openPackPatient(txId, sol.address)
    }
    if (open.status !== "completed") throw new Error("still opening")
    return open.card
  }

  /** Open a whole batch concurrently. The journal is cleared only when every
   *  tx is terminal — stragglers keep it so the next pull resumes them. */
  async function openBulk(
    sol: ConnectedStandardSolanaWallet,
    txIds: string[],
    missing: number,
  ) {
    bulkRun.current = true
    setPhase({ step: "opening" })
    const results = await Promise.allSettled(txIds.map((id) => openOneCard(sol, id)))
    const cards = results
      .filter((r): r is PromiseFulfilledResult<OpenedCard> => r.status === "fulfilled")
      .map((r) => r.value)
    const pending = results.length - cards.length
    if (pending === 0) clearJournal(sol.address)
    setPhase({ step: "revealed_bulk", cards, missing, pending })
    // turbo payouts must not strand on Solana — one sweep for the whole batch
    if (cards.some((c) => c.autoSold)) await bridgeAutoSold(sol)
  }

  /** Resume a bulk batch: completed txs re-read via GET (re-opening 409s),
   *  never-charged ones (created/failed/expired) drop out as `missing`. */
  async function finishBulk(
    sol: ConnectedStandardSolanaWallet,
    txIds: string[],
    journalTs: number,
  ) {
    bulkRun.current = true
    setPhase({ step: "opening" })
    const results = await Promise.allSettled(
      txIds.map(async (id): Promise<OpenedCard | null> => {
        let tx: SlabzTx | null
        try {
          tx = await getTransaction(id)
        } catch (e) {
          // fail closed: only a 404 proves the tx dead — a transient error
          // must keep the journal, same as the single-pull resume
          if (!(e instanceof SlabzError && e.status === 404)) throw e
          tx = null
        }
        // same race as the single resume: a submit in flight when the tab died
        // can land seconds later — a `created` tx may be PAID. Poll before
        // declaring it dead, or the charge vanishes with no card behind it.
        for (let i = 0; tx?.status === "created" && Date.now() - journalTs < 120_000 && i < 6; i++) {
          await sleep(5000)
          tx = await getTransaction(id).catch(() => tx)
        }
        if (!tx || tx.status === "created" || tx.status === "failed" || tx.status === "expired")
          return null // signed copy died with the page — never charged
        const card = tx.card && "name" in tx.card ? (tx.card as OpenedCard) : null
        if (tx.status === "completed" && card) return card
        return openOneCard(sol, id)
      }),
    )
    const settled = results
      .filter((r): r is PromiseFulfilledResult<OpenedCard | null> => r.status === "fulfilled")
      .map((r) => r.value)
    const cards = settled.filter((c): c is OpenedCard => c !== null)
    const missing = settled.length - cards.length
    const pending = results.length - settled.length
    if (pending === 0) clearJournal(sol.address)
    setPhase({ step: "revealed_bulk", cards, missing, pending })
    if (cards.some((c) => c.autoSold)) await bridgeAutoSold(sol)
  }

  /** Turbo auto-sold: Slabz already paid the wallet — move it to the HL
   *  balance now or it strands on Solana. */
  async function bridgeAutoSold(sol: ConnectedStandardSolanaWallet) {
    if (!evmWallet) return
    setAutoBridge("sending")
    try {
      await bridgeBackToBalance({ solAddress: sol.address, evmWallet, sign: makeSign(sol) })
      setAutoBridge("done")
    } catch {
      setAutoBridge("failed")
    }
  }

  /** Resume a journal that already has a Slabz tx: the charge may or may not
   *  have been committed — Slabz's status decides, never a guess.
   *  Docs-verified rules: a `completed` tx must be read via GET /transactions
   *  (re-calling open can 409 CONFLICT); `created` means our signed copy died
   *  with the page (it only ever lived in JS memory), but a submit may still
   *  be in flight — poll briefly before declaring it dead. */
  async function finishPull(
    sol: ConnectedStandardSolanaWallet,
    txId: string,
    journalTs: number,
  ) {
    setPhase({ step: "opening" })
    // fail closed on the first read: only a 404 proves the tx dead — clearing
    // the journal on a transient error orphans a live purchase (Your pulls has
    // no open button, and the next pull would re-bridge a second $30)
    let tx: SlabzTx | null
    try {
      tx = await getTransaction(txId)
    } catch (e) {
      if (!(e instanceof SlabzError && e.status === 404))
        throw new Error("Couldn't check your pull — nothing changed. Try again in a moment.")
      tx = null
    }
    // a submit that was in flight when the tab died can land seconds later —
    // don't re-purchase until the tx is provably stuck in `created`
    for (let i = 0; tx?.status === "created" && Date.now() - journalTs < 120_000 && i < 6; i++) {
      await sleep(5000)
      tx = await getTransaction(txId).catch(() => tx)
    }
    if (!tx || tx.status === "created" || tx.status === "failed" || tx.status === "expired") {
      clearJournal(sol.address)
      throw new Error(
        "That pull never completed and your balance wasn't charged — pull again to use the funds already in your pack wallet.",
      )
    }
    if (tx.status === "completed") {
      // Slabz types card as OpenedCard | {} — presence of `name` decides
      const card = tx.card && "name" in tx.card ? (tx.card as OpenedCard) : null
      if (card) {
        clearJournal(sol.address)
        setPhase({
          step: "revealed",
          card,
          sellTarget: { kind: "slabz", txId },
          soldCents: card.autoSold ? card.autoSoldCents : null,
        })
        primeQuote(txId, card.autoSold)
        // same as the live-open path: an auto-sold payout must not sit
        // silently in the pack wallet just because this was a resume
        if (card.autoSold) await bridgeAutoSold(sol)
        return
      }
    }
    await openAndReveal(sol, txId)
  }

  async function doPull(auto: boolean) {
    if (!pack || !evmWallet) return
    setPhase({ step: "preparing" })
    setPoppedOpen(false) // fresh pack per pull — re-arm the rip
    setStatsDone(false)
    setAutoBridge(null)
    const sol = await ensureSolWallet()
    const sign = makeSign(sol)

    let journal = loadJournal(sol.address)
    // one journal slot per wallet, but committed money is pack-agnostic: an
    // unopened purchase reveals ITS card, and a filled pay-in is just USDC in
    // the shared pack wallet (the funded check below reuses it). Resume by the
    // journal's OWN pack so a pull from another pack's page can neither
    // overwrite it nor deadlock on a pack that vanished from the catalog.
    const foreign = !!journal && journal.packId !== pack.id
    const resume = nextPullAction(journal, journal?.packId ?? pack.id)

    if (resume.kind === "open") return finishPull(sol, resume.slabzTxId, journal?.ts ?? 0)
    if (resume.kind === "open_bulk") return finishBulk(sol, resume.slabzTxIds, journal?.ts ?? 0)

    if (resume.kind === "await_fill") {
      // a previous pay-in may still be filling — NEVER mint a second quote
      // until this resolves (double-$30)
      setPhase({ step: "funding" })
      const s = await pollFill(resume.checkEndpoint, 5 * 60_000)
      if (s === "failure" || s === "refund") {
        clearJournal(sol.address)
        journal = null
      } else if (s === "waiting" && Date.now() - (journal?.ts ?? 0) > 30 * 60_000) {
        // "waiting" = Relay never saw a deposit (status v3). A quote whose tab
        // died before signing stays "waiting" forever — funded ones move to
        // pending/refund. 30 min past mint it's long expired and unfundable,
        // so restarting fresh can't double-charge.
        clearJournal(sol.address)
        journal = null
      } else if (s !== "success") {
        // funded-but-slow: Relay refunds unfilled deposits after their TTL, so
        // this resolves to refund (→ fresh) or success (→ purchase) later
        throw new Error(
          "Your payment is still processing — pull again in a minute to resume. If it lands without a pull, it returns to your balance on its own.",
        )
      }
    }

    // auto-resume finishes committed flows only (open resume, same-pack fill).
    // Past this line every step spends money — a bare page load must never
    // reach it without a click (the embedded wallet signs headlessly).
    if (auto && (journal == null || foreign)) {
      setPhase({ step: "idle" })
      return
    }

    // free pack — no bridge, no purchase, nothing charged. Two ways in: a
    // gift that already exists (?gift= deep link, packs-page banner) or an
    // unredeemed entitlement we mint into one right here. The mint spends
    // HOUSE money, so it hangs off the click and nothing else: the `auto`
    // guard above is what keeps a bare page load from ever reaching it.
    // One pack per click (Slabz has no bulk claim). The journal makes the
    // open resumable exactly like a paid pull; a journal that's still
    // resolving above takes priority over starting a fresh claim.
    let freeGift = (gift?.packsRemaining ?? 0) > 0 ? gift : null
    if (!freeGift && credit && journal == null) {
      setPhase({ step: "claiming" })
      // clear the entitlement on ANY outcome, success or not. A failed mint
      // (dry funder, Slabz down) must not leave the button promising "free"
      // forever — that would lock a paying customer out of a paid pull. The
      // row itself is untouched by this: the server released it, so it
      // reappears on the packs page and on the next peek.
      const { giftId } = await claimFreeCredit(pack.id, sol.address).finally(() =>
        setCredit(null),
      )
      const minted = await getGift(giftId).catch(() => null)
      if (minted) setGift(minted)
      if (!minted || minted.status !== "confirmed" || minted.packsRemaining < 1)
        // the house already paid; the gift just hasn't settled. It shows up on
        // the packs page by receiver address, so send them there rather than
        // burning a second credit on a retry.
        throw new Error(
          "Your free pack is on its way — open it from the packs page in a moment.",
        )
      freeGift = minted
    }
    if (freeGift && freeGift.packsRemaining > 0 && journal == null) {
      setPhase({ step: "claiming" })
      const signMsg: SignSolanaMessage = async (message) =>
        (await signMessage({ message, wallet: sol })).signature
      const txId = await claimGiftPack({
        giftId: freeGift.giftId,
        solAddress: sol.address,
        signMessage: signMsg,
      })
      saveJournal(sol.address, {
        packId: pack.id,
        priceCents: pack.priceCents, // journal shape wants it; nothing is charged
        slabzTxId: txId,
        ts: Date.now(),
      })
      setGift({
        ...freeGift,
        packsClaimed: freeGift.packsClaimed + 1,
        packsRemaining: freeGift.packsRemaining - 1,
      })
      return openAndReveal(sol, txId)
    }

    // skip-bridge: crash recovery and sale-proceeds reuse — an already-funded
    // wallet re-enters at the purchase without paying again. A foreign
    // journal's price is another pack's — the threshold is always THIS pack's.
    // A resumed journal also pins the pull's own count: the preset row may have
    // changed since the money committed.
    const pullCount = journal != null && !foreign ? (journal.count ?? 1) : qty
    const priceCents =
      journal != null && !foreign ? journal.priceCents : pack.priceCents * pullCount
    // fail closed: an RPC hiccup must read as "can't check", never as
    // "unfunded" — re-charging an already-funded wallet is the worse failure
    const units = await usdcUnits6(sol.address).catch(() => null)
    if (units == null)
      throw new Error("Couldn't check your pack wallet — nothing was charged. Try again.")
    let funded = units >= BigInt(priceCents) * BigInt(10_000)

    if (!funded) {
      setPhase({ step: "funding" })
      // one-balance: Relay draws perps USDC — top up from spot BEFORE quoting
      // (quotes are short-lived; the cover signature mustn't eat the TTL).
      // Cover the marked-up total, not the bare pack price.
      const needUsd = (displayCents(pack) * pullCount) / 100
      // Sellback money lands on HyperEVM; pack money is drawn from Hyperliquid. If the
      // trading side is short and the EVM wallet covers the gap, move it first -- one
      // extra signature -- instead of sending the guest to Deposit with cash in hand.
      if (HYPEREVM_ENABLED) {
        const avail = await getBalanceParts(evmWallet.address)
          .then((p) => p.perpsWithdrawable + p.spotUsdc.free)
          .catch(() => null)
        if (avail !== null && avail < needUsd) {
          const gap = BigInt(Math.ceil((needUsd - avail) * 1e6)) + BigInt(10_000) // +1c rounding
          const evm = await readHyperEvmFunds(evmWallet.address as `0x${string}`).catch(() => null)
          if (evm && evm.usdc >= gap) {
            await moveUsdcToHyperCore(evmWallet, gap)
            // the credit is a system tx a few seconds out; wait for Core to show it
            for (let i = 0; i < 15; i++) {
              await new Promise((r) => setTimeout(r, 2000))
              const now = await getBalanceParts(evmWallet.address)
                .then((p) => p.perpsWithdrawable + p.spotUsdc.free)
                .catch(() => null)
              if (now !== null && now >= needUsd) break
            }
          }
        }
      }
      await coverPerpsFromSpot(evmWallet, needUsd)
      for (let attempt = 0; ; attempt++) {
        // quote route scales price+markup by count — one bridge funds the batch
        const q = await getPayinQuote(pack.id, sol.address, evmWallet.address, pullCount)
        if (q.totalCents > displayCents(pack) * pullCount) {
          // Slabz repriced above what the button showed — never charge more
          // than the user clicked. Refresh the price and make them re-confirm.
          setPack({ ...pack, priceCents: q.priceCents / pullCount })
          throw new Error(
            `The price changed to ${usd(q.totalCents)} — nothing was charged. Pull again to confirm.`,
          )
        }
        saveJournal(sol.address, {
          packId: pack.id,
          priceCents: q.priceCents,
          count: pullCount,
          payinRequestId: q.quote.requestId,
          checkEndpoint: q.quote.deposit.check.endpoint,
          ts: Date.now(),
        })
        setPhase({ step: "signing" })
        try {
          await executeWithdraw(evmWallet, q.quote, () => {})
          break
        } catch (e) {
          if (e instanceof WithdrawTrackableError) {
            // funds moved (or may have) — keep polling well past the built-in
            // 90s; an HL→Solana fill can land minutes later
            setPhase({ step: "funding" })
            const s = await pollFill(q.quote.deposit.check.endpoint, 5 * 60_000)
            if (s === "success") break
            if (s === "failure" || s === "refund") {
              clearJournal(sol.address)
              throw new Error("The payment was refunded to your balance — nothing was charged. Try again.")
            }
            throw new Error(
              "Your payment is still processing — pull again in a minute to resume where you left off.",
            )
          }
          // nothing moved: a user rejection ends the pull; anything else
          // (expired quote, authorize 4xx) gets ONE automatic re-quote
          clearJournal(sol.address)
          if (isUserRejection(e)) {
            setPhase({ step: "idle" })
            return
          }
          if (attempt >= 1) throw e
        }
      }
      funded = true
    }

    // charge point: one purchase (or one batch) per journal entry, ever
    setPhase({ step: "confirming" })
    if (pullCount > 1) {
      // Persist the idempotency key BEFORE the call, exactly like the single
      // path below. This used to mint a fresh key per attempt, which made a
      // create response lost in transit (504, socket drop) a GUARANTEED second
      // batch on retry — ten packs charged twice. Replaying the key gives Slabz
      // the chance to answer with the original batch instead. A key-only
      // journal still resolves to `fresh`, and the skip-bridge check sends the
      // already-funded wallet straight back here.
      //
      // Still missing, and still worth doing: the GET /bulk-purchases/:bulkId
      // reconcile, so a conflict we can't decode recovers the batch instead of
      // asking the user to look. Bulk conflict codes are assumed to match the
      // single path's — unverified against Slabz's docs for this endpoint.
      const bulkKey =
        (journal != null && !foreign ? journal.purchaseKey : undefined) ?? crypto.randomUUID()
      saveJournal(sol.address, {
        packId: pack.id,
        priceCents,
        count: pullCount,
        purchaseKey: bulkKey,
        ts: Date.now(),
      })
      let bulk
      try {
        bulk = await bulkPurchasePacks(pack.id, sol.address, pullCount, bulkKey, turboOk.current)
      } catch (e) {
        // Common stock depleted. Turbo is NOT a speed mode — with it on, a
        // common pull is AUTO-SOLD at open and the wallet gets USDC instead of
        // the NFT. Escalating silently changed what the user bought after they
        // clicked, so ask instead. TURBO_REQUIRED consumes nothing (fresh key
        // on the retry: reusing one with different params is an
        // IDEMPOTENCY_KEY_MISMATCH), so the throw costs the user nothing.
        if (e instanceof SlabzError && e.code === "PARTNER_TURBO_REQUIRED" && !turboOk.current) {
          turboOk.current = true
          // Drop the key: nothing was consumed, and the accepted retry sends
          // turbo=true — replaying the SAME key with changed params is an
          // IDEMPOTENCY_KEY_MISMATCH, which made every first Accept fail.
          saveJournal(sol.address, { packId: pack.id, priceCents, count: pullCount, ts: Date.now() })
          throw new Error(TURBO_CONSENT)
        }
        // Same as the single path: the persisted key is a poison pill unless its
        // conflict codes are handled, or every later attempt replays it into the
        // same 409 forever.
        if (e instanceof SlabzError) {
          if (e.code === "PARTNER_PURCHASE_IN_PROGRESS")
            throw new Error("That batch is still being created — try again in a moment.")
          if (e.code === "PARTNER_IDEMPOTENCY_KEY_MISMATCH") {
            // same key, different params ⇒ nothing happened for this batch
            saveJournal(sol.address, { packId: pack.id, priceCents, count: pullCount, ts: Date.now() })
            throw new Error("That pull didn't start — pull again.")
          }
          if (e.code === "PARTNER_IDEMPOTENCY_KEY_REUSED") {
            // The batch exists but we can't name its transactions without the
            // reconcile endpoint. Drop the spent key and send the user to look
            // rather than risk charging for a second batch.
            saveJournal(sol.address, { packId: pack.id, priceCents, count: pullCount, ts: Date.now() })
            throw new Error(
              "This pull may already have gone through — check your collection before paying again.",
            )
          }
        }
        throw e
      }
      const txIds = bulk.transactions.map((t) => t.transactionId)
      saveJournal(sol.address, {
        packId: pack.id,
        priceCents: bulk.totalPriceCents, // what the batch actually charges
        count: bulk.packCount,
        bulkTxIds: txIds,
        ts: Date.now(),
      })
      // Each tx embeds a blockhash good for 150 slots — "60 to 90 seconds" in
      // Solana's own words, cluster-wide and identical for every endpoint.
      // Collect every signature, then submit
      // concurrently (the docs' recommended shape).
      //
      // Privy's `signTransaction` IS variadic (solana.d.ts:261) and it is
      // tempting to read that as a batch. It is NOT: the implementation is a
      // sequential `for (const i of inputs) out.push(await ...)` loop
      // (3.36.1, dist/esm/solana.mjs), so N inputs cost N round trips exactly
      // like this loop. It buys no speed and no prompt consolidation (signing is
      // already headless). Don't "optimise" this into the variadic form again.
      // Order IS preserved there, if a future version ever batches for real.
      setPhase({ step: "signing" })
      const signed: [string, string][] = []
      for (const t of bulk.transactions)
        signed.push([t.transactionId, bytesToB64(await sign(b64ToBytes(t.transaction)))])
      setPhase({ step: "confirming" })
      await Promise.all(signed.map(([id, s]) => submitPatient(id, s)))
      return openBulk(sol, txIds, bulk.requestedCount - bulk.packCount)
    }
    // Persist the idempotency key BEFORE the call. A create response lost in
    // transit used to be unrecoverable — the code's own comment called that an
    // accepted write-down — because the journal was only written AFTER
    // purchasePack resolved. Replaying the same key makes Slabz answer with the
    // original transaction instead of minting (and charging for) a second pack.
    // A key-only journal still resolves to `fresh`, and the skip-bridge check
    // sends the already-funded wallet straight back here.
    const purchaseKey =
      (journal != null && !foreign ? journal.purchaseKey : undefined) ?? crypto.randomUUID()
    saveJournal(sol.address, {
      packId: pack.id,
      priceCents,
      count: pullCount,
      purchaseKey,
      ts: Date.now(),
    })
    let purchase
    try {
      purchase = await purchasePack(pack.id, sol.address, turboOk.current, purchaseKey)
    } catch (e) {
      // see the bulk branch: turbo swaps the card for USDC, so it needs consent
      if (e instanceof SlabzError && e.code === "PARTNER_TURBO_REQUIRED" && !turboOk.current) {
        turboOk.current = true
        // drop the key — the accepted retry changes params (turbo=true), and
        // replaying the same key with different params is a KEY_MISMATCH
        saveJournal(sol.address, { packId: pack.id, priceCents, count: pullCount, ts: Date.now() })
        throw new Error(TURBO_CONSENT)
      }
      // The idempotency key we just persisted is a POISON PILL unless its own
      // conflict codes are handled: every later attempt replays it and gets the
      // same 409 forever. Each of the three means something different.
      if (e instanceof SlabzError) {
        // The purchase already exists. Only KEY_REUSED carries the original id
        // (details.transactionId) — resume it rather than minting another.
        if (e.code === "PARTNER_IDEMPOTENCY_KEY_REUSED") {
          const id = (e.details as { transactionId?: string } | undefined)?.transactionId
          if (id) {
            saveJournal(sol.address, {
              packId: pack.id,
              priceCents,
              purchaseKey,
              slabzTxId: id,
              ts: Date.now(),
            })
            return finishPull(sol, id, Date.now())
          }
          // no id to resume: the key is spent, so the next attempt needs a fresh
          // one. Drop it and tell the user to look before paying again.
          saveJournal(sol.address, { packId: pack.id, priceCents, count: pullCount, ts: Date.now() })
          throw new Error(
            "This pull may already have gone through — check your collection before paying again.",
          )
        }
        // Mid-flight with this key: retrying the SAME key is the documented
        // recovery, and the journal already holds it.
        if (e.code === "PARTNER_PURCHASE_IN_PROGRESS")
          throw new Error("That pull is still being created — try again in a moment.")
        // Same key, different params ⇒ nothing happened for this transaction.
        // Clear the key so the retry mints a fresh one instead of re-conflicting.
        if (e.code === "PARTNER_IDEMPOTENCY_KEY_MISMATCH") {
          saveJournal(sol.address, { packId: pack.id, priceCents, count: pullCount, ts: Date.now() })
          throw new Error("That pull didn't start — pull again.")
        }
      }
      throw e
    }
    saveJournal(sol.address, {
      packId: pack.id,
      priceCents: purchase.priceCents ?? priceCents, // what Slabz actually charged
      purchaseKey,
      slabzTxId: purchase.transactionId,
      ts: Date.now(),
    })
    setPhase({ step: "signing" })
    const signed = await sign(b64ToBytes(purchase.transaction))
    setPhase({ step: "confirming" })
    await submitPatient(purchase.transactionId, bytesToB64(signed))
    await openAndReveal(sol, purchase.transactionId)
  }

  // What the primary CTA actually spends — named under the button so "Pay with
  // card" reads as the alternative rail, not a mystery twin. Withdrawable perps
  // margin + FREE spot USDC: what the funding leg can actually draw, not total
  // equity (accountValue counts open-position margin, spot `total` counts order
  // holds — both would overstate and set up a mid-flow funding failure).
  // Refreshes when a pull ends.
  const [availCents, setAvailCents] = useState<number | null>(null)
  // USDC sitting in the HyperEVM wallet (sellback proceeds). Counted as spendable on a pack:
  // doPull bridges the shortfall to Hyperliquid before it quotes.
  const [evmCents, setEvmCents] = useState<number>(0)
  useEffect(() => {
    if (!authenticated || !evmWallet || pulling) return
    let live = true
    getBalanceParts(evmWallet.address)
      .then((parts) => {
        if (live)
          setAvailCents(Math.round((parts.perpsWithdrawable + parts.spotUsdc.free) * 100))
      })
      // ponytail: keep the last good number; the line degrades to no amount
      .catch(() => {})
    if (HYPEREVM_ENABLED)
      readHyperEvmFunds(evmWallet.address as `0x${string}`)
        .then((f) => live && setEvmCents(Math.round(Number(f.usdc) / 10_000)))
        .catch(() => {})
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, evmWallet?.address, pulling])

  /** Free demo rip: the full tear → grading → reveal theater on a rarity
   *  rolled from the posted odds, no wallet and no money. Promoted from the
   *  dev-only rarity row (which now calls this with a pinned rarity) —
   *  packs.com's "Demo Open" is its single best comprehension feature, and
   *  all the machinery already existed here. */
  function demoPull(forcedRarity?: string) {
    let rarity = forcedRarity
    if (!rarity) {
      const odds = pack?.odds ?? []
      const roll = Math.random() * 100
      let acc = 0
      rarity = odds[0]?.tier ?? "common"
      for (const o of odds) {
        acc += o.probability
        if (roll < acc) {
          rarity = o.tier
          break
        }
      }
    }
    const pool = (cards ?? []).filter((c) => c.rarity.toLowerCase() === rarity!.toLowerCase())
    // no card of the rolled tier in the fetched pool → fall back to any card,
    // but then STAMP ITS OWN RARITY: the reveal must never dress a card in a
    // tier it doesn't have. A pinned (dev) rarity keeps its fabricated card.
    const c = pool.length
      ? pool[Math.floor(Math.random() * pool.length)]
      : forcedRarity
        ? undefined
        : (cards ?? [])[0]
    if (!forcedRarity && c) rarity = c.rarity
    setQty(1) // the rip theater only mounts for single pulls
    setRevealQuote(null) // a previous REAL pull's quote must not leak into the demo
    void prebuildPack(artKey)
    setPhase({
      step: "revealed",
      card: {
        nftMint: "demo",
        name: c?.name ?? `Demo ${rarity}`,
        rarity,
        insuredValueCents: c?.insuredValueCents ?? 12500,
        imageUrl: c?.imageUrl ?? null,
        autoSold: false,
        autoSoldCents: null,
      },
      sellTarget: { kind: "demo" },
      soldCents: null,
    })
  }

  // One definition for the four render slots (desktop/mobile × signed-out/
  // beta-gated). NOT `onClick={demoPull}` — that would pass the MouseEvent as
  // demoPull's forcedRarity.
  // ponytail: dev-only now — demo rip pulled from production, machinery kept
  // for the dev rarity row. Delete the gate to re-launch it publicly.
  const demoRipButton = (className: string) =>
    process.env.NODE_ENV === "development" && !cellar ? (
      <button
        onClick={() => demoPull()}
        disabled={stale || cards === null}
        className={className}
      >
        Try a demo rip · free
      </button>
    ) : null

  /** The Cellar's pull through the pack's phases: signing → opening →
   *  revealed. Always one pack. The theater, the grading sheet and the reveal
   *  are the pack's own — a bottle arrives as an OpenedCard graded off its
   *  live buyback quote (toCard), so nothing downstream knows it's wine. */
  async function doWinePull() {
    setPhase({ step: "signing" })
    let prizes
    try {
      prizes = await wine.play(1, () => setPhase({ step: "opening" }))
    } catch (e) {
      // a declined signature ends the pull quietly, as a declined payment does
      if (isUserRejection(e)) {
        setPhase({ step: "idle" })
        return
      }
      if ((e as { code?: string })?.code) throw e // route errors keep their words
      throw new Error(explainSignError(e).message)
    }
    // one pack = one bottle: a settle with none means nothing was drawn or charged
    const p = prizes[0]
    if (!p) throw new Error("The draw settled with no bottle — nothing was charged.")
    const offers = await wine.offersFor([p])
    const o = offers[prizeKey(p)]
    bulkRun.current = false
    setRevealQuote(o ? { available: o.sellable, offerCents: offerCents(o), payoutCents: offerCents(o) } : null)
    setPhase({
      step: "revealed",
      card: toCard(p, o, wine.pullUnits6),
      // preview bottles are never minted — the demo target hides the sell button
      sellTarget: wineConfigured()
        ? { kind: "wine", collection: p.collection, tokenId: BigInt(p.tokenId) }
        : { kind: "demo" },
      soldCents: null,
    })
  }

  async function pull(auto = false) {
    if (inFlight.current) return
    // Warm the rip: the Slabz GLB + face art, fetched + parsed while the
    // payment signs, so the theater opens on a built pack instead of a spinner.
    void prebuildPack(artKey)
    const release = takeMoneyLock()
    if (!release) {
      setPhase({ step: "error", message: "Another transfer is in progress — wait for it to finish." })
      return
    }
    inFlight.current = true
    setPulling(true)
    try {
      // The Cellar has no journal to resume — a page load must never sign a
      // wine authorisation headlessly, so `auto` does nothing here.
      if (cellar) {
        if (!auto) {
          if (wineCovered) await wine.moveFromBalance(wineShort) // one balance: top the wallet up first
          await doWinePull()
        }
      } else await doPull(auto)
    } catch (e) {
      if (
        ((e instanceof GachaApiError || e instanceof SlabzError) &&
          e.code === "NOT_ALLOWLISTED") ||
        (e as { code?: string })?.code === "NOT_ALLOWLISTED"
      ) {
        setAllowed(false)
        setPhase({ step: "idle" })
        return
      }
      // the turbo escalation is a choice to offer, not a failure to report
      if (e instanceof Error && e.message === TURBO_CONSENT) {
        setPhase({ step: "turbo_offer" })
        return
      }
      setPhase({
        step: "error",
        message:
          (e instanceof SlabzError || e instanceof GachaApiError) && e.code === NOT_CONFIGURED
            ? "Pack service isn't configured on this deployment."
            : e instanceof Error
              ? e.message
              : String(e),
      })
    } finally {
      inFlight.current = false
      setPulling(false)
      release()
    }
  }

  /** Card entry: open the card dialog (Coinflow or Crossmint rail) for THIS
   *  pull's total. Anything already committed (journal) or already funded
   *  resumes through pull() instead — a card charge on top of either would
   *  double-pay. */
  async function payWithCard(rail: "coinflow" | "crossmint") {
    if (inFlight.current || !pack) return
    setPhase({ step: "preparing" })
    try {
      const sol = await ensureSolWallet()
      const j = loadJournal(sol.address)
      if (j && nextPullAction(j, j.packId).kind !== "fresh") {
        setPhase({ step: "idle" })
        return pull()
      }
      const units = await usdcUnits6(sol.address).catch(() => null)
      if (units != null && units >= BigInt(pack.priceCents * qty) * BigInt(10_000)) {
        setPhase({ step: "idle" })
        return pull() // wallet already covers it — never charge the card too
      }
      setPhase({ step: "idle" })
      setCardRail(rail)
      setCardFor(sol)
    } catch (e) {
      setPhase({ step: "error", message: e instanceof Error ? e.message : String(e) })
    }
  }

  // resume an interrupted pull on load — money may already be committed.
  // Resolved by the journal's OWN pack (finishable from any pack page);
  // auto=true stops doPull before anything newly chargeable — a page load
  // must never trigger a headless signature.
  useEffect(() => {
    if (!pulling) {
      setElapsed(0)
      return
    }
    const t0 = Date.now()
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(id)
  }, [pulling])

  const resumed = useRef(false)
  useEffect(() => {
    if (resumed.current || !pack || !evmWallet || !solWallet || phase.step !== "idle") return
    const j = loadJournal(solWallet.address)
    if (j && nextPullAction(j, j.packId).kind !== "fresh") {
      resumed.current = true
      pull(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pack, evmWallet, solWallet])

  // sell wiring for the Reveal, per flow
  function sellHandlers(target: SellTarget) {
    if (target.kind === "wine") {
      // The bottle: sign an EIP-712 Sell authorisation, the house relays it and
      // pays the quote to the HyperEVM wallet in the same tx. No gas, no bridge.
      const quote = async (): Promise<SellQuoteView | null> => {
        const o = await readOffer(target.collection, target.tokenId)
        return { available: o.sellable, offerCents: offerCents(o), payoutCents: offerCents(o) }
      }
      return {
        fetchQuote: quote,
        sell: async (_min: number, onSold?: (cents: number) => void) => {
          if (!evmWallet) throw new Error("Wallet unavailable")
          const q = await quote()
          if (!q?.available) throw new Error("Sell-back isn't open for this bottle right now.")
          let auth
          try {
            auth = await signSellAuthorization(evmWallet, target.collection, target.tokenId)
          } catch (e) {
            throw new Error(explainSignError(e).message)
          }
          const res = await fetch("/api/wine/sell", {
            method: "POST",
            headers: { ...(await privyAuthHeaders()), "Content-Type": "application/json" },
            body: JSON.stringify({
              owner: evmWallet.address,
              collection: target.collection,
              tokenId: target.tokenId.toString(), // bigint: JSON.stringify would throw
              deadline: auth.deadline,
              signature: auth.signature,
            }),
          })
          const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
          if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`)
          // the bottle is back on the shelf: its epoch just moved, so re-read before
          // the next pull pins against it
          wine.loadShelf()
          onSold?.(q.payoutCents)
          return q.payoutCents
        },
      }
    }
    if (target.kind === "demo") {
      // ponytail: canned quote + fake sell so the whole Reveal flow is clickable
      return {
        fetchQuote: async (): Promise<SellQuoteView | null> => ({
          available: true,
          offerCents: 500,
          payoutCents: 500,
        }),
        sell: async (_min: number, onSold?: (cents: number) => void) => {
          await sleep(400)
          onSold?.(500) // sale commits here; the "bridge" is the rest of the wait
          await sleep(800)
          return 500
        },
      }
    }
    return {
      fetchQuote: async (): Promise<SellQuoteView | null> => {
        const q = await buybackQuote(target.txId)
        // no sellback fee — the user gets the full offer
        return { available: q.available, offerCents: q.offerCents, payoutCents: q.offerCents }
      },
      sell: async (minOfferCents: number, onSold?: (cents: number) => void) => {
        if (!evmWallet) throw new Error("Wallet unavailable")
        const release = takeMoneyLock()
        if (!release) throw new Error("Another transfer is in progress — wait for it to finish.")
        try {
          const sol = await ensureSolWallet()
          return await sellToSlabz({
            txId: target.txId,
            solAddress: sol.address,
            evmWallet,
            sign: makeSign(sol),
            minOfferCents,
            onSold,
          })
        } finally {
          release()
        }
      },
    }
  }

  if (loadErr) {
    return (
      <div className="mx-auto max-w-2xl rounded-2xl border border-border bg-surface p-8 text-center text-sm text-muted-foreground">
        Couldn&apos;t load this pack — the pack service is acting up.{" "}
        <button onClick={load} className="text-brand">Try again</button>
      </div>
    )
  }
  if (pack === undefined) {
    return <div className="h-96 animate-pulse rounded-2xl border border-border bg-surface" />
  }
  if (pack === null) {
    return (
      <div className="mx-auto max-w-2xl rounded-2xl border border-border bg-surface p-8 text-center text-sm text-muted-foreground">
        Pack not found. <Link href="/gacha" className="text-brand">Back to packs</Link>
      </div>
    )
  }

  const busy = [
    "preparing",
    "funding",
    "signing",
    "confirming",
    "claiming",
    "opening",
  ].includes(phase.step)
  // The tear IS the wait: it mounts the moment the user commits and the money
  // keeps moving behind it, so the rip stage is pseudo in ORDER only — nothing
  // is faked. The card is still withheld until the user actually tears (see
  // poppedOpen), so an early-arriving pull never skips the animation. A
  // rejection or failure drops to `error`, which unmounts this and puts the
  // message back on the page. Bulk pulls opt out: they open into one grid, so
  // there is no single pack to tear.
  const ripReady = qty === 1 && (pulling || phase.step === "revealed")
  // One label, not six. Five of the old six said the same thing to the user —
  // *wait* — and the sixth ("Sign in wallet…") promised a prompt that never
  // comes: the embedded Privy wallet signs headlessly, so most users went
  // hunting for a popup, which is exactly when a slow flow starts reading as
  // broken. The phase union stays (nextPullAction depends on it); only the copy
  // collapses.
  const needsSignature = phase.step === "signing" && evmWallet?.walletClientType !== "privy"
  const slow = elapsed >= SLOW_AFTER_S
  const busyLabel = needsSignature
    ? "Approve in your wallet"
    : slow
      ? `Still opening — ${elapsed}s`
      : "Opening your pack…"

  // Stable CTA: the label is the product and its price, and never morphs into
  // progress copy or a different product — progress lives in the status line
  // above the button, and turbo gets its own Accept/Cancel card.
  // ── the Cellar's numbers, in the pack's slots ──────────────────────────────
  // Same buy cluster, same button, same status line: only what the values
  // mean differs. Price = the pay token's price × qty (pickPayToken spends the
  // highest affordable id — Points before USDC). `short` gates only on a
  // balance we actually read; unread = "Checking…", never a dead button.
  const wp = cellar && wine.shelf ? pickPayToken(wine.shelf.tokens, wine.bal?.byToken ?? {}, qty) : null
  const wineUnitCents = wp ? Math.round(Number(wp.token.priceUnits6) / 10_000) : null
  const wineShort = wine.bal && wp && wp.shortfallUnits6 > BigInt(0) ? wp.shortfallUnits6 : BigInt(0)
  const wineShortCents = Math.round(ceilUsd(wineShort) * 100)
  // Short on the wallet side but the trading balance covers it: pull() moves the gap first,
  // so to the user there is one balance and the button just works.
  const wineCovered = wineShort > BigInt(0) && wine.fundable && availCents != null && availCents >= wineShortCents
  const wineChecking =
    cellar && wineConfigured() && authenticated && !!evmWallet && !!wine.shelf && !wine.bal
  const unitCents = cellar ? (wineUnitCents ?? 0) : displayCents(pack)
  const priceUnknown = cellar ? wineUnitCents == null : stale || freeUnknown
  const ctaLabel = cellar
    ? !wine.shelf
      ? "Loading…"
      : wine.shelf.prizeCount === 0
        ? "Restocking"
        : `Open ${qty > 1 ? `${qty} packs` : "pack"} · ${usd(unitCents * qty)}${
            wp && wp.token.id !== 0 ? ` in ${wp.token.symbol}` : ""
          }`
    : stale || freeUnknown
      ? "Loading…"
      : freeActive
        ? `Claim free pack${freePacksLeft > 1 ? ` · ${freePacksLeft} left` : ""}`
        : pack.isActive
          ? `Open ${qty > 1 ? `${qty} packs` : "pack"} · ${usd(displayCents(pack) * qty)}`
          : "Unavailable"
  const balanceLine = cellar
    ? !wineConfigured()
      ? "Preview — nothing is charged, nothing is minted."
      : wineChecking
        ? "Checking your balance…"
        : wineShort > BigInt(0) && !wineCovered
          ? `Need ${usd(Math.max(1, wineShortCents - (wine.fundable ? availCents ?? 0 : 0)))} more in your balance.`
          : "Paid from your balance"
    : availCents == null
      ? "Paid from your balance"
      : availCents + evmCents >= displayCents(pack) * qty
        ? `Paid from your balance — ${usd(availCents + evmCents)} available`
        : `Need ${usd(displayCents(pack) * qty - availCents - evmCents)} more — ${usd(availCents + evmCents)} available`
  const cancelTurbo = () => {
    turboOk.current = false
    setPhase({ step: "idle" })
  }
  // The buy cluster renders twice (desktop column, mobile order bar) with
  // different layout shells. Everything BEHAVIORAL is defined once here so the
  // two form factors cannot drift on a money button — only classNames differ.
  const ctaDisabled = cellar
    ? busy ||
      !wp ||
      !wine.shelf ||
      wine.shelf.prizeCount === 0 ||
      qty > wine.shelf.prizeCount ||
      wineChecking ||
      (wineShort > BigInt(0) && !wineCovered) ||
      !!wine.moving
    : busy || stale || freeUnknown || (!pack.isActive && !freeActive)
  // The Cellar's second rail, where a pack shows "Pay with card": the door to
  // fund the wallet the pull settles from. Bridge from the HL balance where
  // the shelf's USDC is the token the bridge delivers (mainnet); the address
  // to fund otherwise.
  const secondaryCls =
    "mt-2 w-full rounded-xl border border-white/15 bg-black/80 py-2.5 text-sm transition-colors hover:text-brand disabled:opacity-40 disabled:pointer-events-none"
  const wineSecondary = wineConfigured() && authenticated && evmWallet && (
    <>
      {wineShort > BigInt(0) && !wine.fundable && (
        <button
          onClick={() => navigator.clipboard?.writeText(evmWallet.address)}
          className={secondaryCls}
        >
          Copy wallet address to fund it
        </button>
      )}
    </>
  )
  const turboCard = (
    <TurboConsent
      price={usd(displayCents(pack) * qty)}
      onAccept={() => pull()}
      onCancel={cancelTurbo}
    />
  )
  const busyStatus = (className: string) =>
    busy && (
      <p role="status" className={className}>
        {busyLabel}
      </p>
    )
  const balanceNote = (className: string) =>
    !busy &&
    showPaid &&
    (cellar || pack.isActive) && <p className={className}>{balanceLine}</p>

  const bridgeNote =
    autoBridge === "sending"
      ? "Sending the payout to your balance…"
      : autoBridge === "done"
        ? "Payout added to your balance"
        : autoBridge === "failed"
          ? "Payout is in your pack wallet — moving it back to your balance"
          : null

  return (
    <>
      {/* Ground + pack, the bottom layer of the screen.
          `fixed inset-0` is the SAME box the rip theater uses, deliberately:
          one framing, so the pack doesn't jump or resize the instant the tear
          opens over it. It covers nothing — pointer-events-none keeps it out of
          hit-testing, and every later sibling (chrome) plus the header (z-10)
          paints above it. The bg is the page's own, not black, and it stays
          mounted when the pack doesn't so the app footer never reads through.
          The pack unmounts whenever something else owns the screen — a panel,
          the theater — so we never hold two WebGL contexts or light the GPU for
          a canvas nobody can see. */}
      <div className="pointer-events-none fixed inset-0 bg-background">
        {/* Panels are side cards now, not stage replacements — the pack stays
            up behind them. Only the theater unmounts it (one WebGL context). */}
        {!ripReady && !poppedOpen && (
          // keyed: PackRip's GL scene is mount-once, and pack switches no
          // longer remount the page — a family change must swap the art here.
          // Keyed by FAMILY so tier switches keep the live canvas (no flash).
          // ponytail: all shipped prints are per-family; key by full ccPackType
          // if a per-pack print (<ccPackType>_front.webp) ever lands.
          <PackRip
            key={artKey?.split("_")[0] ?? "pack"}
            active={false}
            ccPackType={artKey}
            bottomInset={chromeBottom}
          />
        )}
      </div>

      {/* Chrome — rail and controls — on one screen, no scroll.
          `h-full` can't do this from inside <main>: <body> is `min-h-full`, so
          main's height is indefinite and a percentage height on a child
          collapses to auto — the page grew to its content and scrolled, which is
          the one thing a stage must not do. And main's padding is sized for a
          scrolling page plus a bottom nav this route hides, so a correct height
          would still sit inside ~7rem of dead space. So it takes the viewport
          directly, starting below the sticky header's own 4rem, with main's
          container gutters mirrored inside.
          No background: the ground layer above supplies it. And note this stays
          a SIBLING of the overlays below — `position: fixed` opens a stacking
          context, so anything nested in here has its z-index scoped to this
          layer, which is what buried the theater's z-50 under the z-10 header. */}
      <div className="gacha-stage fixed inset-x-0 bottom-0 top-16 overflow-hidden px-4">
        {/* No `container`: the pack behind this runs full-bleed, so capping the
            rail and controls to a centred column would stop the chrome short of
            a stage that doesn't stop. Only the buy cluster keeps a width, and it
            centres on the display. */}
        <div className="relative flex h-full min-h-0 w-full flex-col gap-4 py-4">
      {/* grid-cols-1 + min-w-0 are load-bearing: a bare `grid` is one implicit
          `auto` track, which sizes to MAX-content — the rail's horizontal
          scrollers then set a ~1200px track and the whole page scrolled
          sideways at every width below lg. min-h-0 + the explicit row track are
          what let the stage flex DOWN instead of pushing the page taller. */}
      <div className="relative grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-4 lg:grid-cols-[240px_minmax(0,1fr)_280px] lg:grid-rows-1 lg:gap-6">
        {/* The picker rail. Both selectors used to be a <select> and a 4-up
            price grid buried in the buy column below the fold; every option the
            catalog holds is now visible without a tap. Desktop stacks it,
            mobile scrolls it sideways — same markup, no second component. */}
        <aside className="flex min-h-0 min-w-0 flex-col gap-4 lg:overflow-y-auto">
          {/* Both selector rails live in the bottom controls on mobile now —
              universe in a bottom sheet, packs as pills. Desktop keeps the
              stacked rail. */}
          {families.length > 1 && (
            <div className="max-lg:hidden">
              <p className="mb-2 text-[10px] uppercase tracking-widest text-muted-foreground">
                01 — Pick a universe
              </p>
              <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:grid lg:grid-cols-3 lg:overflow-visible lg:px-0 lg:pb-0">
                {families.map((ps) => {
                  const f = packFamily(ps[0].name)
                  return (
                    <button
                      key={f}
                      onClick={() => selectPack(ps[0].id)}
                      aria-pressed={f === familyName}
                      className={`flex shrink-0 flex-col items-center gap-1 rounded-xl border px-2 py-2 transition ${
                        f === familyName
                          ? "beam-selected border-transparent bg-brand/15 text-brand"
                          : "border-border bg-surface text-muted-foreground hover:border-brand/50 hover:text-foreground"
                      }`}
                    >
                      <span aria-hidden className="text-xl leading-none">
                        {universeIcon(f)}
                      </span>
                      <span className="max-w-16 truncate text-[10px] uppercase tracking-wide">
                        {f}
                      </span>
                      <span aria-hidden className="beam-bloom" />
                    </button>
                  )
                })}
                {/* The Cellar is a universe you pick, not a banner further
                    down the page. Disabled while it's soon: the badge already
                    says so, and a tile that navigates to a coming-soon page is
                    a tap that costs the user the stage for nothing. Appended
                    rather than merged into `families` — a wine gacha on its own
                    rail, not a pack. */}
                {cellarLive ? (
                  <button
                    onClick={() => selectPack("cellar")}
                    aria-pressed={cellar}
                    className={`relative flex shrink-0 flex-col items-center gap-1 rounded-xl border px-2 py-2 transition ${
                      cellar
                        ? "beam-selected border-transparent bg-brand/15 text-brand"
                        : "border-border bg-surface text-muted-foreground hover:border-brand/50 hover:text-foreground"
                    }`}
                  >
                    <span aria-hidden className="text-xl leading-none">
                      🍷
                    </span>
                    <span className="max-w-16 truncate text-[10px] uppercase tracking-wide">
                      Cellar
                    </span>
                    <span aria-hidden className="beam-bloom" />
                  </button>
                ) : (
                <button
                  type="button"
                  disabled
                  aria-label="Cellar — coming soon"
                  className="relative flex shrink-0 cursor-not-allowed flex-col items-center gap-1 rounded-xl border border-border bg-surface px-2 py-2 text-muted-foreground opacity-60"
                >
                  <span aria-hidden className="text-xl leading-none">
                    🍷
                  </span>
                  <span className="max-w-16 truncate text-[10px] uppercase tracking-wide">
                    Cellar
                  </span>
                  <span className="absolute right-1 top-1 rounded-full bg-surface-2 px-1 text-[8px] uppercase tracking-widest">
                    Soon
                  </span>
                </button>
                )}
              </div>
            </div>
          )}
          {siblings.length > 1 && (
            <div className="max-lg:hidden">
              <p className="mb-2 text-[10px] uppercase tracking-widest text-muted-foreground">
                02 — Choose a pack{" "}
                <span className="normal-case tracking-normal">· pricier holds better cards</span>
              </p>
              <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
                {siblings.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => selectPack(s.id)}
                    aria-pressed={s.id === packId}
                    className={`flex shrink-0 items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-sm transition ${
                      s.id === packId
                        ? "beam-selected border-transparent bg-brand/15 text-brand"
                        : "border-border bg-surface text-muted-foreground hover:border-brand/50 hover:text-foreground"
                    }`}
                  >
                    <span className="truncate">{s.name}</span>
                    <span className="shrink-0 font-mono text-xs tabular-nums">
                      {usdWhole(displayCents(s))}
                    </span>
                    <span aria-hidden className="beam-bloom" />
                  </button>
                ))}
              </div>
            </div>
          )}
          {/* The tab row that used to carry this is gone; a rip stage doesn't
              need three tabs of chrome over it, but the collection still needs
              a door. One line at the foot of the picker, slabz's own placement
              for its secondary links. */}
          <div className="flex items-center gap-4 max-lg:order-first lg:mt-auto lg:flex-col lg:items-start lg:gap-2 lg:pt-4">
            {/* Desktop docks the collection on the right permanently, so this
                toggle only exists below lg, where the panel is an overlay. */}
            <button
              onClick={() => setPanel((p) => (p === "collection" ? null : "collection"))}
              aria-expanded={panel === "collection"}
              className="text-left text-[11px] uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground lg:hidden"
            >
              Your collection →
            </button>
            <button
              onClick={() => setPanel((p) => (p === "help" ? null : "help"))}
              aria-expanded={panel === "help"}
              className="text-left text-[11px] uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
            >
              How it works →
            </button>
          </div>
        </aside>

        {/* Below lg the collection and the FAQ arrive as a bottom sheet — the
            same Drawer the universe picker uses, reached from the thumb rather
            than as a card wedged between the pack and the controls. Desktop
            docks the same content in the column below instead.
            Gated on !isDesktop rather than `lg:hidden`: the sheet portals to
            <body>, so a responsive class on a wrapper here can never reach it.
            A definite height is required, not `auto` — the inner scroller is
            the whole point, and against an auto-height popup it collapses. */}
        {!isDesktop && (
          <Drawer
            open={panel === "help" || panel === "collection"}
            onOpenChange={(open) => {
              if (!open) setPanel(null)
            }}
            showSwipeHandle
          >
            <DrawerContent className="[--drawer-height:72dvh]">
              <DrawerHeader className="flex-row items-center justify-between pb-2">
                <DrawerTitle className="text-xs uppercase tracking-widest text-muted-foreground">
                  {panel === "help" ? "How it works" : "Your collection"}
                </DrawerTitle>
                <DrawerClose
                  aria-label="Close"
                  className="flex size-8 items-center justify-center rounded-full bg-surface text-muted-foreground transition-colors hover:text-foreground"
                >
                  ✕
                </DrawerClose>
              </DrawerHeader>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
                {panel === "help" ? (
                  <PackFooter className="[&>div]:mt-0" />
                ) : (
                  <CollectionPanel
                    authenticated={authenticated}
                    walletsReady={solReady}
                    address={solWallet?.address}
                    evmAddress={evmWallet?.address}
                  />
                )}
              </div>
            </DrawerContent>
          </Drawer>
        )}

        {/* THE right panel — docked in the right corner at lg+, dressed like
            the picker rail (bare column, no card box) so it reads as chrome,
            not as a dialog over the stage. Collection at rest; "How it works"
            swaps it for the FAQ until closed. Mounted only on desktop so
            mobile doesn't pay the collection fetch for a column it can never
            see. */}
        {isDesktop && (
          // the mobile overlay column is display:none at lg and leaves grid
          // flow, so without the explicit start this lands in the 1fr track
          <aside className="hidden min-h-0 flex-col gap-2 lg:col-start-3 lg:flex">
            <div className="flex items-baseline justify-between">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
                {panel === "help" ? "How it works" : "Your collection"}
              </p>
              {panel === "help" && (
                <button
                  onClick={() => setPanel(null)}
                  aria-label="Back to your collection"
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  ✕
                </button>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {panel === "help" ? (
                <PackFooter className="[&>div]:mt-0" />
              ) : (
                <CollectionPanel
                  authenticated={authenticated}
                  walletsReady={solReady}
                  address={solWallet?.address}
                  evmAddress={evmWallet?.address}
                />
              )}
            </div>
          </aside>
        )}
      </div>

        {/* Controls, in flow at the foot of the SHELL — not of the stage
            column. Inside the column they centred on the column, which is the
            1fr track to the right of the rail, so the rip button sat off-centre
            while the pack it belongs to was centred on the screen. Out here
            `mx-auto` is the middle of the display, same as the pack.
            Absolute, not a flow sibling: in flow it took its height off the grid
            and the rail lost half its tiers to it. */}
        <div
          ref={controlsRef}
          className="absolute inset-x-0 bottom-0 pt-3 pb-[env(safe-area-inset-bottom)]"
        >
          <div className="mx-auto w-full max-w-xl">
            {/* The disclosure sits with the controls, not with the content it
                opens — it is an action, and every action on this page is here. */}
            <button
              onClick={() => setPanel((p) => (p === "inside" ? null : "inside"))}
              aria-expanded={panel === "inside"}
              className="mx-auto mb-2 flex items-center gap-2 rounded-full border border-white/15 bg-black/80 px-4 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <span aria-hidden>◆</span>
              {panel === "inside" ? "Back to the pack" : "See what's inside"}
            </button>
          {/* Mobile selectors, slabz-style: universe behind a bottom sheet,
              packs as pills next to it. Desktop keeps the left rail. */}
          {(families.length > 1 || siblings.length > 1) && (
            <div className="mb-2 flex items-center gap-2 lg:hidden">
              {families.length > 1 && (
                <Drawer open={universeSheet} onOpenChange={setUniverseSheet} showSwipeHandle>
                  <DrawerTrigger
                    aria-label="Pick a universe"
                    className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-white/15 bg-black/80 px-3 transition-colors hover:text-foreground"
                  >
                    <span aria-hidden className="text-lg leading-none">
                      {cellar ? "🍷" : familyName ? universeIcon(familyName) : "❔"}
                    </span>
                    <span aria-hidden className="text-[10px] text-muted-foreground">▾</span>
                  </DrawerTrigger>
                  <DrawerContent>
                    <DrawerHeader className="flex-row items-center justify-between pb-2">
                      <DrawerTitle className="text-xs uppercase tracking-widest text-muted-foreground">
                        Pick a universe
                      </DrawerTitle>
                      <DrawerClose
                        aria-label="Close"
                        className="flex size-8 items-center justify-center rounded-full bg-surface text-muted-foreground transition-colors hover:text-foreground"
                      >
                        ✕
                      </DrawerClose>
                    </DrawerHeader>
                    <div className="grid grid-cols-3 gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
                      {families.map((ps) => {
                        const f = packFamily(ps[0].name)
                        return (
                          <button
                            key={f}
                            onClick={() => {
                              setUniverseSheet(false)
                              selectPack(ps[0].id)
                            }}
                            aria-pressed={f === familyName}
                            className={`flex flex-col items-center gap-2 rounded-xl border px-2 py-4 transition ${
                              f === familyName
                                ? "beam-selected border-transparent bg-brand/15 text-brand"
                                : "border-border bg-surface text-muted-foreground hover:border-brand/50 hover:text-foreground"
                            }`}
                          >
                            <span aria-hidden className="text-2xl leading-none">
                              {universeIcon(f)}
                            </span>
                            <span className="max-w-full truncate text-[10px] uppercase tracking-wide">
                              {f}
                            </span>
                            <span aria-hidden className="beam-bloom" />
                          </button>
                        )
                      })}
                      {cellarLive ? (
                        <button
                          onClick={() => {
                            setUniverseSheet(false)
                            selectPack("cellar")
                          }}
                          aria-pressed={cellar}
                          className={`relative flex flex-col items-center gap-2 rounded-xl border px-2 py-4 transition ${
                            cellar
                              ? "beam-selected border-transparent bg-brand/15 text-brand"
                              : "border-border bg-surface text-muted-foreground hover:border-brand/50 hover:text-foreground"
                          }`}
                        >
                          <span aria-hidden className="text-2xl leading-none">🍷</span>
                          <span className="max-w-full truncate text-[10px] uppercase tracking-wide">
                            Cellar
                          </span>
                          <span aria-hidden className="beam-bloom" />
                        </button>
                      ) : (
                      <div
                        aria-label="Cellar — coming soon"
                        className="relative flex flex-col items-center gap-2 rounded-xl border border-border bg-surface px-2 py-4 text-muted-foreground opacity-60"
                      >
                        <span aria-hidden className="text-2xl leading-none">🍷</span>
                        <span className="max-w-full truncate text-[10px] uppercase tracking-wide">
                          Cellar
                        </span>
                        <span className="absolute right-1 top-1 rounded-full bg-surface-2 px-1 text-[8px] uppercase tracking-widest">
                          Soon
                        </span>
                      </div>
                      )}
                    </div>
                  </DrawerContent>
                </Drawer>
              )}
              {siblings.length > 1 && (
                <div
                  ref={priceRail}
                  onScroll={syncRailFade}
                  className="-my-1 flex min-w-0 flex-1 gap-2 overflow-x-auto py-1"
                  style={{
                    maskImage: `linear-gradient(to right, ${railFade.l ? "transparent" : "#000"}, #000 20px, #000 calc(100% - 20px), ${railFade.r ? "transparent" : "#000"})`,
                  }}
                >
                  {siblings.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => selectPack(s.id)}
                      aria-pressed={s.id === packId}
                      className={`flex h-11 shrink-0 items-center gap-2 rounded-xl border px-3 text-sm transition ${
                        s.id === packId
                          ? "beam-selected border-transparent bg-brand/15 text-brand"
                          : "border-white/15 bg-black/80 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <span className="truncate">{s.name}</span>
                      <span className="shrink-0 font-mono text-xs tabular-nums">
                        {usdWhole(displayCents(s))}
                      </span>
                      <span aria-hidden className="beam-bloom" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {!authenticated ? (
            <>
              <button onClick={login} className="btn-brand w-full py-3.5 font-heading text-lg">
                Sign in to pull
              </button>
              {demoRipButton(
                "mt-2 w-full rounded-xl border border-white/15 bg-black/80 py-2.5 text-sm transition-colors hover:text-brand disabled:opacity-40 disabled:pointer-events-none",
              )}
            </>
          ) : !allowed ? (
            <>
              <p className="py-1 text-center text-xs text-muted-foreground">
                Closed beta — pulls unlock for everyone soon.
              </p>
              {demoRipButton(
                "mt-1 w-full rounded-xl border border-white/15 bg-black/80 py-2.5 text-sm transition-colors hover:text-brand disabled:opacity-40 disabled:pointer-events-none",
              )}
            </>
          ) : phase.step === "turbo_offer" ? (
            turboCard
          ) : (
            <>
              {/* While busy every control here is disabled — a wall of dead
                  buttons under the one line that matters. Collapse to the CTA. */}
              {!busy && (
              <div className="mb-3 flex items-center justify-between gap-3">
                {/* stale = previous tier's pack — its price must not flash */}
                {priceUnknown ? (
                  <span className="h-9 w-24 animate-pulse rounded-lg bg-white/10" />
                ) : (
                  <span className="font-heading text-3xl tabular-nums drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]">
                    {freeActive ? "Free 🎁" : usd(unitCents * qty)}
                  </span>
                )}
                {/* no presets on the Cellar: every wine pack is one bottle, one rip */}
                {showPaid && !cellar && (
                <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-black/80 p-1 shadow-[inset_0_1px_0_0_rgb(255_255_255/0.12)]">
                  {QTY_PRESETS.map((n) => (
                    <button
                      key={n}
                      onClick={() => setQty(n)}
                      disabled={busy}
                      aria-pressed={qty === n}
                      className={`h-9 min-w-10 rounded-lg px-2 text-sm tabular-nums transition-colors disabled:opacity-40 ${
                        qty === n ? "bg-white/15 text-brand" : "hover:text-brand"
                      }`}
                    >
                      ×{n}
                    </button>
                  ))}
                </div>
                )}
              </div>
              )}
              {/* An error about money has to sit next to the control that caused
                  it — half of these say "try again", and in the old buy column
                  this text could be scrolled entirely off-screen while the user
                  re-tapped the pinned button. */}
              {phase.step === "error" && (
                <p className="mb-2 text-center text-[11px] text-no">{phase.message}</p>
              )}
              {/* A bulk pull skips the rip, the grading sheet and the reveal —
                  ripReady requires qty === 1. Saying so is the least we owe
                  someone whose most prominent secondary control opts them out of
                  the thing they came for. */}
              {!busy && qty > 1 && (
                <p className="mb-2 text-center text-[11px] text-muted-foreground">
                  Bulk opens skip the rip — all {qty} land in one results grid.
                </p>
              )}
              {busyStatus("mb-2 text-center text-xs text-brand")}
              <button
                // + !evmWallet: this bar has no separate "Loading wallet…" branch
                disabled={ctaDisabled || !evmWallet}
                onClick={() => pull()}
                // The Slabz GLB + face art. Warming inside pull() meant the
                // theater opened on a spinner over black in the three seconds
                // right after the money left — the worst possible moment to
                // doubt whether the tap registered.
                onPointerDown={() => void prebuildPack(artKey)}
                className="btn-brand w-full py-3.5 font-heading text-lg disabled:opacity-40 disabled:pointer-events-none"
              >
                {ctaLabel}
              </button>
              {balanceNote("mt-1.5 text-center text-[11px] text-muted-foreground")}
              {busy && slow && (
                <div className="mt-2 flex flex-col items-center gap-1">
                  <p className="text-center text-[11px] text-muted-foreground">
                    Your pack is paid for — this finishes on its own.
                  </p>
                  <GetHelp />
                </div>
              )}
              {!busy && cellar && wineSecondary}
              {!busy && !cellar && CARD_RAIL && showPaid && pack.isActive && (
                <button
                  disabled={stale || !evmWallet}
                  onClick={() => payWithCard(CARD_RAIL)}
                  className="mt-2 w-full rounded-xl border border-white/15 bg-black/80 py-2.5 text-sm transition-colors hover:text-brand disabled:opacity-40 disabled:pointer-events-none"
                >
                  Pay with card
                </button>
              )}
            </>
          )}
          </div>
        </div>
        </div>
      </div>

      {/* What's inside — near-full-screen dialog over the stage, same overlay
          family as the theaters: the card list and odds want the whole screen,
          not a 400px column. */}
      {panel === "inside" && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="What's inside"
          className="fixed inset-0 z-50 overflow-y-auto bg-background/95 backdrop-blur-sm"
        >
          <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-4 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xs uppercase tracking-wider text-muted-foreground">
                What&apos;s inside
              </h2>
              <button
                autoFocus
                onClick={() => setPanel(null)}
                aria-label="Close"
                className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                ✕
              </button>
            </div>
            {cellar ? (
              // The shelf — what's actually in the pool right now, best first,
              // in the same tiles the card list uses. Graded off each wine's
              // live buyback quote; no odds bars, because every bottle is
              // equally likely and the one line below says so exactly.
              <div>
                {wine.shelfErr ? (
                  <p className="text-sm text-no">Couldn&apos;t read the cellar: {wine.shelfErr}</p>
                ) : !wine.shelf ? (
                  <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                    {Array.from({ length: 10 }).map((_, i) => (
                      <div key={i} className="aspect-[3/5] animate-pulse rounded-lg border border-border bg-surface" />
                    ))}
                  </div>
                ) : wine.shelf.prizes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    The shelf is being restocked — check back soon.
                  </p>
                ) : (
                  <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                    {wine.shelf.prizes
                      .map((p) =>
                        toCard(
                          { collection: p.collection, tokenId: p.tokenId.toString() },
                          wine.shelfOffers[skuIdOf(p.tokenId)],
                          wine.pullUnits6,
                        ),
                      )
                      .sort((a, b) => b.insuredValueCents - a.insuredValueCents)
                      .map((c) => <CardThumb key={c.nftMint} card={c} contain />)}
                  </div>
                )}
                {wine.shelf && wine.shelf.prizeCount > 0 && (
                  <p className="mt-3 text-[11px] text-muted-foreground tabular-nums">
                    {wine.shelf.prizeCount} bottles on the shelf
                    {wine.shelf.prizes.length < wine.shelf.prizeCount
                      ? ` (${wine.shelf.prizes.length} shown)`
                      : ""}{" "}
                    · every bottle is equally likely — 1 in {wine.shelf.prizeCount} per pull · shelf
                    version {wine.shelf.stockEpoch}
                  </p>
                )}
                <p className="mt-3 text-[11px] text-muted-foreground">
                  One signature, no gas. Payment and bottles move in the same transaction — the
                  house can&apos;t take your money without delivering. Your seed, a drand beacon and
                  the house&apos;s pre-committed seed are mixed on-chain, and every draw is
                  replayable from the log. Bottles land in your collection; sell back any
                  time at the house&apos;s quote.
                </p>
              </div>
            ) : (
            <>
            <div>
              {cards === null ? (
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                  {Array.from({ length: 10 }).map((_, i) => (
                    <div key={i} className="aspect-[3/5] animate-pulse rounded-lg border border-border bg-surface" />
                  ))}
                </div>
              ) : cards.length === 0 ? (
                <p className="text-sm text-muted-foreground">Card list unavailable.</p>
              ) : (
                <>
                  <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                    {(showAll ? gridCards : gridPreview).map((c, i, arr) => (
                      <Fragment key={c.nftId}>
                        {/* show-all reads as a ledger: tier headers carry the
                            posted odds, tying what's-inside to the odds bars */}
                        {showAll && (i === 0 || arr[i - 1].rarity !== c.rarity) && (
                          <p className="col-span-full mt-2 first:mt-0 text-[11px] uppercase tracking-wider text-muted-foreground">
                            <span className={`font-medium capitalize ${rarityText(c.rarity)}`}>
                              {c.rarity}
                            </span>
                            {oddsPct[c.rarity.toLowerCase()] != null && (
                              <> · {oddsPct[c.rarity.toLowerCase()]}% per pull</>
                            )}
                          </p>
                        )}
                        <CardThumb card={c} />
                      </Fragment>
                    ))}
                  </div>
                  {gridCards.length > gridPreview.length && (
                    <button
                      onClick={() => setShowAll((s) => !s)}
                      className="mt-3 w-full rounded-lg border border-border bg-surface-2/60 py-2 text-xs text-muted-foreground hover:text-foreground transition"
                    >
                      {showAll ? "Show fewer" : `Show all ${gridCards.length} cards`}
                    </button>
                  )}
                </>
              )}
            </div>

            <div>
              {/* no odds data ⇒ no bare "Odds" heading over nothing */}
              {(stale || pack.odds.length > 0) && (
                <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-3">Odds</h2>
              )}
              {stale ? (
                // previous tier's odds are wrong for this pack — skeleton rows
                <div className="flex flex-col gap-2.5">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-6 animate-pulse rounded-lg bg-surface-2" />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {pack.odds.map((o) => (
                    <div key={o.tier} className="flex items-center gap-2 text-sm">
                      <div className="w-24 shrink-0 leading-tight">
                        <span className={`capitalize ${rarityText(o.tier)}`}>{o.tier}</span>
                        <p className="text-[10px] text-muted-foreground tabular-nums">
                          {usdWhole(o.minValueCents)}
                          {o.maxValueCents != null ? `–${usdWhole(o.maxValueCents)}` : "+"}
                        </p>
                      </div>
                      <div className="h-1.5 flex-1 rounded-full bg-surface-2 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-brand"
                          style={{ width: `${Math.max(1, o.probability)}%` }}
                        />
                      </div>
                      <span className="w-12 shrink-0 text-right font-mono text-xs text-muted-foreground">
                        {o.probability}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-3 text-[11px] text-muted-foreground">
                Pulls are paid from your balance and cards land straight in your
                wallet. Sell back anytime within {SELLBACK_WINDOW_H}h of opening — you get the
                full offer.
              </p>
            </div>
            </>
            )}
          </div>
        </div>
      )}

      {/* Rip theater — cac's `tear` beat. Mounts only for the phases that have
          a card coming (see ripReady), never over a money flow that can still
          be rejected: a full-screen pack you cannot touch reads as a hung app.
          Everything earlier narrates in the CTA, where the rest of the page
          stays live. The GLB is warmed at pull() start, so this mounts on a
          built pack, rippable on the first frame. The card never leaks in: the
          tier is withheld until poppedOpen. Unmounting once popped is safe —
          onOpened fires on popDone(), after the fly-off has played. */}
      {ripReady && !poppedOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Open your pack"
          className="theater fixed inset-0 z-50 bg-background"
        >
          <PackRip
            // bulk opens into one grid, not N rips — its pack stays sealed
            active={!(phase.step === "opening" && bulkRun.current)}
            ccPackType={artKey}
            onOpened={() => setPoppedOpen(true)}
            // Same inset as the idle stage, deliberately: the theater has no buy
            // cluster of its own, but a different framing here would jump the
            // pack the moment the tear opens.
            bottomInset={chromeBottom}
          />
          {/* Held back until the wait is genuinely long: offering an escape
              hatch at second zero says the flow is expected to break. Corner
              pill with its own backdrop — the pack art owns the center/bottom
              and garbles any text laid straight over it. */}
          {slow && (
            <GetHelp className="absolute right-4 top-[calc(1rem+env(safe-area-inset-top))] rounded-full bg-black/60 px-3 py-1.5 ring-1 ring-white/10 backdrop-blur-sm" />
          )}
        </div>
      )}

      {/* Shuffle beat — torn open, card still in flight. The tear routinely
          lands first now that the peel is armed during a free claim, and a
          blank stage for 30s is exactly what this whole rewire is for: three
          backs riffle in the card's own slot until `revealed` hands off to the
          grading sheet. A failed claim drops to `error`, which unmounts this
          and shows the message on the page. */}
      {poppedOpen && busy && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Dealing your card"
          className="theater fixed inset-0 z-50 flex flex-col items-center justify-center gap-8 overflow-hidden bg-background"
        >
          {/* vw-capped: the riffle throws a card 44% of its own width to the
              right, which clears a phone's edge at the desktop w-56 */}
          <div className="relative aspect-[3/5] w-[min(14rem,42vw)]">
            {[0, 1, 2].map((i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src="/gacha/back.svg"
                alt=""
                aria-hidden
                draggable={false}
                className="pack-shuffle-card absolute inset-0 h-full w-full rounded-xl shadow-2xl"
                // margins (not transform) hold the deck offset — the riffle owns
                // transform. Shrinking each card a few px doubles as depth.
                // --sx/--rot vary the throw per card so the three don't read as
                // one arc on a delay; the 44% cap is what clears a phone's edge
                // at the desktop w-56 (see the wrapper's vw clamp).
                style={
                  {
                    animationDelay: `${i * 0.5}s`,
                    marginTop: i * 4,
                    marginLeft: i * 3,
                    "--sx": `${36 + i * 4}%`,
                    "--rot": `${8 + i * 2}deg`,
                  } as React.CSSProperties
                }
              />
            ))}
          </div>
          {/* The riffle is a loop with no arc — second 8 and second 68 are
              pixel-identical, which is exactly what a spinner looks like. The
              ticking count is the liveness proof, and it's honest in a way a
              determinate bar over a Relay fill could never be. */}
          <p role="status" className="max-w-xs text-center text-sm text-muted-foreground">
            {needsSignature
              ? "Approve in your wallet"
              : slow
                ? `Still dealing — ${elapsed}s. Your pack is paid for; this finishes on its own.`
                : "Dealing from the pack…"}
          </p>
          {slow && (
            <GetHelp className="absolute right-4 top-[calc(1rem+env(safe-area-inset-top))] rounded-full bg-black/60 px-3 py-1.5 ring-1 ring-white/10 backdrop-blur-sm" />
          )}
        </div>
      )}

      {/* Grading sheet — beat between the rip and the card. */}
      {phase.step === "revealed" && poppedOpen && !statsDone && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Grading your slab"
          className="theater fixed inset-0 z-50 bg-background"
        >
          <GradingReveal
            name={phase.card.name}
            category={cellar ? "Wine" : packCategory(pack.ccPackType)}
            rarity={phase.card.rarity}
            tier={rarityTier(phase.card.rarity)}
            glow={glowColor(rarityTier(phase.card.rarity))}
            onDone={() => setStatsDone(true)}
          />
        </div>
      )}

      {/* A paid pull used to END by having the whole screen disappear, leaving a
          12px line in the buy column — mid-scroll on mobile, possibly not even
          co-visible with the CTA. It also pointed at "Your pulls", a surface
          that was deleted. This is the same information as a destination. */}
      {phase.step === "still_opening" && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Still opening"
          className="theater fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background p-6 text-center"
        >
          <h2 className="font-heading text-xl">Your pack is still opening</h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            Nothing is lost — Slabz finishes this on its own, and your card lands in
            your collection when it does.
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/gacha/collection"
              className="rounded-full border border-border bg-surface px-5 py-2.5 text-sm font-medium transition hover:bg-surface-2"
            >
              Check your collection
            </Link>
            <button
              autoFocus
              onClick={() => {
                setPhase({ step: "idle" })
                setPoppedOpen(false)
                setStatsDone(false)
              }}
              className="btn-brand px-6 py-2.5 text-sm font-semibold"
            >
              Done
            </button>
          </div>
          <GetHelp className="mt-2" />
        </div>
      )}

      {phase.step === "revealed_bulk" && (
        <BulkReveal
          cards={phase.cards}
          missing={phase.missing}
          pending={phase.pending}
          note={bridgeNote}
          noun={cellar ? "bottle" : "card"}
          onClose={() => setPhase({ step: "idle" })}
        />
      )}

      {/* Card checkout — Coinflow delivers USDC to the pack wallet, then the
          re-run pull enters doPull at the skip-bridge check (funded wallet ⇒
          straight to the Slabz purchase, HL untouched). A downward Slabz
          reprice inside this window can still trigger the HL funding leg on
          resume — worst case the difference strands in the pack wallet,
          recovered by the auto-sweeper, never lost. */}
      {cardFor && pack && cardRail === "coinflow" && (
        <CardCheckout
          open
          onOpenChange={(o) => {
            if (!o) setCardFor(null)
          }}
          packId={pack.id}
          count={qty}
          solWallet={cardFor}
          sign={makeSign(cardFor)}
          signMessage={async (message) =>
            (await signMessage({ message, wallet: cardFor })).signature
          }
          onFunded={() => {
            setCardFor(null)
            pull()
          }}
        />
      )}
      {cardFor && pack && cardRail === "crossmint" && (
        <CrossmintCheckout
          open
          onOpenChange={(o) => {
            if (!o) setCardFor(null)
          }}
          packId={pack.id}
          count={qty}
          solWallet={cardFor}
          onFunded={() => {
            setCardFor(null)
            pull()
          }}
        />
      )}

      {phase.step === "revealed" && poppedOpen && statsDone && (
        <Reveal
          card={phase.card}
          image={phase.card.imageUrl ?? artByName.get(phase.card.name)}
          soldCents={phase.soldCents}
          note={bridgeNote}
          demo={phase.sellTarget.kind === "demo"}
          noun={cellar ? "bottle" : "card"}
          initialQuote={revealQuote}
          onClose={() => {
            setPhase({ step: "idle" })
            setPoppedOpen(false) // re-arm for the next pull (incl. the dev button)
            setStatsDone(false)
          }}
          {...sellHandlers(phase.sellTarget)}
        />
      )}
    </>
  )
}
