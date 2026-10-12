"use client"

import Link from "next/link"
import { Suspense, useCallback, useEffect, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { usePrivy, useWallets } from "@privy-io/react-auth"
import {
  useSignMessage,
  useSignTransaction,
  useWallets as useSolanaWallets,
} from "@privy-io/react-auth/solana"
import {
  buybackQuote,
  listTransactions,
  redeemStatus,
  usd,
  SlabzError,
  type OpenedCard,
  type RedeemStatus,
  type ShipAddress,
  type ShipEstimate,
} from "@/lib/slabz"
import {
  pickPrivySolWallet,
  quoteRedeem,
  ensureRedeemSession,
  sellToSlabz,
  shipRedeem,
  takeMoneyLock,
  SellSettlingError,
  SoldBridgePendingError,
  SOLANA_CHAIN,
  type SignSolanaMessage,
  type SignSolanaTx,
} from "@/lib/gacha-bridge"
import { GachaApiError } from "@/lib/gacha-quotes"
import { explainSignError } from "@/lib/sign-error"
import { heldCards, pastCards, rarityText, sellbackHoursLeft, shipmentCents, SELLBACK_WINDOW_H } from "@/lib/gacha-core"
import { coreAssetsOwned } from "@/lib/solana-client"
import {
  bottlesOwned,
  readOffer,
  signSellAuthorization,
  wineConfigured,
  winePublicClient,
  type BottleOffer,
  type OwnedBottle,
} from "@/lib/wine"
import { bottleImg, bottleName, MOCK_COLLECTION, WINE_BUYBACK_RATIO } from "@/lib/wine-shelf"
import { privyAuthHeaders } from "@/lib/privy-tokens"
import { Button, buttonVariants } from "@/components/ui/button"
import { HoldToSell } from "@/components/gacha/HoldToSell"
import { GetHelp } from "@/components/GetHelp"
import { Input } from "@/components/ui/input"

type Held = OpenedCard & { transactionId: string; createdAt?: string }

/** Advisory deadline line for a card, or null when the pull time is unknown.
 *  buybackQuote stays the oracle — this never gates the Sell button.
 *
 *  Hours, not a ticking clock. The split-flap countdown this replaced ran a
 *  1s interval and a 3D keyframe per card, forever, right next to a button one
 *  tap from an irreversible sale — ~86k plays a day carrying no information
 *  anybody acts on. Nobody sells in the last three seconds of 72 hours. Under
 *  an hour it switches to minutes, where the number finally matters. */
function sellbackLine(c: Held): { text: string; urgent: boolean } | null {
  const h = sellbackHoursLeft(c.createdAt)
  if (h == null) return null
  if (h === 0) return { text: "Sell-back window closed", urgent: false }
  if (h > 1) return { text: `Sell-back ends in ${h}h`, urgent: h <= 12 }
  const left = Date.parse(c.createdAt!) + SELLBACK_WINDOW_H * 3600e3 - Date.now()
  return { text: `Sell-back ends in ${Math.max(1, Math.ceil(left / 60_000))}m`, urgent: true }
}

const dollars = (n: number) => usd(Math.round(n * 100))

// Hold-to-sell rationale and mechanics live in components/gacha/HoldToSell —
// the reveal theater sells with the same interaction now, one component both.

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const AUTH_ERR = "__auth__" // sentinel: render the re-login card, not raw text

// ponytail: dev-only design-review mode — ?mock=1 renders fake cards without
// signing in. Dead code in prod builds (NODE_ENV check), delete when the
// design settles.
const MOCK =
  process.env.NODE_ENV === "development" &&
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("mock")

// ponytail: `?mock=1&shipment=<redeemStatus>` opens ShipView straight onto an
// existing shipment instead of the address form — `pending_burn` is the
// "Finish the burn" branch, the rest just show their label. Same NODE_ENV fold
// as MOCK, so none of it exists in a prod build.
const mockShipment = (): RedeemStatus | null => {
  const q = MOCK ? new URLSearchParams(window.location.search) : null
  const v = q?.get("shipment")
  return v
    ? {
        shipmentId: "mock-shipment-1",
        status: "Awaiting burn",
        redeemStatus: v as RedeemStatus["redeemStatus"],
        deliveryCompany: "FedEx",
        trackingIds: [],
        trackingUrls: [],
        // `&cost=abc` exercises the fail-closed path: an unreadable price
        // must drop the button, not hand shipRedeem a NaN ceiling
        totalCost: q?.get("cost") ?? "8.99",
      }
    : null
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600e3).toISOString()
const MOCK_CARDS: Held[] = [
  {
    nftMint: "MockLegendary11111111111111111111111111111",
    name: "Charizard VMAX PSA 10 (mock)",
    rarity: "legendary",
    insuredValueCents: 42000,
    imageUrl: "/gacha/back.svg",
    autoSold: false,
    autoSoldCents: null,
    transactionId: "mock-tx-1",
    createdAt: hoursAgo(66), // urgent countdown
  },
  {
    nftMint: "MockRare111111111111111111111111111111111",
    name: "Pikachu Illustrator BGS 9.5 (mock)",
    rarity: "rare",
    insuredValueCents: 8900,
    imageUrl: "/gacha/back.svg",
    autoSold: false,
    autoSoldCents: null,
    transactionId: "mock-tx-2",
    createdAt: hoursAgo(4),
  },
  {
    nftMint: "MockCommon1111111111111111111111111111111",
    name: "Squirtle CGC 8 no-image state (mock)",
    rarity: "common",
    insuredValueCents: 350,
    imageUrl: null,
    autoSold: false,
    autoSoldCents: null,
    transactionId: "", // pre-v3: no buttons
    createdAt: hoursAgo(100), // window ended
  },
]

const REDEEM_LABEL: Record<RedeemStatus["redeemStatus"], string> = {
  pending_burn: "Waiting on the burn",
  processing: "Being packed",
  shipped: "Shipped",
  delivered: "Delivered",
  failed: "Failed",
  cancelled: "Cancelled",
}

export default function CollectionPage() {
  return (
    // useSearchParams (the ?ship= form state) needs a Suspense boundary to
    // keep the route statically prerenderable
    <Suspense>
      <CollectionInner />
    </Suspense>
  )
}

function CollectionInner() {
  const { authenticated, ready, login, logout } = usePrivy()
  const { wallets: solWallets } = useSolanaWallets()
  const { wallets: evmWallets } = useWallets()
  const { signTransaction } = useSignTransaction()
  const solWallet = pickPrivySolWallet(solWallets)
  const address = solWallet?.address
  // privy-first like every other money surface — a connected external wallet
  // must not shadow the embedded HL account
  const evmWallet = evmWallets.find((w) => w.walletClientType === "privy") ?? evmWallets[0]
  const [cards, setCards] = useState<Held[] | undefined>()
  // cards that left the wallet (sold back, auto-sold, shipped). They render
  // dimmed under the grid so a user who sold everything sees their history
  // instead of an empty page that reads like lost money — this page is the
  // ONLY pull ledger now that the shop's side column is gone.
  const [past, setPast] = useState<Held[]>([])
  // pulls that charged but haven't produced a card yet. The shop's old "Your
  // pulls" column was the only place these showed; deleting it would have made
  // the scariest state (money moved, no card) invisible. The journal resumes
  // the pull and RecoverBalance sweeps anything stranded — this is purely so
  // the user can see that it's in hand.
  const [opening, setOpening] = useState(0)
  // The Cellar. undefined = still reading (or nothing to read) — the section
  // only renders once there are bottles, so a failed read just hides it.
  // Bottles fail soft for the same reason the entitlement reads do on the shop:
  // a HyperEVM RPC blip must never cost the user their card grid.
  const [bottles, setBottles] = useState<OwnedBottle[] | undefined>()
  // buyback quote + window per bottle, keyed collection:tokenId. Read straight
  // off the contract — the quote is write-once, so it can't move under a tap.
  const [bottleOffers, setBottleOffers] = useState<Record<string, BottleOffer>>({})
  const [sellingBottle, setSellingBottle] = useState<string | null>(null)
  // undefined = not quoted yet, null = quoted and not sellable, number = offer.
  // The grid button needs all three: a disabled button that can't say WHY reads
  // as broken, and one that can't tell "pricing" from "closed" lies either way.
  const [offers, setOffers] = useState<Record<string, number | null>>({})
  const [err, setErr] = useState<string | null>(null)
  const [shipping, setShipping] = useState<Held | null>(null)
  // The ship form is URL state (?ship=<txId>) so the ROUTER owns the history
  // entry: browser Back closes the form instead of ejecting the user from the
  // collection, and reload/forward behave without us juggling raw
  // pushState/popstate against Next's internals (which broke once already).
  // `shipping` still holds the card OBJECT — deriving it from the list every
  // render would unmount the post-burn confirmation the moment load() drops
  // the burned card.
  const router = useRouter()
  const shipParam = useSearchParams().get("ship")
  const pushedShip = useRef(false)
  const openShip = (c: Held) => {
    setShipping(c)
    pushedShip.current = true
    router.push(`/gacha/collection?ship=${c.transactionId}`)
  }
  useEffect(() => {
    if (!shipParam) {
      setShipping(null) // Back/forward/close removed the param
      return
    }
    // deep link or reload with ?ship= — adopt the card once the list is in
    setShipping((s) =>
      s?.transactionId === shipParam
        ? s
        : (cards?.find((c) => c.transactionId === shipParam) ?? s),
    )
  }, [shipParam, cards])
  // txId of the sale in flight (one at a time — the money lock enforces it
  // anyway) plus per-card outcome lines, since there is no sell page to land on
  const [busyTx, setBusyTx] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string | null>>({})
  // Outcome of the last sale, page-level on purpose: the card it belongs to
  // leaves the grid the moment the sale is terminal, and a per-card line would
  // take the only confirmation of an irreversible sale with it.
  const [flash, setFlash] = useState<string | null>(null)
  // Which cards the quote sweep has already priced. A ref, not state: the sweep
  // effect keys off `cards`, and selling a slab edits that list locally — without
  // this, every sale re-quoted the whole grid against the 60 req/min Slabz key.
  const quoted = useRef<Set<string>>(new Set())
  // What each slab actually sold for, by mint. Slabz only reports a payout on
  // auto-sells, so without this the amount a user consented to on an
  // irreversible sale is never confirmed back to them anywhere. Session-scoped
  // — the durable fix is a field on the Slabz transaction.
  const [soldFor, setSoldFor] = useState<Record<string, number>>({})

  const load = useCallback((quiet = false) => {
    if (!address) return
    quoted.current.clear() // a real refresh re-prices: offers move
    if (!quiet) setCards(undefined) // a background poll must not flash skeletons
    setErr(null)
    // Slabz history supplies art + names; the chain read confirms the Core
    // asset is still actually in the wallet (sold/transferred cards drop out).
    listTransactions(address, 100)
      .then(async (txs) => {
        const mints = txs
          .map((t) => (t.card && "nftMint" in t.card ? t.card.nftMint : null))
          .filter((m): m is string => !!m)
        // one wallet read feeds both halves: held (the trophy case, best
        // first) and gone (history, newest first)
        setOpening(
          txs.filter((t) => t.status === "created" || t.status === "confirmed" || t.status === "opening")
            .length,
        )
        const owned = await coreAssetsOwned(address, mints)
        setCards(
          heldCards(txs, owned).sort((a, b) => b.insuredValueCents - a.insuredValueCents),
        )
        setPast(
          pastCards(txs, owned).sort(
            (a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""),
          ),
        )
      })
      .catch((e) =>
        // 401 after the built-in silent retry ⇒ the session really is stale.
        // A raw "missing identity token" reads like a bug; ask for a re-login.
        setErr(e instanceof SlabzError && e.status === 401 ? AUTH_ERR : errText(e)),
      )
  }, [address])

  useEffect(() => {
    if (MOCK) {
      setCards(MOCK_CARDS)
      setOffers({ "mock-tx-1": 33600, "mock-tx-2": 7100 })
      setBottles([
        { collection: MOCK_COLLECTION, tokenId: BigInt(0), deferred: false },
        { collection: MOCK_COLLECTION, tokenId: BigInt(4), deferred: true },
      ])
      return
    }
    // wait for the restored session, not just the wallet list — the wallet
    // shows up before getAccessToken() has a token, and the tx read is gated
    if (!ready || !authenticated || !address) return
    load()
  }, [ready, authenticated, address, load])

  // The Cellar reads its own chain off its own wallet — independent of the
  // Slabz load so neither side can take the other down.
  const loadBottles = useCallback(() => {
    if (MOCK || !wineConfigured() || !evmWallet?.address) return
    const user = evmWallet.address as `0x${string}`
    bottlesOwned(user)
      .then(async (bs) => {
        setBottles(bs)
        // one read per bottle — a cellar is a handful, not a binder
        const offers = await Promise.all(
          bs.map((b) => readOffer(b.collection, b.tokenId).catch(() => null)),
        )
        const next: Record<string, BottleOffer> = {}
        bs.forEach((b, i) => {
          if (offers[i]) next[`${b.collection}:${b.tokenId}`] = offers[i]!
        })
        setBottleOffers(next)
      })
      .catch(() => setBottles([]))
  }, [evmWallet?.address])
  useEffect(loadBottles, [loadBottles])

  async function sellBottleBack(b: OwnedBottle, offer: BottleOffer) {
    if (!evmWallet) return
    const key = `${b.collection}:${b.tokenId}`
    setSellingBottle(key)
    setErr(null)
    try {
      // Sign, don't send. The holder authorises the sale and the house relays it, so this
      // costs them no gas — which is the difference between a guest who was gifted their
      // stake being able to cash out and not.
      const { deadline, signature } = await signSellAuthorization(evmWallet, b.collection, b.tokenId)
      const res = await fetch("/api/wine/sell", {
        method: "POST",
        headers: { ...(await privyAuthHeaders()), "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: evmWallet.address,
          collection: b.collection,
          tokenId: b.tokenId.toString(), // bigint: JSON.stringify would throw
          deadline,
          signature,
        }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
      if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`)
      setFlash(`Sold back for ${usd(Number(offer.priceUnits6) / 10_000)} — added to your balance.`)
      loadBottles()
    } catch (e) {
      setErr(explainSignError(e).message)
    } finally {
      setSellingBottle(null)
    }
  }

  // "These finish on their own" sat next to a Refresh button, so one of the two
  // was lying. Poll quietly and the sentence becomes true.
  useEffect(() => {
    if (MOCK || !opening) return
    const id = setInterval(() => load(true), 15_000)
    return () => clearInterval(id)
  }, [opening, load])

  // Grid button prices, and now the confirm-gate too: the button IS the
  // confirmation, so a card with no price can't be sold. Sequential on purpose —
  // the Slabz key is capped at 60 req/min and a parallel burst would eat the
  // whole budget. A stale price still can't sell at the wrong number:
  // sellToSlabz refuses anything below the number the user tapped.
  //
  // Two passes, because a thrown quote is not the same answer as "no offer".
  // Marking a network blip as unsellable would strand a live slab behind a dead
  // button until the user thought to reload; pass 2 costs one request per
  // failure, since `quoted` skips everything already priced.
  useEffect(() => {
    if (MOCK || !cards?.length) return
    let stop = false
    ;(async () => {
      for (let pass = 0; pass < 2 && !stop; pass++)
        for (const c of cards) {
          if (stop) break
          if (!c.transactionId || quoted.current.has(c.transactionId)) continue
          try {
            const q = await buybackQuote(c.transactionId)
            if (stop) break
            quoted.current.add(c.transactionId)
            setOffers((o) => ({ ...o, [c.transactionId]: q.available ? q.offerCents : null }))
          } catch {
            if (stop) break
            // leave it unquoted so pass 2 retries; only the last pass gives up
            if (pass === 1) setOffers((o) => ({ ...o, [c.transactionId]: null }))
          }
        }
    })()
    return () => {
      stop = true
    }
  }, [cards])

  const note = (c: Held, text: string | null) =>
    setNotes((n) => ({ ...n, [c.transactionId]: text }))

  /** Sale is terminal: the slab is gone from the wallet. Move it to the history
   *  list locally rather than re-running `load()` — that blanked the whole grid
   *  to skeletons and re-quoted every remaining card against the 60 req/min
   *  Slabz budget, on every single sale. */
  const settled = (c: Held, cents: number | null, text: string) => {
    setFlash(text)
    if (cents != null) setSoldFor((m) => ({ ...m, [c.nftMint]: cents }))
    note(c, null)
    setCards((cs) => cs?.filter((x) => x.nftMint !== c.nftMint))
    // called twice for one sale (once at onSold, again when the bridge lands) —
    // the second call must not duplicate the history row
    setPast((p) => (p.some((x) => x.nftMint === c.nftMint) ? p : [c, ...p]))
  }

  /**
   * Sell straight from the grid. The priced button IS the confirmation — a
   * whole page to re-read the same number was a step, not a safeguard. The
   * real guard is unchanged: `minOfferCents` is the price the user tapped, and
   * sellToSlabz aborts BEFORE any signature if Slabz has since minted a lower
   * offer. Selling is irreversible, so nothing here is retried automatically.
   */
  async function sellNow(c: Held) {
    const offer = offers[c.transactionId]
    if (offer == null || busyTx || !solWallet || !evmWallet) return
    const release = takeMoneyLock()
    if (!release) return note(c, "Another payment is in progress — finish that one first.")
    setBusyTx(c.transactionId)
    note(c, null)
    setFlash(null)
    try {
      const cents = await sellToSlabz({
        txId: c.transactionId,
        solAddress: solWallet.address,
        evmWallet,
        sign: async (tx) =>
          (await signTransaction({ transaction: tx, wallet: solWallet, chain: SOLANA_CHAIN }))
            .signedTransaction,
        minOfferCents: offer,
        // Commit the moment the sale is terminal (NFT burned, USDC in the pack
        // wallet), not when the bridge finishes. The slab is already gone, so
        // leaving it in the grid behind a "Selling…" button for the length of
        // the payout hop just made a done deal look stuck.
        onSold: (paid) =>
          settled(c, paid, `Sold for ${usd(paid)} — payout on its way to your balance.`),
      })
      settled(c, cents, `Sold for ${usd(cents)} — the payout is in your balance.`)
    } catch (e) {
      if (e instanceof SellSettlingError) {
        // good news on a slow path: the sale is in flight, so the card is gone.
        // No price: we never saw `completed`, so naming one would be a guess.
        settled(c, null, e.message)
      } else if (e instanceof SoldBridgePendingError) {
        // sold — only the payout hop stalled. Never an error, or the card keeps
        // a live Sell button on an already-sold slab.
        settled(c, e.soldCents, `Sold for ${usd(e.soldCents)} — ${e.message}`)
      } else {
        note(
          c,
          e instanceof GachaApiError && e.code === "QUOTE_CHANGED"
            ? "The offer changed — check the new price."
            : explainSignError(e).message,
        )
        // re-quote this one card: it answers unavailable once a buyback is in
        // flight, which disables the button instead of re-erroring
        buybackQuote(c.transactionId)
          .then((q) =>
            setOffers((o) => {
              const next = { ...o }
              next[c.transactionId] = q.available ? q.offerCents : null
              return next
            }),
          )
          .catch(() => {})
      }
    } finally {
      release()
      setBusyTx(null)
    }
  }

  if (shipping && (solWallet || MOCK))
    return (
      <ShipView
        card={shipping}
        onClose={(shipped) => {
          // pop the entry openShip pushed; a deep link never pushed one, so
          // back() there would leave the app — replace to the bare URL instead
          if (pushedShip.current) {
            pushedShip.current = false
            router.back()
          } else {
            router.replace("/gacha/collection")
          }
          setShipping(null)
          if (shipped) load() // the slab is burned — it's gone from the wallet
        }}
      />
    )

  const skeleton = (
    <div className="grid gap-3 sm:gap-4 [grid-template-columns:repeat(auto-fill,minmax(10rem,15rem))]">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="aspect-[676/1136] animate-pulse rounded-2xl border border-border bg-surface" />
      ))}
    </div>
  )

  return (
    <div className="w-full">
      <div className="mb-1 flex items-baseline gap-2">
        <h1 className="font-heading text-2xl">Your collection</h1>
        {!!cards?.length && (
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            {cards.length} slab{cards.length === 1 ? "" : "s"} ·{" "}
            {usd(cards.reduce((a, c) => a + c.insuredValueCents, 0))} insured
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-5">
        Everything from your pulls, held in your own wallets. Sell a slab back
        within {SELLBACK_WINDOW_H}h of the pull and you get the full offer, paid to
        your trading balance.
      </p>

      {opening > 0 && (
        <div className="mb-5 rounded-xl border border-brand/40 bg-brand/10 px-4 py-3">
          <p className="text-sm font-medium">
            {opening} pull{opening > 1 ? "s" : ""} still opening
          </p>
          <p className="text-[11px] text-muted-foreground">
            These finish on their own — your card lands here when it&apos;s done.
          </p>
        </div>
      )}

      {flash && (
        <div className="mb-5 rounded-xl border border-brand/40 bg-brand/10 px-4 py-3 text-sm">
          {flash}
        </div>
      )}

      {/* skeleton (not blank) while Privy restores the session — the page
          flashed empty before the auth state settled */}
      {!ready && !MOCK ? (
        skeleton
      ) : !MOCK && (!authenticated || !solWallet) ? (
        <div className="rounded-2xl border border-border bg-surface p-8 text-center text-sm text-muted-foreground">
          <p>Sign in to see your collection.</p>
          <Button className="btn-brand mt-3 h-9 px-4 font-semibold" onClick={login}>
            Sign in
          </Button>
        </div>
      ) : err === AUTH_ERR ? (
        <div className="rounded-2xl border border-border bg-surface p-8 text-center text-sm text-muted-foreground">
          <p>Your session expired — sign in again to see your collection.</p>
          {/* login() no-ops while authenticated; drop the stale session first */}
          <Button
            className="btn-brand mt-3 h-9 px-4 font-semibold"
            onClick={() => logout().then(() => login())}
          >
            Sign in again
          </Button>
        </div>
      ) : err ? (
        <div className="rounded-2xl border border-no/40 bg-no/10 p-8 text-center text-sm">
          Couldn&apos;t load your collection: {err}{" "}
          <button onClick={() => load()} className="text-brand hover:underline">
            Try again
          </button>
        </div>
      ) : cards === undefined ? (
        skeleton
      ) : cards.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface p-8 text-center text-sm text-muted-foreground">
          {past.length > 0
            ? "Nothing in your wallet right now — everything you pulled has been sold or shipped."
            : "No cards in your wallet yet."}{" "}
          <Link href="/gacha" className="text-brand hover:underline">
            Open a pack
          </Link>{" "}
          to start one.
        </div>
      ) : (
        // auto-fill with a 15rem cap so one lone slab doesn't render poster-sized
        <div className="grid gap-3 sm:gap-4 [grid-template-columns:repeat(auto-fill,minmax(10rem,15rem))]">
          {cards.map((c) => (
            <div key={c.nftMint} className="flex flex-col">
              {/* slab scans are 676x1136 portrait — cell matches so they fill it */}
              <div className="grid aspect-[676/1136] place-items-center overflow-hidden">
                {c.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={c.imageUrl}
                    alt={c.name}
                    loading="lazy"
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">No image</span>
                )}
              </div>
              <div className="flex flex-col gap-1 pt-3">
                <p className="truncate text-sm font-medium">{c.name}</p>
                <p className="text-[11px] text-muted-foreground">
                  <span className={`capitalize ${rarityText(c.rarity)}`}>{c.rarity}</span> · value{" "}
                  {usd(c.insuredValueCents)}
                </p>
                <p
                  className="font-mono text-[10px] text-muted-foreground/60"
                  title={c.nftMint}
                >
                  {c.nftMint.slice(0, 4)}…{c.nftMint.slice(-4)}
                </p>
                {/* no transactionId (pre-v3 history) ⇒ no sell/redeem endpoint to call */}
                {c.transactionId && (
                  <div className="mt-2 flex gap-2">
                    <HoldToSell
                      className={buttonVariants({
                        variant: "outline",
                        size: "sm",
                        className: "flex-1",
                      })}
                      disabled={!!busyTx || offers[c.transactionId] == null}
                      onCommit={() => sellNow(c)}
                      label={
                        busyTx === c.transactionId
                          ? "Selling…"
                          : typeof offers[c.transactionId] === "number"
                            ? // the hold IS the confirm — say so on the control
                              `Hold to sell · ${usd(offers[c.transactionId]!)}`
                            : offers[c.transactionId] === null
                              ? "Can't sell back"
                              : "Pricing…"
                      }
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1"
                      onClick={() => openShip(c)}
                    >
                      Ship home
                    </Button>
                  </div>
                )}
                {notes[c.transactionId] && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {notes[c.transactionId]}
                  </p>
                )}
                {/* Advisory only — the sell-back window closing doesn't stop
                    the user shipping the slab, which never expires. */}
                {(() => {
                  const line = sellbackLine(c)
                  if (!line) return null
                  return (
                    <p
                      className={`mt-1 text-[11px] ${line.urgent ? "text-no" : "text-muted-foreground"}`}
                    >
                      {line.text}
                    </p>
                  )
                })()}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Bottles from wine pulls, in the user's HyperEVM wallet. Same tile
          grammar as the Cellar page's shelf; no actions yet (redeem ships
          later), so the section is a trophy shelf, not a control panel.
          Named "Your bottles", NOT "Cellar" — Cellar is the wine shop tab,
          and one word can't mean both a shop and a shelf.
          Hidden entirely when empty — no second empty state to explain. */}
      {!!bottles?.length && (
        <div className="mt-8">
          <h2 className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
            Your bottles
          </h2>
          <p className="mb-3 text-[11px] text-muted-foreground">
            Sell back within two days of the pull — the house pays the quote on-chain. Shipping
            is coming.
          </p>
          <div className="grid gap-3 sm:gap-4 [grid-template-columns:repeat(auto-fill,minmax(8rem,11rem))]">
            {bottles.map((b) => {
              const img = bottleImg(b)
              return (
                <div
                  key={`${b.collection}:${b.tokenId}`}
                  className="flex flex-col items-center rounded-2xl border border-border bg-surface p-3 text-center"
                >
                  {img ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={img} alt="" loading="lazy" className="h-24 w-20 rounded-lg object-contain" />
                  ) : (
                    <div className="grid h-24 place-items-center text-3xl">🍷</div>
                  )}
                  <p className="mt-2 text-sm font-medium leading-tight">{bottleName(b)}</p>
                  {/* no tier badge: mockTier is an id % 12 formula and these
                      are real bottles — fabricated rarity stays off them */}
                  {b.deferred && (
                    <p className="mt-1.5 text-[10px] text-muted-foreground">
                      Transfer pending — claimable on-chain
                    </p>
                  )}
                  {(() => {
                    const key = `${b.collection}:${b.tokenId}`
                    const o = bottleOffers[key]
                    if (b.deferred || !o) return null
                    // sellable is the whole gate: quoted, programme on, cash there.
                    // No countdown — a bottle's sell-back no longer expires.
                    if (!o.sellable)
                      return (
                        <p className="mt-2 text-[10px] text-muted-foreground">Not selling back right now</p>
                      )
                    const price = usd(Number(o.priceUnits6) / 10_000)
                    // No gas gate any more: the holder signs and the house relays, so a
                    // wallet with zero HYPE sells exactly like a funded one.
                    const busy = sellingBottle === key
                    return (
                      <>
                        {/* what the bottle is worth, then what the house offers — the
                            quote is 90% of it, the same two numbers the reveal shows */}
                        <p className="mt-1 font-mono text-xs tabular-nums">
                          {usd(Number(o.priceUnits6) / 10_000 / WINE_BUYBACK_RATIO)}
                        </p>
                        <HoldToSell
                          label={busy ? "Selling…" : `Hold to sell · ${price}`}
                          disabled={busy || !!sellingBottle}
                          onCommit={() => void sellBottleBack(b, o)}
                          className="mt-2 w-full rounded-lg border border-brand/50 bg-brand/10 py-1.5 text-xs font-medium text-brand disabled:opacity-50"
                        />

                      </>
                    )
                  })()}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* History. Dimmed, small, below the fold — a record, not a shelf. This
          is what the shop's "Your pulls" column used to be; keeping it here
          means a card has exactly one home for its whole life. */}
      {past.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-3 text-xs uppercase tracking-wider text-muted-foreground">
            Sold &amp; shipped
          </h2>
          <div className="flex flex-col gap-2">
            {past.map((c) => (
              <div
                key={c.nftMint}
                className="flex items-center gap-3 rounded-xl border border-border bg-surface/50 px-3 py-2"
              >
                {c.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={c.imageUrl}
                    alt=""
                    loading="lazy"
                    className="h-12 w-8 shrink-0 rounded object-contain opacity-60"
                  />
                ) : (
                  <div className="h-12 w-8 shrink-0 rounded bg-surface-2" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-muted-foreground">{c.name}</p>
                  <p className="text-[11px] text-muted-foreground/70">
                    <span className={`capitalize ${rarityText(c.rarity)} opacity-70`}>
                      {c.rarity}
                    </span>{" "}
                    · gone from your wallet
                  </p>
                </div>
                {/* Auto-sells carry their payout on the card object; a manual
                    sell-back doesn't, so `soldFor` remembers what this session
                    sold. A per-card status call for older sales would eat the
                    Slabz 60 req/min budget — ponytail: drop `soldFor` when Slabz
                    puts the payout on the transaction. */}
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {c.autoSold && c.autoSoldCents != null
                    ? `sold ${usd(c.autoSoldCents)}`
                    : soldFor[c.nftMint] != null
                      ? `sold ${usd(soldFor[c.nftMint])}`
                      : "sold"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  )
}

// ---- shipping ---------------------------------------------------------------
// Inline view, not a modal: Privy's headless signing plus a focus-trapped
// dialog is the setup that broke withdrawals (HANDOFF), and this flow signs
// three times. Redeeming burns the NFT and is irreversible, so the cost is
// always quoted and confirmed before anything is charged.

// English country names from the runtime's ICU data — no country data file
// shipped. Slabz wants the NAME ("United States"), not the ISO code: their
// docs' example body is country "United States of America" / state
// "California", and an ISO code 502s the estimate. Blocklist drops
// non-shippable pseudo-regions ICU also names.
const NOT_COUNTRIES = new Set(["EU", "EZ", "UN", "QO", "XA", "XB", "ZZ"])
const COUNTRIES = (() => {
  const dn = new Intl.DisplayNames(["en"], { type: "region" })
  const out: [string, string][] = []
  for (let a = 65; a <= 90; a++)
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b)
      const name = dn.of(code)
      if (name && name !== code && !NOT_COUNTRIES.has(code)) out.push([code, name])
    }
  return out.sort((x, y) => x[1].localeCompare(y[1]))
})()

// ponytail: single last-used address in localStorage; a saved-address book
// can come when anyone actually ships to two places
const ADDR_KEY = "gacha.shipAddress.v1"
const savedAddress = (): Partial<ShipAddress> => {
  try {
    return JSON.parse(localStorage.getItem(ADDR_KEY) ?? "{}")
  } catch {
    return {}
  }
}

type Step =
  | { kind: "loading" }
  | { kind: "form" }
  | { kind: "quoted"; shippingAddressId: string; estimate: ShipEstimate }
  | { kind: "working"; note: string }
  | { kind: "shipped"; shipmentId: string; urls: string[] }
  | { kind: "existing"; status: RedeemStatus }

function ShipView({
  card,
  onClose,
}: {
  card: Held
  onClose: (shipped: boolean) => void
}) {
  const { user } = usePrivy()
  const { wallets: solWallets } = useSolanaWallets()
  const { wallets: evmWallets } = useWallets()
  const { signTransaction } = useSignTransaction()
  const { signMessage } = useSignMessage()
  // seeded from localStorage, updated on every submit so a failed quote (or
  // "Change address") re-renders the form with what was typed, not blanks
  const [saved, setSaved] = useState(savedAddress)
  const solWallet = pickPrivySolWallet(solWallets)
  // privy-first like every other money surface — a connected external wallet
  // must not shadow the embedded HL account
  const evmWallet = evmWallets.find((w) => w.walletClientType === "privy") ?? evmWallets[0]

  const [step, setStep] = useState<Step>({ kind: "loading" })
  const [err, setErr] = useState<string | null>(null)

  // A card can only be redeemed once — surface the live shipment instead of a
  // form that would answer PARTNER_REDEEM_ALREADY_DONE.
  useEffect(() => {
    const mock = mockShipment()
    if (mock) {
      setStep({ kind: "existing", status: mock })
      return
    }
    redeemStatus(card.transactionId)
      .then((s) => setStep(s ? { kind: "existing", status: s } : { kind: "form" }))
      .catch(() => setStep({ kind: "form" })) // status is a nicety, not a gate
  }, [card.transactionId])

  // Pre-warm the Slabz redeem session while the user fills in the address form.
  // It costs an auth POST, a HEADLESS ed25519 signature and a verify POST —
  // ~0.6-1.5s that used to sit on the submit click for no reason. Best-effort:
  // quoteRedeem calls ensureRedeemSession itself and reuses this one if it
  // landed, so a failure here just puts the cost back where it was.
  useEffect(() => {
    if (step.kind !== "form" || !solWallet) return
    void ensureRedeemSession(card.transactionId, solWallet.address, signMsg).catch(() => {})
    // signMsg is recreated every render; the session is keyed by (tx, wallet)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.kind, card.transactionId, solWallet?.address])

  const sign: SignSolanaTx = async (tx) =>
    (await signTransaction({ transaction: tx, wallet: solWallet!, chain: SOLANA_CHAIN }))
      .signedTransaction
  const signMsg: SignSolanaMessage = async (message) =>
    (await signMessage({ message, wallet: solWallet! })).signature

  async function submitAddress(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!solWallet) return
    const f = new FormData(e.currentTarget)
    const s = (k: string) => String(f.get(k) ?? "").trim()
    const address: ShipAddress = {
      name: s("name"),
      line1: s("line1"),
      line2: s("line2") || undefined,
      city: s("city"),
      state: s("state"),
      postalCode: s("postalCode"),
      country: s("country"),
      phoneNumber: s("phoneNumber") || undefined,
      email: s("email"),
    }
    setSaved(address)
    setErr(null)
    setStep({ kind: "working", note: "Getting a shipping quote…" })
    try {
      const q = await quoteRedeem({
        txId: card.transactionId,
        solAddress: solWallet.address,
        address,
        signMessage: signMsg,
      })
      // only remember addresses the quote endpoint accepted
      try {
        localStorage.setItem(ADDR_KEY, JSON.stringify(address))
      } catch {}
      setStep({ kind: "quoted", ...q })
    } catch (e) {
      setErr(errText(e))
      setStep({ kind: "form" })
    }
  }

  /** `totalCents` is the ceiling the burn is checked against, and `back` is
   *  where a failure returns the user: the quote they came from, or the
   *  shipment itself when they're finishing an already-prepared one. */
  async function confirm(shippingAddressId: string, totalCents: number, back: Step) {
    if (!solWallet || !evmWallet) return
    const release = takeMoneyLock()
    if (!release) {
      setErr("Another payment is in progress — finish that one first.")
      return
    }
    setErr(null)
    setStep({ kind: "working", note: "Paying for shipping…" })
    try {
      const res = await shipRedeem({
        txId: card.transactionId,
        solAddress: solWallet.address,
        shippingAddressId,
        estimateTotalCents: totalCents,
        evmWallet,
        sign,
        signMessage: signMsg,
        onPhase: (p) =>
          setStep({
            kind: "working",
            note: {
              funding: "Paying for shipping…",
              preparing: "Preparing the shipment…",
              signing: "Signing the burn…",
              shipping: "Handing it to Slabz…",
            }[p],
          }),
      })
      setStep({ kind: "shipped", shipmentId: res.shipmentId, urls: res.transactionUrls ?? [] })
    } catch (e) {
      setErr(errText(e))
      setStep(back)
    } finally {
      release()
    }
  }

  const busy = step.kind === "working"

  /** A shipment that was prepared but never burned, offered back to the user.
   *  The price has to be READABLE: it becomes the ceiling shipRedeem checks
   *  the resumed burn against, and that check is `prepCents > ceiling`, which
   *  a NaN sails straight through. No price, no button. */
  const finishBurn = (status: RedeemStatus) => {
    const cents = shipmentCents(status.totalCost)
    if (cents == null)
      return (
        <p className="mt-3 text-xs text-muted-foreground">
          We can&apos;t read this shipment&apos;s price, so we can&apos;t finish it
          here — nothing has been burned and your slab is safe in your wallet. Get in
          touch with the shipment id above and we&apos;ll sort it out.
        </p>
      )
    return (
      <>
        <p className="mt-3 text-xs text-muted-foreground">
          This shipment was set up but the burn never went through, so nothing has
          been charged and your slab is still yours. Finishing pays{" "}
          {dollars(cents / 100)} and mails it to the address already on the shipment.
        </p>
        <Button
          className="mt-3"
          onClick={() => confirm("", cents, { kind: "existing", status })}
        >
          Finish the burn · {dollars(cents / 100)}
        </Button>
      </>
    )
  }

  return (
    <div className="w-full max-w-lg">
      <button
        onClick={() => onClose(step.kind === "shipped")}
        disabled={busy}
        className="mb-3 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        ← Back to collection
      </button>
      <h1 className="font-heading text-2xl">Ship this slab</h1>
      <p className="mb-5 text-xs text-muted-foreground">
        {card.name} · insured {usd(card.insuredValueCents)}. Shipping burns the NFT and
        can&apos;t be undone — the physical card is mailed to you instead.
      </p>

      {err && (
        <div className="mb-4 rounded-xl border border-no/40 bg-no/10 p-3 text-sm">{err}</div>
      )}

      {step.kind === "loading" ? (
        <div className="h-24 animate-pulse rounded-2xl border border-border bg-surface" />
      ) : step.kind === "working" ? (
        <div className="rounded-2xl border border-border bg-surface p-6 text-center text-sm">
          {step.note}
          <p className="mt-2 text-xs text-muted-foreground">
            Keep this page open — closing it mid-payment can strand funds in your pack
            wallet.
          </p>
        </div>
      ) : step.kind === "existing" ? (
        <>
          <Shipment
            shipmentId={step.status.shipmentId}
            label={REDEEM_LABEL[step.status.redeemStatus] ?? step.status.status}
            urls={step.status.trackingUrls ?? []}
            company={step.status.deliveryCompany}
          />
          {/* Prepared but never burned — a tab closed between prepare and burn
              lands here, and without this the card is stuck on "Waiting on the
              burn" forever. shipRedeem routes pending_burn through
              redeem/resume, which rebuilds THIS shipment rather than creating
              a second one, so the address and price are the ones already on
              file — no form to fill in again. */}
          {step.status.redeemStatus === "pending_burn" && finishBurn(step.status)}
        </>
      ) : step.kind === "shipped" ? (
        <Shipment
          shipmentId={step.shipmentId}
          label="Burned and queued for shipping"
          urls={step.urls}
        />
      ) : step.kind === "quoted" ? (
        <div className="rounded-2xl border border-border bg-surface p-4">
          <dl className="text-sm">
            {(step.estimate.breakdown?.lines ?? []).map((l) => (
              <div key={l.code} className="flex justify-between py-1">
                <dt className="text-muted-foreground">{l.label}</dt>
                <dd>{dollars(l.amount)}</dd>
              </div>
            ))}
            <div className="mt-2 flex justify-between border-t border-border pt-2 font-medium">
              <dt>
                Total · {step.estimate.numberOfCards}{" "}
                {step.estimate.numberOfCards === 1 ? "card" : "cards"}
              </dt>
              <dd>{dollars(step.estimate.total)}</dd>
            </div>
          </dl>
          {(step.estimate.breakdown?.notes ?? []).map((n) => (
            <p key={n} className="mt-2 text-xs text-muted-foreground">
              {n}
            </p>
          ))}
          <p className="mt-3 text-xs text-muted-foreground">
            Paid from your balance. The slab is burned once the payment lands.
          </p>
          <div className="mt-4 flex gap-2">
            <Button
              onClick={() =>
                confirm(
                  step.shippingAddressId,
                  Math.ceil(step.estimate.total * 100),
                  step,
                )
              }
            >
              Pay {dollars(step.estimate.total)} &amp; ship
            </Button>
            <Button variant="ghost" onClick={() => setStep({ kind: "form" })}>
              Change address
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submitAddress} className="flex flex-col gap-3">
          <Field
            name="name"
            label="Full name"
            defaultValue={saved.name}
            maxLength={100}
            autoComplete="shipping name"
            autoCapitalize="words"
            autoFocus
          />
          <Field
            name="email"
            label="Email"
            type="email"
            defaultValue={saved.email ?? user?.email?.address}
            maxLength={254}
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
          />
          <Field
            name="line1"
            label="Address"
            defaultValue={saved.line1}
            maxLength={100}
            autoComplete="shipping address-line1"
          />
          <Field
            name="line2"
            label="Apartment, suite (optional)"
            required={false}
            defaultValue={saved.line2}
            maxLength={100}
            autoComplete="shipping address-line2"
          />
          <div className="grid grid-cols-2 gap-3">
            <Field name="city" label="City" defaultValue={saved.city} maxLength={60} autoComplete="shipping address-level2" />
            <Field name="state" label="State / region" defaultValue={saved.state} maxLength={60} autoComplete="shipping address-level1" />
            <Field name="postalCode" label="Postal code" defaultValue={saved.postalCode} maxLength={20} autoComplete="shipping postal-code" />
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Country
              <select
                name="country"
                required
                // length>2 filters legacy ISO-code saves that no option matches
                defaultValue={
                  saved.country && saved.country.length > 2 ? saved.country : "United States"
                }
                autoComplete="shipping country"
                className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 py-1 text-base text-foreground transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30 [&>option]:bg-surface [&>option]:text-foreground"
              >
                {COUNTRIES.map(([code, name]) => (
                  <option key={code} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Field
            name="phoneNumber"
            label="Phone (optional)"
            type="tel"
            required={false}
            defaultValue={saved.phoneNumber}
            maxLength={20}
            autoComplete="shipping tel"
          />
          <Button type="submit" className="mt-1 self-start">
            Get shipping quote
          </Button>
        </form>
      )}
      <GetHelp className="mt-4" />
    </div>
  )
}

function Field({
  name,
  label,
  required = true,
  ...rest
}: React.ComponentProps<"input"> & { label: string }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <Input name={name} required={required} {...rest} />
    </label>
  )
}

function Shipment({
  shipmentId,
  label,
  urls,
  company,
}: {
  shipmentId: string
  label: string
  urls: string[]
  company?: string
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4 text-sm">
      <p className="font-medium">{label}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Shipment {shipmentId}
        {company ? ` · ${company}` : ""}
      </p>
      {urls.map((u) => (
        <a
          key={u}
          href={u}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 block truncate text-xs text-brand hover:underline"
        >
          {u}
        </a>
      ))}
    </div>
  )
}
