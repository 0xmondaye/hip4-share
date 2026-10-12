"use client"

import { useEffect } from "react"
import { cardGrade, cardYear } from "@/lib/gacha-core"

// Grade descriptor for the row's right-edge annotation ("PSA 10 · GEM MINT").
// Unknown grades skip it.
const GRADE_DESC: Record<string, string> = { "10": "Gem Mint", "9.5": "Gem Mint", "9": "Mint" }

// Seamless-tiling rainbow (start hue == end hue) for the top tier's shimmer sweep.
const RAINBOW =
  "linear-gradient(90deg, #ff5f6d, #ffc25f, #f7f75f, #5fe38f, #5fc9ff, #b45fff, #ff5f6d)"

// Per-row stagger + post-last-row hold, seconds. The fade-out delay and the
// onDone timeout below are both derived from these — one place to tune.
//
// 0.9s/row read as a slideshow, not a cascade: four rows plus the hold put 5.5s
// of unskippable theater between the user and the card they just paid for,
// every single pull. 0.45 still lands each row distinctly and halves the wait.
const STAGGER = 0.45
const HOLD = 0.8
const FADE = 0.5

/** One slab row: small tracking label left, huge value, optional right-edge
 *  annotation, hairline. */
function Row({
  label,
  value,
  right,
  delay,
  valueStyle,
  valueClassName,
}: {
  label: string
  value: string
  right?: string | null
  delay: number
  valueStyle?: React.CSSProperties
  valueClassName?: string
}) {
  return (
    <div
      className="grade-line flex w-full flex-col gap-2 border-b border-border pb-5"
      style={{ animationDelay: `${delay}s` }}
    >
      <div className="flex items-baseline justify-between gap-4 text-[11px] font-medium uppercase tracking-[0.34em] text-muted-foreground">
        <span>{label}</span>
        {right && <span className="shrink-0">{right}</span>}
      </div>
      <span
        className={`font-heading text-[clamp(1.75rem,8vw,3.25rem)] uppercase leading-none [overflow-wrap:anywhere] [text-shadow:0_0_32px_rgba(255,255,255,0.25)] ${valueClassName ?? ""}`}
        style={valueStyle}
      >
        {value}
      </span>
    </div>
  )
}

/**
 * Slab-sheet grading reveal (cac's `stats` beat): ledger rows stamp in one by
 * one — YEAR → CATEGORY → GRADE ("GEM MINT" annotated) → RARITY in the tier's
 * glow — then the sheet fades and `onDone` hands off to the card pull. Rows
 * render only when parsed, so a truncated name just collapses a row out.
 */
export function GradingReveal({
  name,
  category,
  rarity,
  tier,
  glow,
  onDone,
}: {
  name: string
  category: string | null
  rarity: string
  tier: number
  glow: string
  onDone: () => void
}) {
  const year = cardYear(name)
  const grade = cardGrade(name)
  const rows: {
    label: string
    value: string
    right?: string | null
    valueStyle?: React.CSSProperties
    valueClassName?: string
  }[] = [
    ...(year ? [{ label: "Year", value: year }] : []),
    ...(category ? [{ label: "Category", value: category }] : []),
    ...(grade
      ? [{ label: "Grade", value: grade, right: GRADE_DESC[grade.match(/[\d.]+/)?.[0] ?? ""] }]
      : []),
    {
      // Shimmer sweep in the tier's own color (top tier: the full rainbow) —
      // gradient-clipped text. Glow via drop-shadow: text-shadow would bleed
      // through the transparent gradient fill.
      label: "Rarity",
      value: rarity,
      valueClassName: "rarity-shimmer",
      valueStyle: {
        backgroundImage:
          tier >= 5 ? RAINBOW : `linear-gradient(90deg, ${glow}, #fff 50%, ${glow})`,
        textShadow: "none",
        filter: `drop-shadow(0 0 18px ${glow})`,
      },
    },
  ]

  const outDelay = rows.length * STAGGER + HOLD
  useEffect(() => {
    const t = setTimeout(onDone, (outDelay + FADE) * 1000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      className="grade-reveal absolute inset-0 z-20 flex justify-center px-8 text-left"
      style={{ animationDelay: `${outDelay}s`, animationDuration: `${FADE}s` }}
    >
      {/* Skippable: slow where the user is deciding, instant where they're
          waiting. Full-bleed and behind the rows, so the whole sheet is the
          target without stealing the rows' own text selection. */}
      <button
        type="button"
        onClick={onDone}
        aria-label="Skip to the card"
        className="absolute inset-0 z-0 cursor-default"
      />
      {/* left-justified WITHIN a centered max-w column — on wide screens the
          rows don't hug the viewport edge */}
      <div className="pointer-events-none relative z-10 flex w-full max-w-xl flex-col justify-center gap-7">
        {rows.map((r, i) => (
          <Row key={r.label} {...r} delay={i * STAGGER + 0.05} />
        ))}
      </div>
    </div>
  )
}
