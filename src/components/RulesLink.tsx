"use client"

import { useEffect } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { InformationCircleIcon } from "@hugeicons/core-free-icons"

const open = () => document.getElementById("rules")?.setAttribute("open", "")

/** Scrolls to the #rules dropdown and pops it open — deep links included. */
export function RulesLink() {
  useEffect(() => {
    if (window.location.hash === "#rules") open()
  }, [])
  return (
    <a
      href="#rules"
      onClick={open}
      className="inline-flex items-center gap-1 hover:text-foreground transition"
    >
      <HugeiconsIcon icon={InformationCircleIcon} className="size-3.5" />
      Rules
    </a>
  )
}
