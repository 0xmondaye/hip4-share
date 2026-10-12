"use client"

import { useEffect, useState } from "react"

/**
 * Sticky header that fades in a gradual (progressive) blur while scrolled —
 * desktop only. Mobile has no bar at all: the brand and balance ride in their
 * own glass pills, iOS 26 style.
 *
 * ponytail: a scroll listener, not a scroll-driven CSS animation. This layout
 * puts `h-full` on <html>, so `scroll(root)` resolves to a scroller with a dead
 * range and pins the timeline at 100% even at scrollY 0.
 */
const BLUR_LAYERS = 5

export function ScrollHeader({ children }: { children: React.ReactNode }) {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 0)
    onScroll() // reload restores a scroll offset before this mounts
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  return (
    <header className="sticky top-0 z-10">
      {/* gradual blur: stacked backdrop-filter layers, each masked to a band,
          strongest at the top and fading past the header's bottom edge */}
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 top-0 hidden h-[130%] bg-gradient-to-b from-surface/70 to-transparent transition-opacity lg:block ${
          scrolled ? "opacity-100" : "opacity-0"
        }`}
      >
        {Array.from({ length: BLUR_LAYERS }, (_, i) => {
          const stops = [i - 1, i, i + 1, i + 2].map(
            (n) => `${(n / BLUR_LAYERS) * 100}%`
          )
          const mask = `linear-gradient(to bottom, transparent ${stops[0]}, black ${stops[1]}, black ${stops[2]}, transparent ${stops[3]})`
          const blur = `blur(${2 ** (BLUR_LAYERS - 1 - i)}px)`
          return (
            <div
              key={i}
              className="absolute inset-0"
              style={{
                backdropFilter: blur,
                WebkitBackdropFilter: blur,
                maskImage: mask,
                WebkitMaskImage: mask,
              }}
            />
          )
        })}
      </div>
      <div className="relative">{children}</div>
    </header>
  )
}
