"use client"

import { useLayoutEffect, useRef, type ReactNode } from "react"
import { cn } from "@/lib/utils"

export function StickySidebar({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const panel = ref.current!
    // The banner can put the sidebar below its sticky offset on first load.
    const measure = () => {
      panel.style.setProperty("--sidebar-top", `${panel.getBoundingClientRect().top}px`)
      panel.style.visibility = "visible"
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(panel.parentElement!)
    window.addEventListener("scroll", measure, { passive: true })
    window.addEventListener("resize", measure)
    return () => {
      observer.disconnect()
      window.removeEventListener("scroll", measure)
      window.removeEventListener("resize", measure)
    }
  }, [])

  return (
    <div
      ref={ref}
      className={cn(
        "min-w-0 [--sidebar-height:max(0px,calc(100dvh-max(5rem,var(--sidebar-top,5rem))-1rem))] lg:invisible lg:sticky lg:top-20 lg:max-h-(--sidebar-height)",
        className,
      )}
    >
      {children}
    </div>
  )
}
