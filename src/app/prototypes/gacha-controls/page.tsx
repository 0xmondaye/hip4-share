"use client"

// PROTOTYPE SURFACE — delete this directory once a direction is picked.
//
// Mobile placement study for the gacha pack stage's pull cluster. The real
// stage is `fixed inset-x-0 bottom-0 top-16` with the controls `absolute
// bottom-0` inside it, so the CTA touches the screen edge on any device
// without a home indicator. This harness rebuilds that geometry exactly —
// same 4rem header offset, same px-4 gutters, same py-4 column, same
// max-w-xl cluster — and swaps only the controls layer.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Anchored, Current, Lifted, ThumbDeck } from "./variants"

const VARIANTS = [
  { name: "Current", render: Current },
  { name: "Lifted", render: Lifted },
  { name: "Anchored", render: Anchored },
  { name: "Thumb Deck", render: ThumbDeck },
] as const

// Verbatim from the prototype skill's PICKER.md. Harness chrome — not a
// design decision, never themed with the project's tokens.
const PICKER_CSS = `
.proto-picker {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483647;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 999px;
  background: rgba(10, 10, 10, 0.82);
  -webkit-backdrop-filter: blur(12px) saturate(1.4);
  backdrop-filter: blur(12px) saturate(1.4);
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.08) inset,
    0 8px 24px rgba(0, 0, 0, 0.24),
    0 2px 6px rgba(0, 0, 0, 0.12);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 13px;
  line-height: 1;
  -webkit-font-smoothing: antialiased;
  user-select: none;
  -webkit-user-select: none;
}

.proto-picker-highlight {
  position: absolute;
  top: 4px;
  left: 0;
  height: 28px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  will-change: transform;
}

.proto-picker[data-ready] .proto-picker-highlight {
  transition:
    transform 250ms cubic-bezier(0.23, 1, 0.32, 1),
    width 250ms cubic-bezier(0.23, 1, 0.32, 1);
}

@media (prefers-reduced-motion: reduce) {
  .proto-picker[data-ready] .proto-picker-highlight { transition: none; }
}

.proto-picker-item {
  position: relative;
  display: flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: rgba(255, 255, 255, 0.55);
  font: inherit;
  cursor: pointer;
  transition: color 150ms ease-out;
}

.proto-picker-item:hover {
  color: rgba(255, 255, 255, 0.85);
}

.proto-picker-item:active {
  transform: scale(0.97);
}

.proto-picker-item:focus-visible {
  outline: 2px solid rgba(255, 255, 255, 0.4);
  outline-offset: 2px;
}

.proto-picker-item[data-active] {
  color: #fff;
}

.proto-picker-divider {
  width: 1px;
  height: 16px;
  margin: 0 4px;
  background: rgba(255, 255, 255, 0.12);
}

.proto-picker-replay {
  padding: 0 10px;
  font-size: 14px;
}

.proto-picker[data-position="top"] {
  bottom: auto;
  top: 24px;
}
`

export default function GachaControlsPrototype() {
  const [i, setI] = useState(0)
  const [ready, setReady] = useState(false)
  // Production measures the buy cluster and centres the pack in the band above
  // it, so the mock has to as well — otherwise a variant that reserves more
  // room would be judged against a pack that ignored the difference.
  const [chromeBottom, setChromeBottom] = useState(296)
  const clusterRO = useRef<ResizeObserver | null>(null)
  const clusterRef = useCallback((el: HTMLDivElement | null) => {
    clusterRO.current?.disconnect()
    if (!el) return
    clusterRO.current = new ResizeObserver(() =>
      // Distance from the cluster's TOP edge to the bottom of the screen, not its
      // own height: a cluster that floats above the edge reserves both.
      setChromeBottom(window.innerHeight - el.getBoundingClientRect().top),
    )
    clusterRO.current.observe(el)
  }, [])
  const nav = useRef<HTMLElement>(null)
  const items = useRef<(HTMLButtonElement | null)[]>([])
  const [hl, setHl] = useState({ w: 0, x: 0 })

  const measure = useCallback(() => {
    const el = items.current[i]
    if (el) setHl({ w: el.offsetWidth, x: el.offsetLeft })
  }, [i])

  // Selection survives reload via ?v=, falling back to variant 1.
  useEffect(() => {
    const v = parseInt(new URLSearchParams(location.search).get("v") ?? "", 10)
    if (v >= 1 && v <= VARIANTS.length) setI(v - 1)
  }, [])

  useLayoutEffect(measure, [measure])

  // The URL write belongs to the act of choosing, not to `i` changing. As an
  // effect on [i] it fired on mount with i=0 and overwrote ?v= before the read
  // above had landed — then StrictMode's second mount read the clobbered value,
  // so every deep link opened variant 1.
  const select = useCallback((n: number) => {
    setI(n)
    const url = new URL(location.href)
    url.searchParams.set("v", String(n + 1))
    history.replaceState(null, "", url)
  }, [])

  useEffect(() => {
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [measure])

  // Enable the slide only after first paint, so load doesn't animate.
  useEffect(() => {
    const r = requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)))
    return () => cancelAnimationFrame(r)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const n = parseInt(e.key, 10)
      if (n >= 1 && n <= VARIANTS.length) select(n - 1)
      else if (e.key === "ArrowRight") select((i + 1) % VARIANTS.length)
      else if (e.key === "ArrowLeft") select((i - 1 + VARIANTS.length) % VARIANTS.length)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [i, select])

  const Variant = VARIANTS[i].render

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: PICKER_CSS }} />

      {/* Covers the app's real header and bottom nav so the study is judged
          against the stage's own framing, not this route's chrome. */}
      <div className="fixed inset-0 z-[60] bg-background">
        {/* Stand-in for the app header the stage sits under (4rem). */}
        <div className="fixed inset-x-0 top-0 z-10 flex h-16 items-center justify-between px-4">
          <span className="font-heading text-sm">SPECULATE</span>
          <span className="rounded-full bg-surface px-3 py-1.5 text-xs text-muted-foreground">
            $142.60
          </span>
        </div>

        {/* Ground + pack. The real pack is a GLB on a `fixed inset-0` canvas
            framed by PackRip's own math; this box reproduces that math in CSS —
            band = the gap between the 4rem header and the 296px buy cluster,
            pack = 86% of the band, centred in it — so the placement study is
            judged against the pack the user will actually see. */}
        <div
          className="pointer-events-none fixed inset-x-0 top-16 grid place-items-center bg-background"
          style={{ bottom: chromeBottom }}
        >
          <div className="aspect-[1/1.5794] h-[78%] rounded-xl border border-white/10 bg-gradient-to-b from-brand/25 via-surface-2 to-black shadow-[0_24px_64px_rgba(0,0,0,0.6)]">
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <span aria-hidden className="text-4xl">
                ⚾
              </span>
              <span className="font-heading text-sm">PROSPECT</span>
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Baseball · Series 3
              </span>
            </div>
          </div>
        </div>

        {/* The stage, geometry-identical to production. */}
        <div className="fixed inset-x-0 bottom-0 top-16 overflow-hidden px-4">
          <div className="relative flex h-full min-h-0 w-full flex-col gap-4 py-4">
            {/* The pack-art track. Absolute variants leave it whole; the
                in-flow variant makes it give up its own height. */}
            <div className="min-h-0 flex-1" />
            <Variant measureRef={clusterRef} />
          </div>
        </div>
      </div>

      {/* Every variant lives at the bottom of the screen, so the picker moves
          to the top — the one modification PICKER.md allows. */}
      <nav
        ref={nav}
        className="proto-picker"
        data-position="top"
        data-ready={ready ? "" : undefined}
        aria-label="Prototype variants"
      >
        <span
          className="proto-picker-highlight"
          aria-hidden="true"
          style={{ width: hl.w, transform: `translateX(${hl.x}px)` }}
        />
        {VARIANTS.map((v, j) => (
          <button
            key={v.name}
            ref={(el) => {
              items.current[j] = el
            }}
            className="proto-picker-item"
            data-active={j === i ? "" : undefined}
            aria-current={j === i ? "true" : undefined}
            onClick={() => select(j)}
          >
            {v.name}
          </button>
        ))}
      </nav>
    </>
  )
}
