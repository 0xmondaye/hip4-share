"use client"

// PROTOTYPE SURFACE — delete with the directory once a direction is picked.
// Nothing in production imports from here.
//
// Three answers to one question: where does the mobile pull cluster sit
// relative to the bottom edge of the gacha stage?

/* ------------------------------------------------------------------ *
 * Shared pieces. Identical copy and controls in every variant, so the
 * only thing being judged is placement and hierarchy.
 * ------------------------------------------------------------------ */

const TIERS = [
  ["Rookie", "$5"],
  ["Prospect", "$25"],
  ["All-Star", "$100"],
  ["Hall of Fame", "$500"],
] as const
const QTY = [1, 3, 5, 10] as const

function InsidePill() {
  return (
    <button className="mx-auto mb-2 flex items-center gap-2 rounded-full border border-white/15 bg-black/80 px-4 py-1.5 text-xs text-muted-foreground backdrop-blur-sm transition-colors hover:text-foreground">
      <span aria-hidden>◆</span>
      See what&apos;s inside
    </button>
  )
}

function SelectorRow() {
  return (
    <div className="mb-2 flex items-center gap-2">
      <button
        aria-label="Pick a universe"
        className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-white/15 bg-black/80 px-3 backdrop-blur-sm transition-colors hover:text-foreground"
      >
        <span aria-hidden className="text-lg leading-none">
          ⚾
        </span>
        <span aria-hidden className="text-[10px] text-muted-foreground">
          ▾
        </span>
      </button>
      <div className="-my-1 flex min-w-0 flex-1 gap-2 overflow-x-auto py-1">
        {TIERS.map(([name, price], i) => (
          <button
            key={name}
            aria-pressed={i === 1}
            className={`flex h-11 shrink-0 items-center gap-2 rounded-xl border px-3 text-sm backdrop-blur-sm transition ${
              i === 1
                ? "border-transparent bg-brand/15 text-brand"
                : "border-white/15 bg-black/80 text-muted-foreground hover:text-foreground"
            }`}
          >
            <span className="truncate">{name}</span>
            <span className="shrink-0 font-mono text-xs tabular-nums">{price}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function PriceRow() {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <span className="font-heading text-3xl tabular-nums drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]">
        $25.00
      </span>
      <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-black/80 p-1 backdrop-blur-sm shadow-[inset_0_1px_0_0_rgb(255_255_255/0.12)]">
        {QTY.map((n) => (
          <button
            key={n}
            aria-pressed={n === 1}
            className={`h-9 min-w-10 rounded-lg px-2 text-sm tabular-nums transition-colors ${
              n === 1 ? "bg-white/15 text-brand" : "hover:text-brand"
            }`}
          >
            ×{n}
          </button>
        ))}
      </div>
    </div>
  )
}

function Cta() {
  return (
    <button className="btn-brand w-full py-3.5 font-heading text-lg">Open pack · $25.00</button>
  )
}

function BalanceNote({ className }: { className: string }) {
  return <p className={className}>Paid from your balance — $142.60 available</p>
}

function CardPay({ className }: { className: string }) {
  return (
    <button
      className={`w-full rounded-xl border border-white/15 bg-black/80 py-2.5 text-sm backdrop-blur-sm transition-colors hover:text-brand ${className}`}
    >
      Pay with card
    </button>
  )
}

/** Every variant takes the harness's measuring ref on its outermost node, so
 *  the mock pack centres in the band that variant actually leaves — the same
 *  measurement production does. */
type V = { measureRef: (el: HTMLDivElement | null) => void }

/* ------------------------------------------------------------------ *
 * 0 — Current. Today's shipped placement, for reference.
 * ------------------------------------------------------------------ */

export function Current({ measureRef }: V) {
  return (
    <div
      ref={measureRef}
      className="absolute inset-x-0 bottom-0 pt-3 pb-[env(safe-area-inset-bottom)]"
    >
      <div className="mx-auto w-full max-w-xl">
        <InsidePill />
        <SelectorRow />
        <PriceRow />
        <Cta />
        <BalanceNote className="mt-1.5 text-center text-[11px] text-muted-foreground" />
        <CardPay className="mt-2" />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 1 — Lifted. Axis: still pinned, inset off the edge.
 * The cluster keeps every position the thumb already learned; it just
 * stops touching the screen. Becoming a discrete rounded card is what
 * makes the gap below read as framing rather than a bar that slipped.
 * ------------------------------------------------------------------ */

export function Lifted({ measureRef }: V) {
  return (
    <div
      ref={measureRef}
      className="absolute inset-x-0 bottom-[calc(1rem+env(safe-area-inset-bottom))] px-1"
    >
      <div className="mx-auto w-full max-w-xl">
        <InsidePill />
        <div className="rounded-3xl border border-white/10 bg-black/55 p-3 backdrop-blur-md shadow-[0_8px_32px_rgba(0,0,0,0.45),inset_0_1px_0_0_rgb(255_255_255/0.08)]">
          <SelectorRow />
          <PriceRow />
          <Cta />
          <BalanceNote className="mt-1.5 text-center text-[11px] text-muted-foreground" />
          <CardPay className="mt-2" />
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 2 — Anchored. Axis: in flow, unpinned.
 * The cluster is the last child of the stage column, so the stage's own
 * py-4 supplies the bottom breathing room and the pack art track gives
 * up exactly the height the controls need. Nothing ever overlaps the
 * pack — the button's position is a function of content, not of the
 * viewport edge.
 * ------------------------------------------------------------------ */

export function Anchored({ measureRef }: V) {
  return (
    <div ref={measureRef} className="shrink-0 pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto w-full max-w-xl">
        <InsidePill />
        <SelectorRow />
        <PriceRow />
        <Cta />
        <BalanceNote className="mt-1.5 text-center text-[11px] text-muted-foreground" />
        <CardPay className="mt-2" />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 3 — Thumb Deck. Axis: ergonomics + hierarchy.
 * Hoisted into the natural thumb arc, and reordered so the primary
 * action is the LOWEST thing on screen — the balance note and the card
 * rail move above it. Nothing sits below the money button but ground,
 * and the bottom band becomes pack art again.
 * ------------------------------------------------------------------ */

export function ThumbDeck({ measureRef }: V) {
  return (
    <div
      ref={measureRef}
      className="absolute inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))]"
    >
      <div className="mx-auto w-full max-w-xl">
        <InsidePill />
        <SelectorRow />
        <PriceRow />
        <CardPay className="mb-2" />
        <BalanceNote className="mb-1.5 text-center text-[11px] text-muted-foreground" />
        <Cta />
      </div>
    </div>
  )
}
