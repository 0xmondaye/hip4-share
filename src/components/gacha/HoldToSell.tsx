"use client"

// Hold-to-confirm for sell-back — the ONE interaction for an irreversible
// sale, shared by the reveal theater and the collection grid (they used to
// disagree: plain click in one, 600ms hold in the other, same money).
//
// Pointer: press and hold; a fill bar sweeps the button and the sale commits
// when it completes. Keyboard: first Enter/Space arms and relabels, a second
// commits. The armed state EXPIRES on a timer as well as on blur: an arm that
// outlives the user's attention means the next Enter sells with no
// confirmation step, and blur alone is a weak guarantee — it never fires if
// focus leaves the document itself. The TTL is the one that always holds.

import { useEffect, useRef, useState } from "react"

const HOLD_MS = 600
const ARM_TTL_MS = 3000

export function HoldToSell({
  label,
  disabled,
  onCommit,
  className = "",
}: {
  label: string
  disabled?: boolean
  onCommit: () => void
  /** full visual treatment comes from the call site; this component only
   *  owns the hold/arm mechanics and the fill bar */
  className?: string
}) {
  const [holding, setHolding] = useState(false)
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const stop = () => {
    clearTimeout(timer.current)
    setHolding(false)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), ARM_TTL_MS)
    return () => clearTimeout(t)
  }, [armed])

  return (
    // A plain button rather than <Button>: this needs plain, predictable
    // focus/blur and pointer semantics on a control that sells real money.
    <button
      type="button"
      onBlur={() => setArmed(false)}
      className={`relative overflow-hidden ${className}`}
      disabled={disabled}
      onPointerDown={(e) => {
        // primary button only: a right-click's pointerup is swallowed by the
        // context menu, so the 600ms timer would fire and SELL under the menu
        if (disabled || e.button !== 0) return
        setHolding(true)
        timer.current = setTimeout(() => {
          setHolding(false)
          onCommit()
        }, HOLD_MS)
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(e) => {
        if (disabled || (e.key !== "Enter" && e.key !== " ")) return
        e.preventDefault() // never let the native click sell on one keystroke
        // key auto-repeat must not turn one held Enter into arm+confirm —
        // the two presses have to be two deliberate keystrokes
        if (e.repeat) return
        if (armed) onCommit()
        setArmed(!armed)
      }}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-full bg-brand/30"
        style={{
          // Both endpoints keep the same unit type: an inset() whose
          // components differ (0 vs 100%) is the shape most likely to fall back
          // to a discrete transition. Verified interpolating 100%→0% linearly.
          clipPath: holding ? "inset(0 0% 0 0)" : "inset(0 100% 0 0)",
          transition: holding
            ? `clip-path ${HOLD_MS}ms linear`
            : "clip-path 200ms var(--ease-smooth-out, ease-out)",
        }}
      />
      {/* the price on the button is the consent — it must survive arming */}
      <span className="relative">{armed ? `Press again — ${label}` : label}</span>
    </button>
  )
}
