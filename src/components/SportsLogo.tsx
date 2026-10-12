"use client"

import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ChampionIcon, EqualSignIcon } from "@hugeicons/core-free-icons"
import { flagCode } from "@/lib/flags"
import logos from "@/lib/sports-logos.json"
import { cn } from "@/lib/utils"

// ESPN's public league/team catalogs, checked September 2026. New teams
// use initials until their logo is added; no runtime catalog request.
export function SportsLogo({
  name,
  competition = false,
  className,
}: {
  name: string
  competition?: boolean
  className?: string
}) {
  const [failedSrc, setFailedSrc] = useState<string>()
  const flag = flagCode(name)
  const src = (logos as Record<string, string>)[name] ??
    (flag ? `https://flagcdn.com/w80/${flag}.png` : undefined)
  const showLogo = src && src !== failedSrc

  return (
    <span
      aria-hidden="true"
      className={cn(`inline-flex shrink-0 items-center justify-center overflow-hidden ${
        competition
          ? `size-10 rounded-lg ring-1 ring-inset ring-white/10 ${showLogo ? "bg-white p-1.5" : "bg-brand/10 text-brand"}`
          : "size-6 rounded-md text-xs font-semibold text-muted-foreground"
      }`, className)}
    >
      {showLogo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-contain"
          onError={() => setFailedSrc(src)}
        />
      ) : competition || name === "Draw" ? (
        <HugeiconsIcon icon={competition ? ChampionIcon : EqualSignIcon} className={competition ? "size-6" : "size-5"} />
      ) : (
        name.split(/\s+/).slice(0, 2).map((word) => word[0]).join("")
      )}
    </span>
  )
}
