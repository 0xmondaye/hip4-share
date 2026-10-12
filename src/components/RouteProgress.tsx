"use client"

import { useEffect, useState } from "react"
import { usePathname } from "next/navigation"

/**
 * Lime bar across the top of the viewport while a route change is in flight.
 *
 * ponytail: a click listener plus `usePathname`, not the nprogress package.
 * App Router fires no router events, so nprogress would need these exact two
 * triggers wired by hand anyway and then have its blue CSS overridden — the
 * dependency buys nothing. `useLinkStatus` is the accurate signal but only
 * reads inside a <Link>, and sixteen files render links.
 *
 * Ceiling: programmatic `router.push()` and back/forward don't raise the bar.
 * Move the trigger into a shared Link wrapper if that starts to matter.
 */
export function RouteProgress() {
  const pathname = usePathname()
  const [loading, setLoading] = useState(false)

  // the new route committed, so whatever raised the bar has landed
  useEffect(() => setLoading(false), [pathname])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0) return
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return // opens a tab, not this one
      const a = (e.target as Element | null)?.closest("a")
      if (
        !(a instanceof HTMLAnchorElement) ||
        a.target ||
        a.hasAttribute("download") ||
        a.origin !== location.origin || // also drops href-less anchors: origin is ""
        // same pathname means usePathname never fires and the bar would hang.
        // Costs the bar on search-param-only navigations, which are instant.
        a.pathname === location.pathname
      )
        return
      setLoading(true)
    }
    // capture, not bubble: <Link> calls preventDefault() on its way to the
    // client transition, so by the time a bubbled click reaches document every
    // internal navigation already looks cancelled
    document.addEventListener("click", onClick, true)
    return () => document.removeEventListener("click", onClick, true)
  }, [])

  useEffect(() => {
    if (!loading) return
    // a navigation that never commits would otherwise pin the bar forever
    const t = setTimeout(() => setLoading(false), 15_000)
    return () => clearTimeout(t)
  }, [loading])

  if (!loading) return null
  return (
    <div
      aria-hidden
      className="route-progress pointer-events-none fixed inset-x-0 top-0 z-[60] h-0.5 origin-left bg-brand shadow-[0_0_8px_var(--brand)]"
    />
  )
}
