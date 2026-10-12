"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ChartLineData01Icon,
  DicesIcon,
  Home01Icon,
  RankingIcon,
} from "@hugeicons/core-free-icons"

const ITEMS = [
  { href: "/", label: "Markets", desktopLabel: "Markets", icon: Home01Icon },
  { href: "/portfolio", label: "Portfolio", desktopLabel: "Portfolio", icon: ChartLineData01Icon },
  { href: "/leaderboard", label: "Leaders", desktopLabel: "Leaderboard", icon: RankingIcon },
  { href: "/gacha", label: "Gacha", desktopLabel: "Gacha", icon: DicesIcon },
] as const

/**
 * Displacement map for the glass. Red bends X, green bends Y, 128 is no bend —
 * so each ramp sits neutral through the middle and swings hard at the two
 * edges, which is where a lens actually bends light. Kept as two separable
 * ramps added together: `preserveAspectRatio="none"` stretches them to whatever
 * size the pill currently is, so the resize tween needs no remeasuring.
 */
const ramp = (vertical: boolean, edge: string, mid: string) =>
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'>` +
      `<linearGradient id='g' x1='0' y1='0' x2='${vertical ? 0 : 1}' y2='${vertical ? 1 : 0}'>` +
      `<stop offset='0' stop-color='${edge}'/>` +
      `<stop offset='${vertical ? 0.34 : 0.13}' stop-color='${mid}'/>` +
      `<stop offset='${vertical ? 0.66 : 0.87}' stop-color='${mid}'/>` +
      `<stop offset='1' stop-color='#000'/>` +
      `</linearGradient>` +
      `<rect width='100' height='100' fill='url(%23g)'/></svg>`,
  )

// ponytail: everything except the named sections is a market view
function isActive(pathname: string, href: string) {
  return href === "/"
    ? !pathname.startsWith("/portfolio") &&
        !pathname.startsWith("/leaderboard") &&
        !pathname.startsWith("/gacha")
    : pathname.startsWith(href)
}

/** Desktop header nav, left of the brand à la packs.com. Hidden below lg.
 *  Portfolio lives in the balance pill on the right (AuthMenu). */
export function DesktopNav() {
  const pathname = usePathname()
  return (
    <nav className="hidden lg:flex items-center gap-2 text-base font-semibold">
      {ITEMS.filter(({ href }) => href !== "/portfolio").map(
        ({ href, desktopLabel }) => (
          <Link
            key={href}
            href={href}
            className={`px-3 py-2 transition ${
              isActive(pathname, href)
                ? "text-brand"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {desktopLabel}
          </Link>
        ),
      )}
    </nav>
  )
}

/**
 * iOS 26-style floating pill. Icon-only. Hidden on lg+.
 *
 * Wide at rest, contracts to the icon cluster while scrolling down and
 * re-expands on the way back up.
 */
export function BottomNav() {
  const pathname = usePathname()
  const [compact, setCompact] = useState(false)
  // pack pages swap the nav for their own glass order bar; the <svg> filter
  // below still has to mount — every .glass surface refracts via #nav-glass.
  // /gacha/cellar is the stage too (a universe, not a route of its own).
  const packPage = /^\/gacha\/(?!collection)./.test(pathname)
  const activeIndex = Math.max(
    0,
    ITEMS.findIndex(({ href }) => isActive(pathname, href)),
  )

  useEffect(() => {
    let last = window.scrollY
    const onScroll = () => {
      const y = window.scrollY
      if (Math.abs(y - last) < 8) return // ponytail: deadzone kills the jitter flip-flop
      setCompact(y > last && y > 64)
      last = y
    }
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  return (
    <>
      <svg aria-hidden className="absolute size-0">
        <filter
          id="nav-glass"
          colorInterpolationFilters="sRGB"
          x="0%"
          y="0%"
          width="100%"
          height="100%"
        >
          <feImage href={ramp(false, "#f00", "#800000")} preserveAspectRatio="none" result="x" />
          <feImage href={ramp(true, "#0f0", "#008000")} preserveAspectRatio="none" result="y" />
          {/* channels don't overlap, so a plain add merges them into one map */}
          <feComposite in="x" in2="y" operator="arithmetic" k2="1" k3="1" result="map" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="map"
            scale="16"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </svg>
      {/* ponytail: 0.375rem gap + 3.75rem pill; layout.tsx main pads 5.5rem to clear it */}
      {!packPage && (
      <nav
      className={`bottom-nav t-resize glass lg:hidden fixed bottom-[calc(0.375rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-50 flex items-center rounded-full p-1.5 ${
        // compact width = 4 × 3rem tap target + 0.75rem padding
        compact ? "w-[12.75rem]" : "w-[min(100vw-1.5rem,24rem)]"
      }`}
    >
      {/* slot-wide, so translateX(100%) lands exactly one item over */}
      <span
        aria-hidden
        className="t-tabs-pill pointer-events-none absolute top-1.5 left-1.5 z-0 h-12 w-[calc((100%-0.75rem)/4)] rounded-full bg-white/10 shadow-[inset_0_1px_0_0_rgb(255_255_255/0.12)]"
        style={{ transform: `translateX(${activeIndex * 100}%)` }}
      />
      {ITEMS.map(({ href, label, icon }, i) => (
        <Link
          key={href}
          href={href}
          aria-label={label}
          aria-current={i === activeIndex ? "page" : undefined}
          className={`relative z-10 grid h-12 flex-1 place-items-center duration-(--tabs-dur) ease-(--tabs-ease) transition-colors ${
            i === activeIndex ? "text-brand" : "text-muted-foreground"
          }`}
        >
          <HugeiconsIcon icon={icon} className="size-6" />
        </Link>
        ))}
      </nav>
      )}
    </>
  )
}
