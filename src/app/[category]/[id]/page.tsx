import Link from "next/link"
import { notFound, permanentRedirect } from "next/navigation"
import { cache } from "react"
import { CryptoStats } from "@/components/CryptoStats"
import { EventOutcomes } from "@/components/EventOutcomes"
import { LiveChance } from "@/components/LiveChance"
import { MarketTabs } from "@/components/MarketTabs"
import { MatchStats } from "@/components/MatchStats"
import { OutcomeChart } from "@/components/OutcomeChart"
import { MobileTradeBar } from "@/components/MobileTradeBar"
import { OrderBook } from "@/components/OrderBook"
import { TradePanel } from "@/components/TradePanel"
import { StickySidebar } from "@/components/StickySidebar"
import { SportsLogo } from "@/components/SportsLogo"
import {
  enrichMarkets,
  getL2Book,
  getSettleHistory,
  getVolume24h,
} from "@/lib/hyperliquid"
import { cachedAllMids, cachedOutcomeMeta } from "@/lib/hl-cached"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
} from "@hugeicons/core-free-icons"
import { TelegramLogo } from "@/components/TelegramLogo"
import { RulesLink } from "@/components/RulesLink"
import {
  bucketLabel,
  bucketThresholds,
  bucketTitle,
  coinFor,
  dailyResults,
  marketDisplayName,
  marketPath,
  parseExpiry,
  parseMatchDate,
  parseRecurringDescription,
  outcomeIndex,
} from "@/lib/types"
import { flagCode } from "@/lib/flags"
import { FlagImg } from "@/components/FlagImg"
import { CoinLogo, logoColor } from "@/components/CoinLogo"
import { Card } from "@/components/ui/card"

export const dynamic = "force-dynamic"
export const revalidate = 0

interface PageProps {
  params: Promise<{ category: string; id: string }>
  searchParams: Promise<{ side?: string; outcome?: string }>
}

// dedupe the meta fetch between generateMetadata and the page render
const getMeta = cache(() => cachedOutcomeMeta())

/** "q-32-slug" → question 32; "o-189-slug" or legacy "189-slug" → outcome 189. */
function parseSeg(seg: string): { kind: "q" | "o"; id: number } | null {
  const m = seg.match(/^(?:(q|o)-)?(\d+)(-.*)?$/)
  if (!m) return null
  return { kind: m[1] === "q" ? "q" : "o", id: parseInt(m[2], 10) }
}

export async function generateMetadata({ params, searchParams }: PageProps) {
  const { id } = await params
  const seg = parseSeg(id)
  if (seg === null) return {}
  const meta = await getMeta().catch(() => null)
  let outcomeId = seg.id
  if (seg.kind === "q") {
    const q = meta?.questions.find((x) => x.question === seg.id)
    if (!q || q.namedOutcomes.length === 0) return {}
    const want = Number((await searchParams).outcome)
    if (!q.namedOutcomes.includes(want)) {
      // no outcome selected — title the question itself
      const qm = parseRecurringDescription(q.description)
      const title = qm?.class === "priceBucket" ? bucketTitle(qm) : q.name
      return {
        title: `${title} | Speculate`,
        description: qm ? title : q.description.slice(0, 160),
      }
    }
    outcomeId = want
  }
  const raw = meta?.outcomes.find((o) => o.outcome === outcomeId)
  if (!raw) return {}
  const pm = parseRecurringDescription(raw.description)
  const q = meta?.questions.find(
    (q) =>
      q.namedOutcomes.includes(outcomeId) || q.fallbackOutcome === outcomeId,
  )
  const qm = q ? parseRecurringDescription(q.description) : null
  const title =
    qm?.class === "priceBucket"
      ? `${bucketTitle(qm)}: ${bucketLabel(bucketThresholds(qm), outcomeIndex(raw.description))}`
      : marketDisplayName(raw.name, pm)
  return {
    title: `${title} | Speculate`,
    // structured recurring descriptors read as key:value soup — use the title instead
    description: pm ? title : raw.description.slice(0, 160),
  }
}

function fmtExpiry(expiry: string | undefined): string | null {
  const ts = parseExpiry(expiry)
  if (ts === null) return null
  return `${new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  })} UTC`
}

export default async function MarketPage({ params, searchParams }: PageProps) {
  const { category, id } = await params
  const sp = await searchParams
  const seg = parseSeg(id)
  const initialSide = sp.side === "1" ? 1 : 0
  if (seg === null || seg.id <= 0) notFound()

  const [meta, mids] = await Promise.all([getMeta(), cachedAllMids()])

  const enriched = enrichMarkets(meta, mids)

  let outcomeId = seg.id
  if (seg.kind === "q") {
    const q = enriched.questions.find((x) => x.question === seg.id)
    if (!q || q.outcomes.length === 0) notFound()
    const want = Number(sp.outcome)
    const hit = q.outcomes.find((o) => o.outcome === want)
    // default: top-probability outcome, matching the event list's ordering
    outcomeId = (
      hit ??
      [...q.outcomes].sort(
        (a, b) => (b.sides[0]?.mid ?? -1) - (a.sides[0]?.mid ?? -1),
      )[0]
    ).outcome
  }

  const outcome =
    [...enriched.questions.flatMap((q) => q.outcomes), ...enriched.loose].find(
      (o) => o.outcome === outcomeId,
    ) ??
    (() => {
      const raw = meta.outcomes.find((o) => o.outcome === outcomeId)
      if (!raw) return undefined
      return {
        ...raw,
        parsedMeta: parseRecurringDescription(raw.description),
        sides: raw.sideSpecs.map((s, idx) => ({
          outcomeId,
          sideIdx: idx,
          sideName: s.name,
          coin: coinFor(outcomeId, idx),
          mid: mids[coinFor(outcomeId, idx)]
            ? Number(mids[coinFor(outcomeId, idx)])
            : null,
        })),
      }
    })()
  if (!outcome) notFound()

  const parentQuestion =
    enriched.questions.find(
      (q) =>
        q.namedOutcomes.includes(outcomeId) || q.fallbackOutcome === outcomeId,
    ) ?? null

  // recurring bucket outcomes carry placeholder names ("Recurring Named
  // Outcome", desc "index:N") — real labels come from the question description
  const qMeta = parentQuestion
    ? parseRecurringDescription(parentQuestion.description)
    : null
  const isBucket = qMeta?.class === "priceBucket"
  const thresholds = bucketThresholds(qMeta)

  // canonicalize: legacy /market/123, o-form with a parent question, stale slug
  // or category → 308 to /{cat}/q-{qid}-{slug}?outcome={oid}
  const canonical = marketPath(outcome, parentQuestion)
  const [canonPath, canonQuery] = canonical.split("?")
  if (`/${category}/${decodeURIComponent(id)}` !== canonPath) {
    const qs = new URLSearchParams(canonQuery)
    if (sp.side === "1") qs.set("side", "1")
    permanentRedirect(qs.size ? `${canonPath}?${qs}` : canonPath)
  }

  const pm = outcome.parsedMeta
  const isCrypto = pm?.class === "priceBinary"

  const [initialBook, volume24h, settles] = await Promise.all([
    getL2Book(outcome.sides[0].coin, { cache: "no-store" }).catch(() => null),
    getVolume24h(outcome.sides[0].coin, { cache: "no-store" }),
    isCrypto && pm?.underlying && pm?.expiry
      ? getSettleHistory(pm.underlying, pm.expiry, 10, {
          cache: "no-store",
        }).catch(() => [])
      : Promise.resolve([]),
  ])
  const isTeamMarket =
    outcome.sides.length === 2 &&
    (outcome.sideSpecs[0]?.name ?? "Yes") !== "Yes"
  const title = isBucket
    ? bucketLabel(thresholds, outcomeIndex(outcome.description))
    : marketDisplayName(outcome.name, pm)
  const yesMid = outcome.sides[0]?.mid ?? null
  // floor so a 99.97% market reads 99%, not a settled-looking 100%
  const chance = yesMid !== null ? Math.floor(yesMid * 100) : null
  const sideName0 = outcome.sideSpecs[0]?.name ?? ""
  const flagName = flagCode(sideName0)
    ? sideName0
    : flagCode(outcome.name)
      ? outcome.name
      : null
  const expiryLabel = fmtExpiry(
    pm?.expiry ??
      qMeta?.expiry ??
      outcome.templateArgs?.time ??
      outcome.templateArgs?.scheduledStart ??
      parentQuestion?.templateArgs?.scheduledStart ??
      parentQuestion?.templateArgs?.scheduledDecision,
  )

  const siblings = (parentQuestion?.outcomes ?? [])
    .filter((o) => o.outcome !== outcomeId)
    .map((o) => ({
      id: o.outcome,
      name: o.name,
      pct:
        o.sides[0]?.mid !== null && o.sides[0]?.mid !== undefined
          ? `${Math.round(o.sides[0].mid * 100)}%`
          : "—",
      href: marketPath(o, parentQuestion),
    }))

  // multi-outcome question ("2026 World Cup Champion") → event layout:
  // question title, outcome chart, outcomes panel; URL stays per-outcome
  const isEvent = (parentQuestion?.outcomes.length ?? 0) > 1
  const nameFor = (o: { name: string; description: string }) =>
    isBucket ? bucketLabel(thresholds, outcomeIndex(o.description)) : o.name
  const eventSorted = isEvent
    ? [...parentQuestion!.outcomes].sort((a, b) =>
        isBucket
          ? outcomeIndex(a.description) - outcomeIndex(b.description)
          : (b.sides[0]?.mid ?? -1) - (a.sides[0]?.mid ?? -1),
      )
    : []
  const eventRows = eventSorted.map((o) => ({
    id: o.outcome,
    name: nameFor(o),
    coin: o.sides[0].coin,
    href: marketPath(o, parentQuestion),
  }))
  const chartSeries = eventSorted.slice(0, 4).map((o) => ({
    name: nameFor(o),
    coin: o.sides[0].coin,
    mid: o.sides[0]?.mid ?? null,
  }))

  // every coin belonging to this market (all outcomes on event pages) so the
  // tabs can filter account-wide positions/orders/fills down to this page
  const tabCoins = (
    isEvent && parentQuestion ? parentQuestion.outcomes : [outcome]
  ).flatMap((o) =>
    o.sides.map((s) => ({
      coin: s.coin,
      label: isEvent ? `${nameFor(o)} — ${s.sideName}` : s.sideName,
    })),
  )

  return (
    // ponytail: pb clears the fixed MobileTradeBar stacked on the BottomNav pill
    <div className="space-y-2 pb-36 lg:pb-0">
      <Link
        href="/"
        className="text-xs text-muted-foreground hover:text-foreground transition inline-flex items-center gap-1"
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} className="size-3.5" />
        All markets
      </Link>

      <div className="grid lg:grid-cols-[1fr_340px] gap-2 items-start">
        <div className="space-y-2 min-w-0">
          <Card className="rounded-2xl bg-surface p-3">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-3 min-w-0">
                {category === "sports" ? (
                  <SportsLogo
                    name={parentQuestion?.templateArgs?.competition ?? outcome.templateArgs?.competition ?? parentQuestion?.name ?? outcome.name}
                    competition
                    className="size-11"
                  />
                ) : flagName ? (
                  <div className="size-11 shrink-0 rounded-full bg-surface-2 border border-border flex items-center justify-center overflow-hidden">
                    <FlagImg name={flagName} className="h-7 rounded-sm" />
                  </div>
                ) : (
                  <CoinLogo
                    u={
                      pm?.underlying ??
                      qMeta?.underlying ??
                      outcome.templateArgs?.perp ??
                      ""
                    }
                    className="size-11"
                  />
                )}
                <div className="min-w-0">
                  <h1 className="text-lg sm:text-2xl font-semibold tracking-tight truncate">
                    {isEvent
                      ? isBucket
                        ? bucketTitle(qMeta)
                        : parentQuestion!.name
                      : title}
                  </h1>
                  {/* ponytail: nowrap children so the row breaks between items, never inside one */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground mt-1 [&>*]:whitespace-nowrap">
                    <RulesLink />
                    {isCrypto && (
                      <Link
                        href={`${canonPath}/results`}
                        className="hover:text-foreground transition"
                      >
                        Past results
                      </Link>
                    )}
                    {expiryLabel && (
                      // ponytail: crypto pages repeat the expiry as a live countdown below
                      <span
                        className={isCrypto ? "hidden sm:inline" : undefined}
                      >
                        {expiryLabel}
                      </span>
                    )}
                    {parentQuestion && !expiryLabel && (
                      <span>{parentQuestion.name}</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4 w-full border-t border-border pt-2 sm:flex sm:items-start sm:gap-8 sm:w-auto sm:shrink-0 sm:border-0 sm:pt-0 sm:text-right">
                <div>
                  <div className="text-xs text-muted-foreground">Volume</div>
                  <div className="text-lg font-normal font-heading tabular-nums mt-0.5">
                    {volume24h !== null
                      ? `$${Math.round(volume24h).toLocaleString("en-US")}`
                      : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">
                    {chance !== null
                      ? `${isEvent ? nameFor(outcome) : (outcome.sideSpecs[0]?.name ?? "Yes")} chance`
                      : "Open interest"}
                  </div>
                  <div className="text-lg font-normal font-heading tabular-nums mt-0.5">
                    {/* ponytail: no HIP-4 open-interest endpoint — show side-0 chance instead */}
                    {chance !== null && outcome.sides[0] ? (
                      <LiveChance coin={outcome.sides[0].coin} initial={yesMid} />
                    ) : (
                      "—"
                    )}
                  </div>
                </div>
              </div>
            </div>
          </Card>

          <div
            className={`grid gap-2 ${isEvent ? "xl:grid-cols-[1fr_320px_300px]" : "xl:grid-cols-[1fr_320px]"}`}
          >
            {isEvent ? (
              <OutcomeChart series={chartSeries} />
            ) : isCrypto && pm?.underlying && pm?.targetPrice ? (
              <CryptoStats
                underlying={pm.underlying}
                target={Number(pm.targetPrice)}
                expiry={pm.expiry}
                coin={outcome.sides[0].coin}
                chance={yesMid}
                results={dailyResults(settles).map((r) => ({
                  time: r.time,
                  up: r.up,
                }))}
                resultsHref={`${canonPath}/results`}
              />
            ) : isTeamMarket ? (
              <MatchStats
                coins={[outcome.sides[0].coin, outcome.sides[1].coin]}
                names={[
                  outcome.templateArgs?.participantA ?? outcome.sideSpecs[0]?.name ?? "",
                  outcome.templateArgs?.participantB ?? outcome.sideSpecs[1]?.name ?? "",
                ]}
                initialMids={[
                  outcome.sides[0]?.mid ?? null,
                  outcome.sides[1]?.mid ?? null,
                ]}
                kickoffMs={
                  parseMatchDate(
                    outcome.description,
                    outcome.templateArgs?.scheduledStart,
                  )?.getTime() ?? null
                }
              />
            ) : (
              // standalone templated markets (touch / above-target) — chance
              // history of the primary side; rules live in the sidebar panel
              <OutcomeChart
                series={[
                  {
                    name: "Chance",
                    coin: outcome.sides[0].coin,
                    mid: yesMid,
                    color: logoColor(outcome.templateArgs?.perp),
                  },
                ]}
              />
            )}
            <OrderBook
              coin={outcome.sides[0].coin}
              sideLabel={outcome.sideSpecs[0]?.name ?? "Yes"}
              initial={initialBook}
            />
            {isEvent && (
              <EventOutcomes
                rows={eventRows}
                selectedId={outcomeId}
                initialMids={mids}
                keepOrder={isBucket}
                sports={category === "sports"}
              />
            )}
          </div>

          {/* outcomes panel replaces the Outcomes tab on event pages */}
          <MarketTabs siblings={isEvent ? [] : siblings} coins={tabCoins} />
        </div>

        <StickySidebar className="space-y-2 lg:overflow-y-auto lg:overscroll-contain lg:p-px">
          <div className="hidden lg:block">
            <TradePanel
              outcome={outcome}
              question={parentQuestion}
              initialSide={initialSide as 0 | 1}
              context={
                isBucket
                  ? bucketTitle(qMeta)
                  : (parentQuestion?.name ?? expiryLabel ?? undefined)
              }
              title={title}
            />
          </div>
          <MobileTradeBar
            outcome={outcome}
            question={parentQuestion}
            initialSide={initialSide as 0 | 1}
            context={
              isBucket
                ? bucketTitle(qMeta)
                : (parentQuestion?.name ?? expiryLabel ?? undefined)
            }
            title={title}
          />
          <details
            id="rules"
            className="rounded-2xl border border-border bg-surface px-5 py-4 text-sm group scroll-mt-20"
          >
            <summary className="cursor-pointer list-none flex items-center justify-between font-semibold">
              Market Rules
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                className="size-4 text-muted-foreground transition group-open:rotate-180"
              />
            </summary>
            <div className="mt-3 space-y-2 text-xs text-muted-foreground leading-relaxed">
              {isCrypto || isBucket ? (
                <dl className="grid grid-cols-2 gap-2">
                  {Object.entries(pm ?? qMeta ?? {}).map(([k, v]) => (
                    <div key={k}>
                      <dt className="uppercase tracking-wider text-xs">{k}</dt>
                      <dd className="font-mono text-foreground mt-0.5 break-all">
                        {v}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="whitespace-pre-line">{outcome.description}</p>
              )}
              <p>
                Yes and No share one merged book — a bid on{" "}
                {outcome.sideSpecs[0]?.name} at p is an ask on{" "}
                {outcome.sideSpecs[1]?.name} at 1 − p. Fully collateralized,
                settles in {outcome.quoteToken}. Coins:{" "}
                <span className="font-mono">
                  {outcome.sides.map((s) => s.coin).join(", ")}
                </span>
              </p>
            </div>
          </details>

          <a
            href="https://t.me/+UMKzaeUVv7VjOTk1"
            target="_blank"
            rel="noreferrer noopener"
            className="rounded-2xl border border-border bg-surface px-5 py-4 flex items-center justify-between gap-3 hover:border-brand/40 transition group"
          >
            <div className="flex items-center gap-3 min-w-0">
              <TelegramLogo className="size-5 shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-semibold">Join our community</div>
                <div className="text-xs text-muted-foreground truncate">
                  See what everyone&apos;s talking about
                </div>
              </div>
            </div>
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground transition"
            />
          </a>
        </StickySidebar>
      </div>
    </div>
  )
}
