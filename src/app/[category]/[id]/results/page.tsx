import Link from "next/link"
import { notFound } from "next/navigation"
import { Card } from "@/components/ui/card"
import { DayChart } from "@/components/DayChart"
import { CoinLogo } from "@/components/CoinLogo"
import { getCloses, getSettleHistory } from "@/lib/hyperliquid"
import { cachedOutcomeMeta } from "@/lib/hl-cached"
import {
  dailyResults,
  marketDisplayName,
  marketPath,
  parseRecurringDescription,
} from "@/lib/types"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp02Icon,
} from "@hugeicons/core-free-icons"

export const dynamic = "force-dynamic"
export const revalidate = 0

interface PageProps {
  params: Promise<{ category: string; id: string }>
  searchParams: Promise<{ d?: string }>
}

/** "o-123-btc-up-or-down" or legacy "123-slug" → outcome 123. */
function parseId(id: string): number | null {
  const m = id.match(/^(?:o-)?(\d+)(-.*)?$/)
  return m ? parseInt(m[1], 10) : null
}

/** settle time (epoch ms, UTC) → "20260628" day key used in ?d= */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "")
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params
  const outcomeId = parseId(id)
  if (outcomeId === null) return {}
  const meta = await cachedOutcomeMeta().catch(() => null)
  const raw = meta?.outcomes.find((o) => o.outcome === outcomeId)
  if (!raw) return {}
  const title = marketDisplayName(
    raw.name,
    parseRecurringDescription(raw.description),
  )
  return { title: `${title} — Past Results | Speculate` }
}

export default async function ResultsPage({ params, searchParams }: PageProps) {
  const { id } = await params
  const { d } = await searchParams
  const outcomeId = parseId(id)
  if (outcomeId === null || outcomeId <= 0) notFound()

  const meta = await cachedOutcomeMeta()
  const outcome = meta.outcomes.find((o) => o.outcome === outcomeId)
  if (!outcome) notFound()
  const pm = parseRecurringDescription(outcome.description)
  // ponytail: results only derivable for recurring price markets — outcome coins
  // wipe candle history at every roll, so other market types have no data source
  if (pm?.class !== "priceBinary" || !pm.underlying || !pm.expiry) notFound()

  const title = marketDisplayName(outcome.name, pm)
  const livePath = marketPath({ ...outcome, parsedMeta: pm })
  const settles = await getSettleHistory(pm.underlying, pm.expiry, 30, {
    cache: "no-store",
  })
  const rows = dailyResults(settles) // newest first

  const selected = rows.find((r) => dayKey(r.time) === d) ?? rows[0]

  // 24h of underlying leading into the settle, for the day's chart
  const closes = selected
    ? await getCloses(
        pm.underlying,
        "15m",
        selected.time - 24 * 3600_000,
        selected.time,
        { cache: "no-store" },
      ).catch(() => [])
    : []

  const fmtDay = (ms: number) =>
    new Date(ms).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    })
  const fmtFull = (ms: number) =>
    `${new Date(ms).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    })} UTC`
  const fmtPx = (n: number) => `$${n.toLocaleString("en-US")}`

  return (
    <div className="space-y-2">
      <Link
        href={livePath}
        className="text-xs text-muted-foreground hover:text-foreground transition inline-flex items-center gap-1"
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} className="size-3.5" />
        {title}
      </Link>

      <Card className="rounded-2xl bg-surface p-3">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <CoinLogo u={pm.underlying} className="size-11" />
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-semibold tracking-tight truncate">
                {title}
              </h1>
              <div className="text-xs text-muted-foreground mt-1">
                {selected ? fmtFull(selected.time) : "Past results"}
              </div>
            </div>
          </div>
          {selected && (
            <div className="text-right">
              <div className="text-xs text-muted-foreground">Outcome</div>
              <span
                className={`inline-block mt-1 rounded-md px-2 py-0.5 text-xs font-bold uppercase ${
                  selected.up ? "bg-yes/15 text-yes" : "bg-no/15 text-no"
                }`}
              >
                {selected.up ? "Up" : "Down"}
              </span>
            </div>
          )}
        </div>
      </Card>

      {/* same container as the live chart (CryptoStats): card chrome is sm+
          only, so on mobile the plot runs edge-to-edge. Not <Card> — its
          overflow-hidden clips the full-bleed plot. */}
      <div className="flex flex-col gap-2 sm:rounded-2xl sm:border sm:border-border sm:bg-surface sm:p-3">
        {!selected ? (
          <p className="text-sm text-muted-foreground">
            No settle history available.
          </p>
        ) : (
          <>
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="flex gap-8">
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">
                    Price to beat
                  </div>
                  <div className="text-xl font-semibold font-heading tabular-nums mt-0.5">
                    {fmtPx(selected.prior)}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">
                    Final price
                  </div>
                  <div className="text-xl font-semibold font-heading tabular-nums mt-0.5 flex items-baseline gap-2">
                    <span className="text-amber-400">
                      {fmtPx(selected.price)}
                    </span>
                    <span
                      className={`text-xs ${selected.up ? "text-yes" : "text-no"}`}
                    >
                      {selected.up ? "↑" : "↓"}$
                      {Math.abs(selected.price - selected.prior).toLocaleString(
                        "en-US",
                        { maximumFractionDigits: 0 },
                      )}
                    </span>
                  </div>
                </div>
              </div>
              <Link
                href={livePath}
                className="rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5 hover:border-brand/40 transition"
              >
                Go to <span className="text-no">●</span> Live
                <HugeiconsIcon icon={ArrowRight01Icon} className="size-3.5" />
              </Link>
            </div>

            {closes.length > 1 ? (
              <div className="-mx-3 sm:-mx-2">
                <DayChart
                  closes={closes}
                  target={selected.prior}
                  coin={pm.underlying}
                />
              </div>
            ) : (
              <div className="h-[220px] flex items-center justify-center text-xs text-muted-foreground">
                No chart data for this day.
              </div>
            )}

            <div className="flex items-center gap-2">
              <details className="relative group">
                <summary className="cursor-pointer list-none rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1 hover:border-brand/40 transition">
                  Past
                  <HugeiconsIcon
                    icon={ArrowDown01Icon}
                    className="size-3.5 transition group-open:rotate-180"
                  />
                </summary>
                <div className="absolute bottom-full left-0 mb-2 w-44 rounded-xl border border-border bg-surface-2 p-1.5 shadow-lg z-10">
                  {rows.slice(0, 7).map((r) => (
                    <Link
                      key={r.time}
                      href={`?d=${dayKey(r.time)}`}
                      className={`flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface transition ${
                        r.time === selected.time ? "bg-surface" : ""
                      }`}
                    >
                      <ResultArrow up={r.up} />
                      <span className="text-sm">{fmtDay(r.time)}</span>
                    </Link>
                  ))}
                </div>
              </details>
              {/* last 4 settled days, newest rightmost */}
              {rows
                .slice(0, 4)
                .reverse()
                .map((r) => (
                  <Link
                    key={r.time}
                    href={`?d=${dayKey(r.time)}`}
                    title={fmtDay(r.time)}
                    className={
                      r.time === selected.time
                        ? "ring-2 ring-brand/50 rounded-md"
                        : ""
                    }
                  >
                    <ResultArrow up={r.up} />
                  </Link>
                ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ResultArrow({ up }: { up: boolean }) {
  return (
    <span
      className={`size-7 rounded-md border flex items-center justify-center ${
        up
          ? "border-yes/30 bg-yes/10 text-yes"
          : "border-no/30 bg-no/10 text-no"
      }`}
    >
      <HugeiconsIcon
        icon={up ? ArrowUp02Icon : ArrowDown02Icon}
        className="size-4"
      />
    </span>
  )
}
