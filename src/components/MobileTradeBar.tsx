"use client"

import { useState } from "react"
import type { EnrichedOutcome, Question } from "@/lib/types"
import { TradePanel, fmtMult } from "./TradePanel"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"

interface MobileTradeBarProps {
  outcome: EnrichedOutcome
  initialSide?: 0 | 1
  context?: string
  title?: string
  question?: Question | null
}

/** Mobile-only fixed bottom bar; tapping a side opens the order form in a bottom sheet. */
export function MobileTradeBar({
  outcome,
  initialSide = 0,
  context,
  title,
  question,
}: MobileTradeBarProps) {
  const [open, setOpen] = useState(false)
  const [side, setSide] = useState<0 | 1>(initialSide)

  const nameFor = (idx: number) =>
    outcome.parsedMeta?.class === "priceBinary"
      ? idx === 0
        ? "Up"
        : "Down"
      : (outcome.sideSpecs[idx]?.name ?? (idx === 0 ? "Yes" : "No"))

  return (
    <>
      {/* ponytail: same glass pill as BottomNav (reuses its #nav-glass filter);
          0.375rem gap above the nav's own 0.375rem + 3.75rem */}
      <div className="glass lg:hidden fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-40 flex w-[min(100vw-1.5rem,24rem)] items-center gap-1.5 rounded-full p-1.5">
        {outcome.sides.map((s, idx) => (
          <button
            key={s.coin}
            type="button"
            onClick={() => {
              setSide(idx as 0 | 1)
              setOpen(true)
            }}
            className={`h-12 flex-1 rounded-full px-3 text-sm font-bold uppercase tracking-wide flex items-center justify-center gap-2 shadow-[inset_0_1px_0_0_rgb(255_255_255/0.12)] transition active:scale-[0.98] ${
              idx === 0 ? "bg-yes/15 text-yes" : "bg-no/15 text-no"
            }`}
          >
            <span className="truncate">{nameFor(idx)}</span>
            <span className="font-mono tabular-nums font-semibold">
              {fmtMult(s.mid)}
            </span>
          </button>
        ))}
      </div>

      <Drawer open={open} onOpenChange={setOpen} showSwipeHandle>
        <DrawerContent>
          <DrawerTitle className="sr-only">Order form</DrawerTitle>
          <div className="overflow-y-auto pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
            {/* key remounts the panel so initialSide follows the tapped button */}
            <TradePanel
              key={side}
              outcome={outcome}
              initialSide={side}
              context={context}
              title={title}
              question={question}
              bare
            />
          </div>
        </DrawerContent>
      </Drawer>
    </>
  )
}
