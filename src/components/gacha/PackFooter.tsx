"use client"

// The four questions support actually gets. The index grid is gone (the stage is the
// storefront now), so this content moved here — below the fold of the pack
// page, where it can be read without standing between the user and the rip
// button. The Cellar left with it (a wine gacha is a universe you pick in the
// rail, not a banner you scroll to), and so did the four how-it-works steps —
// a stage that shows the pack, the price and the button doesn't need them.

import { SELLBACK_WINDOW_H } from "@/lib/gacha-core"

export function PackFooter({ className = "" }: { className?: string }) {
  return (
    <div className={className}>
      {/* Static FAQ — native <details>: no state, no dependency. */}
      <div className="mt-8">
        <h2 className="mb-3 text-xs uppercase tracking-wider text-muted-foreground">
          Common questions
        </h2>
        <div className="flex flex-col gap-2">
          {[
            [
              "Are the cards real?",
              "Yes. Every pull is a professionally graded slab. The NFT lands in your own wallet the moment you open the pack, and the physical card ships to you whenever you redeem it.",
            ],
            [
              "What's sell-back?",
              `For ${SELLBACK_WINDOW_H} hours after a pull you can sell the card back at the quoted offer — you get the full amount, paid straight into your balance. After ${SELLBACK_WINDOW_H}h the card is yours to keep or ship.`,
            ],
            [
              "Where do my cards go?",
              "Into your wallet, shown on the Collection tab — slabs from packs, bottles from the Cellar, plus your sold-and-shipped history.",
            ],
            [
              "How does shipping work?",
              "“Ship home” on a card in your collection burns the NFT and mails you the physical slab — you'll see the shipping price before paying, and it can't be undone once burned.",
            ],
          ].map(([q, a]) => (
            <details key={q} className="group rounded-xl border border-border bg-surface px-4 py-3">
              <summary className="cursor-pointer list-none text-sm font-medium marker:hidden [&::-webkit-details-marker]:hidden">
                <span
                  aria-hidden
                  className="mr-2 inline-block text-muted-foreground transition-transform duration-150 group-open:rotate-90"
                >
                  ›
                </span>
                {q}
              </summary>
              <p className="mt-2 pl-5 text-xs leading-relaxed text-muted-foreground">{a}</p>
            </details>
          ))}
        </div>
      </div>
    </div>
  )
}

export default PackFooter
