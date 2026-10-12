"use client"

import Link from "next/link"
import { useEffect, useMemo, useRef, useState } from "react"
import { useLiveMids } from "@/lib/useLiveMids"
import type {
  AllMids,
  EnrichedOutcome,
  EnrichedQuestion,
  OutcomeMeta,
} from "@/lib/types"
import { enrichMarkets } from "@/lib/hyperliquid"
import type { MatchResult } from "@/lib/wc-results"
import {
  bucketLabel,
  bucketThresholds,
  bucketTitle,
  catOfOutcome,
  catOfQuestion,
  marketDisplayName,
  marketPath,
  outcomeIndex,
  parseExpiry,
  parseMatchDate,
  parseRecurringDescription,
} from "@/lib/types"
import { TradePanel, fmtMult } from "./TradePanel"
import { StickySidebar } from "./StickySidebar"
import { FlagImg } from "./FlagImg"
import { CoinLogo } from "./CoinLogo"
import { SportsLogo } from "./SportsLogo"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  BankIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { Badge } from "@/components/ui/badge"
import { StatusPill } from "@/components/ui/status-pill"
import { Card } from "@/components/ui/card"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"

interface MarketsBrowserProps {
  meta: OutcomeMeta
  initialMids: AllMids
  wcResults?: MatchResult[]
}

const marketGrid = "grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] items-start gap-3"
const marketCard = "min-w-0 rounded-2xl bg-surface p-4 gap-3 ring-1 ring-foreground/10 transition-[background-color,box-shadow] duration-150 hover:bg-surface-2/50 hover:ring-foreground/20"
const marketHeader = "group flex min-h-11 items-center gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand"
const marketTitle = "line-clamp-2 min-w-0 text-base font-semibold leading-snug transition-colors group-hover:text-brand"
const marketButton = "inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-full border px-3 text-sm font-semibold tabular-nums transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
const oddsButton = `${marketButton} min-w-16 border-foreground/20 bg-foreground/5 font-mono text-foreground/85 hover:border-brand/60 hover:bg-brand/10 hover:text-brand aria-pressed:border-brand/60 aria-pressed:bg-brand/10 aria-pressed:text-brand`
const binaryButtons = [
  `${marketButton} w-full border-yes/30 bg-yes/5 text-yes hover:bg-yes/10 aria-pressed:border-yes aria-pressed:bg-yes/15`,
  `${marketButton} w-full border-no/30 bg-no/5 text-no hover:bg-no/10 aria-pressed:border-no aria-pressed:bg-no/15`,
]

function pct(mid: number | null | undefined): string {
  if (mid === null || mid === undefined || !Number.isFinite(mid)) return "—"
  const p = mid * 100
  if (p > 0 && p < 1) return "<1%"
  if (p > 99 && p < 100) return ">99%"
  return `${Math.round(p)}%`
}

function payout100(mid: number | null): string {
  if (mid === null || mid <= 0) return "—"
  return `$100 → $${Math.round(100 / mid).toLocaleString("en-US")}`
}

function abbr(name: string): string {
  return name.length <= 4 ? name.toUpperCase() : name.slice(0, 3).toUpperCase()
}

function cryptoTitle(o: EnrichedOutcome): string {
  return marketDisplayName(o.name, o.parsedMeta)
}

function Countdown({ expiry }: { expiry: string | undefined }) {
  const ts = parseExpiry(expiry)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  if (ts === null) return null
  const diff = ts - now
  if (diff <= 0) return <span className="text-muted-foreground">Ended</span>
  if (diff < 24 * 3600_000) {
    const h = Math.floor(diff / 3600_000)
    const m = Math.floor((diff % 3600_000) / 60_000)
    const s = Math.floor((diff % 60_000) / 1000)
    const pad = (n: number) => String(n).padStart(2, "0")
    return (
      // ponytail: seconds tick between SSR and hydration — mismatch is expected
      <span
        suppressHydrationWarning
        className="font-mono tabular-nums text-muted-foreground"
      >
        Ends in {pad(h)}:{pad(m)}:{pad(s)}
      </span>
    )
  }
  return (
    <span className="text-muted-foreground uppercase">
      {new Date(ts).toLocaleString("en-US", {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      })}{" "}
      UTC
    </span>
  )
}

type Sel = { id: number; side: 0 | 1 }

export function MarketsBrowser({
  meta,
  initialMids,
  wcResults = [],
}: MarketsBrowserProps) {
  const { mids } = useLiveMids(initialMids)
  const [sel, setSel] = useState<Sel | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const firstMids = useRef(initialMids)

  const enriched = useMemo(() => enrichMarkets(meta, mids), [meta, mids])

  const allOutcomes = useMemo(() => {
    const m = new Map<number, EnrichedOutcome>()
    for (const o of enriched.loose) m.set(o.outcome, o)
    for (const q of enriched.questions) {
      for (const o of q.outcomes) m.set(o.outcome, o)
      if (q.fallback) m.set(q.fallback.outcome, q.fallback)
    }
    return m
  }, [enriched])

  const matches = enriched.loose.filter((o) => catOfOutcome(o) === "sports")
  const binaries = enriched.loose.filter(
    (o) => o.parsedMeta?.class === "priceBinary",
  )
  // templated markets (touch/above/scalar) — no recurring parsedMeta, so
  // they'd otherwise fall through every bucket and never render. Underlyings
  // on HIP-3 builder perps ("xyz:SP500") are stocks/commodities → Finance.
  const cryptoOther = enriched.loose.filter(
    (o) =>
      catOfOutcome(o) === "crypto" && o.parsedMeta?.class !== "priceBinary",
  )
  const financeMarkets = cryptoOther.filter((o) =>
    o.templateArgs?.perp?.includes(":"),
  )
  const cryptoTargets = cryptoOther.filter(
    (o) => !o.templateArgs?.perp?.includes(":"),
  )
  const buckets = enriched.questions
    .map((q) => ({ q, qMeta: parseRecurringDescription(q.description) }))
    .filter((x) => x.qMeta?.class === "priceBucket")
  const sportsQs = enriched.questions.filter(
    (q) => catOfQuestion(q) === "sports",
  )
  const econQs = enriched.questions.filter(
    (q) => catOfQuestion(q) === "economics",
  )

  const selected: { o: EnrichedOutcome; side: 0 | 1 } | null = useMemo(() => {
    if (sel) {
      const o = allOutcomes.get(sel.id)
      if (o) return { o, side: sel.side }
    }
    const first = matches[0] ?? binaries[0] ?? enriched.loose[0] ?? null
    return first ? { o: first, side: 0 } : null
  }, [sel, allOutcomes, matches, binaries, enriched.loose])

  const pick = (id: number, side: 0 | 1) => {
    setSel({ id, side })
    // ponytail: below lg the side panel is hidden — trade in a bottom sheet instead
    if (window.innerWidth < 1024) setSheetOpen(true)
  }

  // Category filters change section visibility without refetching.
  const [cat, setCat] = useState<
    "all" | "sports" | "crypto" | "finance" | "economics"
  >("all")
  const show = (c: typeof cat) => cat === "all" || cat === c

  // 24h notional per market coin, from candles (no HIP-4 volume endpoint exists)
  const [vols, setVols] = useState<Record<string, number>>({})
  useEffect(() => {
    let dead = false
    const coins = enriched.loose
      .filter(
        (o) =>
          catOfOutcome(o) === "sports" ||
          (catOfOutcome(o) === "crypto" &&
            o.parsedMeta?.class !== "priceBinary"),
      )
      .map((o) => o.sides[0].coin)
    ;(async () => {
      const end = Date.now()
      const entries = await Promise.all(
        coins.map(async (coin) => {
          try {
            const res = await fetch("https://api.hyperliquid.xyz/info", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                type: "candleSnapshot",
                req: {
                  coin,
                  interval: "1h",
                  startTime: end - 24 * 3600_000,
                  endTime: end,
                },
              }),
              cache: "no-store",
            })
            const ks = (await res.json()) as { v: string }[]
            // contracts traded = USDC volume (each contract locks $1 across sides)
            return [
              coin,
              ks.reduce((acc, k) => acc + Number(k.v), 0),
            ] as const
          } catch {
            return [coin, 0] as const
          }
        }),
      )
      if (!dead) setVols(Object.fromEntries(entries))
    })()
    return () => {
      dead = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // biggest mid moves since page load, side 0 only
  const movers = useMemo(() => {
    const rows: {
      o: EnrichedOutcome
      mid: number
      delta: number
    }[] = []
    for (const o of allOutcomes.values()) {
      const s = o.sides[0]
      if (!s || s.mid === null) continue
      const prev = Number(firstMids.current[s.coin])
      const delta = Number.isFinite(prev) ? s.mid - prev : 0
      rows.push({ o, mid: s.mid, delta })
    }
    const moved = rows
      .filter((r) => Math.abs(r.delta) > 0.0005)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    if (moved.length >= 3) return moved.slice(0, 5)
    // ponytail: no price history endpoint — before anything moves this session, show top-probability markets instead
    return rows
      .filter(
        (r) =>
          r.mid > 0.02 &&
          r.mid < 0.985 &&
          !/fallback|recurring named/i.test(r.o.name),
      )
      .sort((a, b) => b.mid - a.mid)
      .slice(0, 5)
  }, [allOutcomes])

  return (
    <div className="space-y-6">
      <div className="grid lg:grid-cols-[1fr_360px] gap-6 items-start">
        <div className="space-y-8 min-w-0">
          <div className="flex gap-2 flex-wrap">
            {(
              [
                ["all", "All"],
                ["sports", "Sports"],
                ["crypto", "Crypto"],
                ["finance", "Finance"],
                ["economics", "Economics"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setCat(key)}
                className={`rounded-full border px-3.5 py-1.5 text-sm font-semibold transition ${
                  cat === key
                    ? "border-brand bg-brand/15 text-brand"
                    : "border-border bg-surface text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {show("sports") && (matches.length > 0 || sportsQs.length > 0) && (
            <section className="space-y-2">
              <div>
                <h2 className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
                  Sports
                  <StatusPill tone="blue">NEW</StatusPill>
                </h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Trade match results and tournament winners. Each market's
                  rules explain how its shares pay out.
                </p>
              </div>
              <div className={marketGrid}>
                {sportsQs.map((q) => (
                  <QuestionCard
                    key={q.question}
                    question={q}
                    selectedId={selected?.side === 0 ? selected.o.outcome : undefined}
                    onPick={pick}
                  />
                ))}
              </div>
              {groupMatches(matches).map(([label, ms]) => (
                <div key={label} className="space-y-3">
                  <h3 className="text-lg font-semibold">{label}</h3>
                  <div className={marketGrid}>
                    {ms.map((o) => {
                      const SportsCard = o.templateCategory
                        ? OutcomeCard
                        : MatchCard
                      return (
                        <SportsCard
                          key={o.outcome}
                          outcome={o}
                          selected={
                            selected?.o.outcome === o.outcome
                              ? selected.side
                              : null
                          }
                          onPick={pick}
                          vol={vols[o.sides[0].coin]}
                        />
                      )
                    })}
                  </div>
                </div>
              ))}
              {wcResults.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-lg font-semibold">World Cup results</h3>
                  <div className="grid gap-2 md:grid-cols-2">
                    {wcResults.slice(0, 4).map((r) => (
                      <ResultCard key={r.id} r={r} />
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          {show("crypto") && (binaries.length > 0 || buckets.length > 0) && (
            <section className="space-y-2">
              <div>
                <h2 className="text-xs uppercase tracking-wider text-muted-foreground">
                  Crypto dailies
                </h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Will the price close above the target? The multiplier is your
                  payout per $1 — DOWN 10x turns $10 into $100 if it closes
                  down.
                </p>
              </div>
              <div className={marketGrid}>
                {binaries.map((o) => (
                  <CryptoCard
                    key={o.outcome}
                    outcome={o}
                    selected={
                      selected?.o.outcome === o.outcome ? selected.side : null
                    }
                    onPick={pick}
                  />
                ))}
                {buckets.map(({ q, qMeta }) => (
                  <BucketCard
                    key={q.question}
                    question={q}
                    qMeta={qMeta!}
                    selectedId={selected?.side === 0 ? selected.o.outcome : undefined}
                    onPick={pick}
                  />
                ))}
              </div>
            </section>
          )}

          {show("crypto") && cryptoTargets.length > 0 && (
            <section className="space-y-2">
              <div>
                <h2 className="text-xs uppercase tracking-wider text-muted-foreground">
                  Crypto markets
                </h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Price targets and touch markets — every winning share pays
                  out $1 at settlement.
                </p>
              </div>
              <div className={marketGrid}>
                {cryptoTargets.map((o) => (
                  <OutcomeCard
                    key={o.outcome}
                    outcome={o}
                    selected={
                      selected?.o.outcome === o.outcome ? selected.side : null
                    }
                    onPick={pick}
                    vol={vols[o.sides[0].coin]}
                  />
                ))}
              </div>
            </section>
          )}

          {show("finance") && financeMarkets.length > 0 && (
            <section className="space-y-2">
              <div>
                <h2 className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
                  Finance
                  <StatusPill tone="blue">NEW</StatusPill>
                </h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Stocks, indices and commodities — will the price close above
                  the target?
                </p>
              </div>
              <div className={marketGrid}>
                {financeMarkets.map((o) => (
                  <OutcomeCard
                    key={o.outcome}
                    outcome={o}
                    selected={
                      selected?.o.outcome === o.outcome ? selected.side : null
                    }
                    onPick={pick}
                    vol={vols[o.sides[0].coin]}
                  />
                ))}
              </div>
            </section>
          )}

          {show("economics") && econQs.length > 0 && (
            <section className="space-y-2">
              <h2 className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
                Economics
                <StatusPill tone="blue">NEW</StatusPill>
              </h2>
              <div className={marketGrid}>
                {econQs.map((q) => (
                  <QuestionCard
                    key={q.question}
                    question={q}
                    selectedId={selected?.side === 0 ? selected.o.outcome : undefined}
                    onPick={pick}
                  />
                ))}
              </div>
            </section>
          )}
        </div>

        <StickySidebar className="hidden lg:flex lg:h-(--sidebar-height) flex-col gap-2 overflow-hidden p-px">
          {selected && (
            <div
              key={`${selected.o.outcome}-${selected.side}`}
              role="region"
              aria-label="Trade panel"
              tabIndex={0}
              className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain rounded-2xl p-px focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
            >
              <TradePanel
                outcome={selected.o}
                initialSide={selected.side}
                context={panelContext(selected.o, enriched.questions)}
                title={panelTitle(selected.o)}
              />
            </div>
          )}

          <Card className="min-h-0 h-[clamp(7rem,33.333%,18rem)] max-h-[50%] shrink-0 rounded-2xl bg-surface p-3 gap-3">
            <h3 id="top-movers-heading" className="shrink-0 text-sm font-semibold">Top movers</h3>
            <div
              role="region"
              aria-labelledby="top-movers-heading"
              tabIndex={0}
              className="min-h-0 overflow-y-auto overscroll-contain space-y-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
            >
              {movers.map(({ o, mid, delta }) => (
                <button
                  key={o.outcome}
                  type="button"
                  onClick={() => pick(o.outcome, 0)}
                  title={displayName(o)}
                  className="flex min-h-8 min-w-0 w-full items-center gap-2 text-left border-l-2 border-border pl-3 hover:border-brand transition"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{displayName(o)}</span>
                  <span className="shrink-0 font-mono text-sm tabular-nums">
                    {pct(mid)}
                  </span>
                  {Math.abs(delta) > 0.0005 && (
                    <span
                      className={`inline-flex shrink-0 items-center gap-0.5 font-mono text-xs tabular-nums ${delta > 0 ? "text-yes" : "text-no"}`}
                    >
                      <HugeiconsIcon
                        icon={delta > 0 ? ArrowUp01Icon : ArrowDown01Icon}
                        className="size-3"
                      />
                      {(Math.abs(delta) * 100).toFixed(1)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </Card>
        </StickySidebar>
      </div>

      <Drawer open={sheetOpen} onOpenChange={setSheetOpen} showSwipeHandle>
        <DrawerContent>
          <DrawerTitle className="sr-only">Order form</DrawerTitle>
          <div className="overflow-y-auto pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
            {selected && (
              <TradePanel
                key={`${selected.o.outcome}-${selected.side}`}
                outcome={selected.o}
                initialSide={selected.side}
                context={panelContext(selected.o, enriched.questions)}
                title={panelTitle(selected.o)}
                bare
              />
            )}
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  )
}

const matchDate = parseMatchDate

function ordinal(n: number): string {
  const v = n % 100
  if (v >= 11 && v <= 13) return `${n}th`
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`
}

function groupMatches(
  matches: EnrichedOutcome[],
): [string, EnrichedOutcome[]][] {
  const groups = new Map<string, { key: number; ms: EnrichedOutcome[] }>()
  for (const o of matches) {
    const d = matchDate(o.description, o.templateArgs?.scheduledStart)
    const label = d
      ? `${d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })}, ${ordinal(d.getUTCDate())} ${d.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" })}`
      : "Scheduled"
    const g = groups.get(label) ?? { key: d ? +d : Infinity, ms: [] }
    g.ms.push(o)
    groups.set(label, g)
  }
  return [...groups.entries()]
    .sort((a, b) => a[1].key - b[1].key)
    .map(([label, g]) => [label, g.ms])
}

function fmtVol(v: number): string {
  return v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v)}`
}

function displayName(o: EnrichedOutcome): string {
  if (o.parsedMeta?.class === "priceBinary") return cryptoTitle(o)
  return o.name
}

function panelTitle(o: EnrichedOutcome): string | undefined {
  if (o.parsedMeta?.class === "priceBinary") return cryptoTitle(o)
  return undefined
}

function panelContext(
  o: EnrichedOutcome,
  questions: EnrichedQuestion[],
): string | undefined {
  const parent = questions.find(
    (q) =>
      q.namedOutcomes.includes(o.outcome) || q.fallbackOutcome === o.outcome,
  )
  if (parent && parent.name !== "Recurring") return parent.name
  if (o.parsedMeta?.class) {
    const ts = parseExpiry(o.parsedMeta.expiry)
    if (ts !== null) {
      return `Expires ${new Date(ts).toLocaleString("en-US", {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "UTC",
      })} UTC`
    }
    return "Daily market"
  }
  return o.name
}

function MatchCard({
  outcome,
  selected,
  onPick,
  vol,
}: {
  outcome: EnrichedOutcome
  selected: 0 | 1 | null
  onPick: (id: number, side: 0 | 1) => void
  vol?: number
}) {
  const [a, b] = outcome.sideSpecs
  const stage = outcome.name.match(/Round of 16/i) ? "R16" : null
  const d = matchDate(outcome.description, outcome.templateArgs?.scheduledStart)
  return (
    <Card className="rounded-2xl bg-surface p-3 pt-3 gap-0 overflow-visible">
      {stage && (
        <div className="text-center mb-3">
          <Badge variant="secondary" className="text-muted-foreground">
            {stage}
          </Badge>
        </div>
      )}
      <Link
        href={marketPath(outcome)}
        className="grid grid-cols-[1fr_auto_1fr] items-start gap-2 group"
      >
        <div className="text-center min-w-0">
          <FlagImg name={a?.name} className="h-10 rounded-md" />
          <div className="text-sm font-semibold mt-2 truncate group-hover:text-brand transition">
            {a?.name}
          </div>
        </div>
        <div className="text-center pt-1">
          {d ? (
            <>
              <div className="text-xl font-bold">
                {d.getUTCDate()}{" "}
                {d
                  .toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })
                  .toUpperCase()}
              </div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide mt-0.5">
                {d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })}, UTC
              </div>
            </>
          ) : (
            <div className="text-xl font-bold text-muted-foreground">vs</div>
          )}
          {vol !== undefined && vol > 0 && (
            <div className="text-xs text-muted-foreground mt-1 font-heading tabular-nums">
              {fmtVol(vol)} Vol.
            </div>
          )}
        </div>
        <div className="text-center min-w-0">
          <FlagImg name={b?.name} className="h-10 rounded-md" />
          <div className="text-sm font-semibold mt-2 truncate group-hover:text-brand transition">
            {b?.name}
          </div>
        </div>
      </Link>
      <div className="mt-4 grid grid-cols-2 gap-3">
        {outcome.sides.map((s, idx) => {
          const name = outcome.sideSpecs[idx]?.name ?? ""
          const p = s.mid !== null ? Math.round(s.mid * 100) : null
          const active = selected === idx
          return (
            <button
              key={s.coin}
              type="button"
              onClick={() => onPick(outcome.outcome, idx as 0 | 1)}
              className={`rounded-full border px-4 py-3 text-sm font-semibold transition relative overflow-hidden ${
                active
                  ? "border-brand/60 bg-brand/5"
                  : "border-border bg-surface-2 hover:border-brand/30"
              }`}
            >
              <span>{abbr(name)}</span>{" "}
              <span className="text-muted-foreground font-mono tabular-nums">
                {p !== null ? `${p}%` : "—"}
              </span>
              <span
                className="absolute bottom-0 left-0 h-0.5 bg-brand transition-[width] duration-500"
                style={{ width: `${s.mid !== null ? s.mid * 100 : 0}%` }}
              />
            </button>
          )
        })}
      </div>
    </Card>
  )
}

function CryptoCard({
  outcome,
  selected,
  onPick,
}: {
  outcome: EnrichedOutcome
  selected: 0 | 1 | null
  onPick: (id: number, side: 0 | 1) => void
}) {
  const u = outcome.parsedMeta?.underlying ?? "?"
  const target = outcome.parsedMeta?.targetPrice
  return (
    <Card className={marketCard}>
      <Link
        href={marketPath(outcome)}
        className={marketHeader}
      >
        <CoinLogo u={u} />
        <div className="min-w-0">
          <h3 className={marketTitle}>
            {cryptoTitle(outcome)}
          </h3>
          {target && (
            <p className="text-xs text-muted-foreground font-heading">
              vs ${Number(target).toLocaleString("en-US")}
            </p>
          )}
        </div>
      </Link>
      <div className="grid grid-cols-2 gap-3">
        {outcome.sides.map((s, idx) => {
          const label = idx === 0 ? "UP" : "DOWN"
          const active = selected === idx
          return (
            <div key={s.coin} className="space-y-1.5">
              <button
                type="button"
                onClick={() => onPick(outcome.outcome, idx as 0 | 1)}
                aria-pressed={active}
                title={
                  s.mid !== null && s.mid > 0
                    ? `Payout multiplier — $1 pays $${(1 / s.mid).toFixed(2)} if ${label} wins`
                    : undefined
                }
                className={binaryButtons[idx]}
              >
                {label}{" "}
                <span className="font-mono font-normal">{fmtMult(s.mid)}</span>
              </button>
              <p className="text-center text-xs text-muted-foreground font-heading tabular-nums">
                {payout100(s.mid)}
              </p>
            </div>
          )
        })}
      </div>
      <div className="flex items-center justify-between text-xs mt-auto">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-no pulse-dot" />
          <span className="text-muted-foreground">Live</span>
        </span>
        <Countdown expiry={outcome.parsedMeta?.expiry} />
      </div>
    </Card>
  )
}

/** Generic two-sided card for templated markets, including sports. */
function OutcomeCard({
  outcome,
  selected,
  onPick,
  vol,
}: {
  outcome: EnrichedOutcome
  selected: 0 | 1 | null
  onPick: (id: number, side: 0 | 1) => void
  vol?: number
}) {
  const u = outcome.templateArgs?.perp ?? outcome.name.match(/^([A-Z0-9]{2,10})\b/)?.[1]
  const sports = catOfOutcome(outcome) === "sports"
  const yesNo = outcome.sides[0]?.sideName.toLowerCase() === "yes" &&
    outcome.sides[1]?.sideName.toLowerCase() === "no"
  const kickoff = parseExpiry(outcome.templateArgs?.scheduledStart)
  const href = marketPath(outcome)
  return (
    <Card className={marketCard}>
      <Link
        href={href}
        className={marketHeader}
        title={outcome.name}
      >
        {sports ? (
          <SportsLogo name={outcome.templateArgs?.competition ?? outcome.name} competition />
        ) : <CoinLogo u={u ?? ""} />}
        <h3 className={marketTitle}>
          {outcome.name.replace(/^xyz:/, "")}
        </h3>
      </Link>
      <div className={yesNo ? "grid grid-cols-2 gap-x-3 gap-y-2" : "space-y-2"}>
        {yesNo && (
          <div aria-hidden="true" className="col-span-2 flex h-1.5 overflow-hidden rounded-full bg-surface-2">
            {outcome.sides.every((s) => s.mid !== null && Number.isFinite(s.mid) && s.mid >= 0) &&
              outcome.sides.map((s, idx) => (
                <span
                  key={s.coin}
                  className={idx === 0 ? "bg-yes" : "bg-no"}
                  style={{ flex: s.mid ?? 0 }}
                />
              ))}
          </div>
        )}
        {outcome.sides.map((s, idx) => {
          const name = outcome.templateArgs?.[idx === 0 ? "participantA" : "participantB"] ?? s.sideName
          return (
            <div key={s.coin} className="flex items-center gap-3">
              {!yesNo && <Link
                href={`${href}?side=${idx}`}
                className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-md text-sm transition-colors hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                title={name}
              >
                {sports && <SportsLogo name={name} />}
                <span className="truncate">{name}</span>
              </Link>}
              <button
                type="button"
                onClick={() => onPick(outcome.outcome, idx as 0 | 1)}
                aria-label={`Trade ${name} at ${pct(s.mid)}`}
                aria-pressed={selected === idx}
                className={yesNo ? binaryButtons[idx] : oddsButton}
              >
                {yesNo && <span className="uppercase">{s.sideName}</span>}
                <span className={yesNo ? "font-mono font-normal" : undefined}>{pct(s.mid)}</span>
              </button>
            </div>
          )
        })}
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
        <span>{vol !== undefined && vol > 0 ? `${fmtVol(vol)} 24h vol.` : ""}</span>
        {kickoff !== null ? (
          <span>
            {new Date(kickoff).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
              timeZone: "UTC",
            })}{" "}UTC
          </span>
        ) : <Countdown expiry={outcome.templateArgs?.time} />}
      </div>
    </Card>
  )
}

function BucketCard({
  question,
  qMeta,
  selectedId,
  onPick,
}: {
  question: EnrichedQuestion
  qMeta: Record<string, string>
  selectedId?: number
  onPick: (id: number, side: 0 | 1) => void
}) {
  const u = qMeta.underlying ?? "?"
  const thresholds = bucketThresholds(qMeta)
  const title = bucketTitle(qMeta)
  // ponytail: bucket outcomes are ordered by their `index:` description field
  const ordered = [...question.outcomes].sort(
    (a, b) => outcomeIndex(a.description) - outcomeIndex(b.description),
  )
  return (
    <Card className={marketCard}>
      <Link
        href={
          ordered[0]
            ? marketPath(ordered[0], question)
            : `/crypto/q-${question.question}`
        }
        className={marketHeader}
      >
        <CoinLogo u={u} />
        <h3 className={marketTitle}>
          {title}
        </h3>
      </Link>
      <div className="space-y-2">
        {ordered.map((o, idx) => {
          const mid = o.sides[0]?.mid ?? null
          return (
            <div
              key={o.outcome}
              className="flex items-center gap-3"
            >
              <Link
                href={marketPath(o, question)}
                className="flex min-h-11 min-w-0 flex-1 items-center rounded-md text-sm tabular-nums transition-colors hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                {bucketLabel(thresholds, idx)}
              </Link>
              <button
                type="button"
                onClick={() => onPick(o.outcome, 0)}
                aria-label={`Trade ${bucketLabel(thresholds, idx)} at ${pct(mid)}`}
                aria-pressed={selectedId === o.outcome}
                className={oddsButton}
              >
                {pct(mid)}
              </button>
            </div>
          )
        })}
      </div>
      <div className="flex items-center justify-between text-xs mt-auto">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-no pulse-dot" />
          <span className="text-muted-foreground">Live</span>
        </span>
        <Countdown expiry={qMeta.expiry} />
      </div>
    </Card>
  )
}

// Same layout as MatchCard, but settled: winner highlighted, nothing clickable.
function ResultCard({ r }: { r: MatchResult }) {
  const [a, b] = r.teams
  const lost = (name: string) => r.winner !== null && r.winner !== name
  return (
    <Card className="rounded-2xl bg-surface p-3 pt-3 gap-0 overflow-visible">
      <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-2">
        {[a, b].map((name, i) => (
          <div
            key={name}
            className={`text-center min-w-0 ${i === 1 ? "order-last" : ""} ${lost(name) ? "opacity-50" : ""}`}
          >
            <FlagImg name={name} className="h-10 rounded-md" />
            <div className="text-sm font-semibold mt-2 truncate">{name}</div>
          </div>
        ))}
        <div className="text-center pt-1">
          <div className="text-xl font-bold text-muted-foreground">
            {r.score ?? "–"}
          </div>
          <div className="text-xs text-muted-foreground uppercase tracking-wide mt-0.5">
            Final
          </div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        {[a, b].map((name) => {
          const won = r.winner === name
          return (
            <div
              key={name}
              className={`rounded-xl border px-4 py-3 text-sm font-semibold text-center ${
                won
                  ? "border-brand/60 bg-brand/5"
                  : "border-border bg-surface-2 opacity-60"
              }`}
            >
              <span>{abbr(name)}</span>{" "}
              <span
                className={`font-mono ${won ? "text-brand" : "text-muted-foreground"}`}
              >
                {won ? (
                  <>
                    <HugeiconsIcon
                      icon={Tick02Icon}
                      className="size-3.5 inline align-[-0.15em]"
                    />{" "}
                    Won
                  </>
                ) : r.winner === null ? (
                  "Draw"
                ) : (
                  "Lost"
                )}
              </span>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function QuestionCard({
  question,
  selectedId,
  onPick,
}: {
  question: EnrichedQuestion
  selectedId?: number
  onPick: (id: number, side: 0 | 1) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const sorted = [...question.outcomes].sort(
    (a, b) => (b.sides[0]?.mid ?? 0) - (a.sides[0]?.mid ?? 0),
  )
  const shown = expanded ? sorted : sorted.slice(0, 3)
  const sports = catOfQuestion(question) === "sports"
  const competition = question.templateArgs?.competition ?? question.name
  const href = sorted[0]
    ? marketPath(sorted[0], question)
    : `/${catOfQuestion(question)}/q-${question.question}`
  const rowsId = `question-outcomes-${question.question}`
  return (
    <Card className={marketCard}>
      <Link
        href={href}
        title={question.name}
        className={marketHeader}
      >
        {sports ? <SportsLogo name={competition} competition /> : (
          <HugeiconsIcon icon={BankIcon} aria-hidden="true" className="size-10 shrink-0 rounded-lg bg-brand/10 p-2.5 text-brand" />
        )}
        <h3 className={marketTitle}>
          {question.name}
        </h3>
      </Link>
      <div id={rowsId} className="space-y-2">
        {shown.map((o) => (
          <div key={o.outcome} className="flex items-center gap-3">
            <Link
              href={marketPath(o, question)}
              title={o.name}
              className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-md text-sm transition-colors hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              {sports && <SportsLogo name={o.name} />}
              <span className="truncate">{o.name}</span>
            </Link>
            <button
              type="button"
              onClick={() => onPick(o.outcome, 0)}
              aria-label={`Trade ${o.name} at ${pct(o.sides[0]?.mid)}`}
              aria-pressed={selectedId === o.outcome}
              className={oddsButton}
            >
              {pct(o.sides[0]?.mid)}
            </button>
          </div>
        ))}
      </div>
      <div className="mt-auto flex min-h-9 items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{sorted.length} outcomes</span>
        {sorted.length > 3 ? (
          <button
            type="button"
            className="-my-1 -mr-2 inline-flex min-h-11 items-center gap-1 rounded-lg px-2 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            aria-controls={rowsId}
          >
            {expanded ? "Show less" : `Show ${sorted.length - 3} more`}
            <HugeiconsIcon icon={ArrowDown01Icon} className={`size-3.5 ${expanded ? "rotate-180" : ""}`} />
          </button>
        ) : (
          <Link href={href} className="-my-1 -mr-2 inline-flex min-h-11 items-center rounded-lg px-2 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
            View market
          </Link>
        )}
      </div>
    </Card>
  )
}
