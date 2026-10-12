"use client"

import { useLogin, usePrivy, useWallets } from "@privy-io/react-auth"
import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { cancelOutcomeOrder } from "@/lib/hl-exchange"
import { OUTCOME_ASSET_BASE } from "@/lib/hl-asset"
import {
  getAllMids,
  getSpotState,
  type OutcomePosition,
} from "@/lib/hyperliquid"
import {
  bucketLabel,
  bucketThresholds,
  bucketTitle,
  coinFor,
  marketDisplayName,
  marketPath,
  outcomeIndex,
  parseRecurringDescription,
  positionsValue,
  type OutcomeMeta,
} from "@/lib/types"
import { fmtCents } from "./TradePanel"
import {
  AXIS_TEXT,
  CHART_TEXT_HALO,
  fmtHoverTime,
  linePath,
  nearestPoint,
  useSvgWidth,
} from "@/lib/chart-hover"
import { LedPlot, PITCH } from "./LedPlot"
import { DepositDialog } from "./DepositDialog"
import { RecoverFunds } from "./RecoverFunds"
import { HYPEREVM_ENABLED, readHyperEvmFunds } from "@/lib/hyperevm-funds"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

interface UserState {
  marginSummary?: {
    accountValue?: string
    totalRawUsd?: string
  }
  withdrawable?: string
}

interface UserFill {
  coin: string
  px: string
  sz: string
  side: "B" | "A"
  time: number
  closedPnl?: string
}

// [window, {history}] pairs; windows: day / week / month / allTime (+ perp*)
type PortfolioPerf = [
  string,
  {
    pnlHistory: [number, string][]
    accountValueHistory: [number, string][]
  },
][]

interface OpenOrder {
  coin: string
  oid: number
  side: "B" | "A"
  limitPx: string
  sz: string
  timestamp: number
}

async function hlInfo<T>(body: object): Promise<T> {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`HL info ${res.status}`)
  return (await res.json()) as T
}

export function Portfolio({ meta = null }: { meta?: OutcomeMeta | null }) {
  const { ready, authenticated } = usePrivy()
  const { login } = useLogin()
  const { wallets } = useWallets()
  const [state, setState] = useState<UserState | null>(null)
  const [spotUsdc, setSpotUsdc] = useState<{
    total: number
    free: number
  } | null>(null)
  const [positions, setPositions] = useState<OutcomePosition[]>([])
  // Same key's HyperEVM USDC. The header counts it (one-balance policy); so must this page,
  // or a guest sees "$201" up top and less here and files a ticket.
  const [evmUsdc, setEvmUsdc] = useState(0)
  const [mids, setMids] = useState<Record<string, string>>({})
  const [fills, setFills] = useState<UserFill[] | null>(null)
  const [orders, setOrders] = useState<OpenOrder[] | null>(null)
  const [perf, setPerf] = useState<PortfolioPerf | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [cancelling, setCancelling] = useState<number | null>(null)
  const [depositOpen, setDepositOpen] = useState(false)
  const [activity, setActivity] = useState<WalletActivity | null>(null)

  const wallet =
    wallets.find((w) => w.walletClientType === "privy") ?? wallets[0]
  const addr = wallet?.address ?? null

  useEffect(() => {
    if (!addr) return
    let aborted = false
    const load = async () => {
      setLoading(true)
      setErr(null)
      try {
        const [s, spot, evm, m, f, o, p] = await Promise.all([
          hlInfo<UserState>({ type: "clearinghouseState", user: addr }),
          getSpotState(addr, { cache: "no-store" }),
          HYPEREVM_ENABLED
            ? readHyperEvmFunds(addr as `0x${string}`).catch(() => null)
            : null,
          getAllMids({ cache: "no-store" }),
          hlInfo<UserFill[]>({
            type: "userFills",
            user: addr,
            aggregateByTime: false,
          }),
          hlInfo<OpenOrder[]>({ type: "frontendOpenOrders", user: addr }),
          hlInfo<PortfolioPerf>({ type: "portfolio", user: addr }),
        ])
        if (!aborted) {
          setState(s)
          setSpotUsdc(spot.usdc)
          if (evm) setEvmUsdc(Number(evm.usdc) / 1e6)
          setPositions(spot.positions)
          setMids(m)
          setFills(f)
          setOrders(o)
          setPerf(p)
        }
      } catch (e) {
        if (!aborted)
          setErr(e instanceof Error ? e.message : "Failed to load portfolio")
      } finally {
        if (!aborted) setLoading(false)
      }
    }
    void load()
    const t = setInterval(() => void load(), 10_000)
    return () => {
      aborted = true
      clearInterval(t)
    }
  }, [addr])

  // App-specific extras (bet volume, transfers) from the dashboard proxy.
  // One-shot: ledger and lifetime stats barely move; missing data hides the UI.
  useEffect(() => {
    if (!addr) return
    let aborted = false
    fetch(`/api/wallet-activity/${addr}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((a: WalletActivity | null) => {
        if (!aborted) setActivity(a)
      })
      .catch(() => {})
    return () => {
      aborted = true
    }
  }, [addr])

  // coin "#7401" → market name / side label / market link, from listing meta
  const coinInfo = useMemo(() => {
    const m = new Map<string, { label: string; side: string; href: string }>()
    if (!meta) return m
    for (const o of meta.outcomes) {
      const pm = parseRecurringDescription(o.description)
      const q =
        meta.questions.find(
          (x) =>
            x.namedOutcomes.includes(o.outcome) ||
            x.fallbackOutcome === o.outcome,
        ) ?? null
      const qm = q ? parseRecurringDescription(q.description) : null
      const label =
        qm?.class === "priceBucket"
          ? `${bucketTitle(qm)} · ${bucketLabel(bucketThresholds(qm), outcomeIndex(o.description))}`
          : q
            ? `${q.name} · ${o.outcome === q.fallbackOutcome ? "Other" : o.name}`
            : marketDisplayName(o.name, pm)
      const href = marketPath({ ...o, parsedMeta: pm }, q)
      o.sideSpecs.forEach((s, idx) => {
        m.set(coinFor(o.outcome, idx), { label, side: s.name, href })
      })
    }
    return m
  }, [meta])

  const coinLabel = (c: string) => {
    const i = coinInfo.get(c)
    return i ? `${i.label} — ${i.side}` : c
  }

  const cancel = async (o: OpenOrder) => {
    if (!wallet) return
    setCancelling(o.oid)
    setErr(null)
    try {
      // coin "#7401" → 7401 = outcome*10 + sideIdx; asset id adds the HIP-4 base
      await cancelOutcomeOrder(wallet, {
        assetId: OUTCOME_ASSET_BASE + Number(o.coin.slice(1)),
        oid: o.oid,
      })
      setOrders((prev) => prev?.filter((x) => x.oid !== o.oid) ?? null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Cancel failed")
    } finally {
      setCancelling(null)
    }
  }

  if (!ready) {
    return <Skeleton className="h-40 rounded-2xl" />
  }

  if (!authenticated) {
    return (
      <Empty className="rounded-2xl border border-dashed border-border bg-surface/50 p-10 sm:p-14">
        <EmptyHeader>
          <EmptyMedia variant="icon" className="bg-brand/10">
            <span className="text-2xl">🔑</span>
          </EmptyMedia>
          <EmptyTitle className="text-xl">
            Sign in to see your portfolio
          </EmptyTitle>
          <EmptyDescription>
            Connect to view your Hyperliquid balances, open positions, and
            recent fills.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            onClick={() => login()}
            className="btn-brand h-10 px-5 font-semibold"
          >
            Sign in
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  // Funds live in the spot clearinghouse (USDC + outcome shares); perps
  // accountValue only covers deposits not yet swept. Sum all three so
  // buying shares moves value from cash to positions instead of vanishing.
  const loaded = state !== null && spotUsdc !== null
  const posValue = positionsValue(positions, mids)
  const perpValue = Number(state?.marginSummary?.accountValue ?? 0)
  const accountValue = loaded
    ? perpValue + (spotUsdc?.total ?? 0) + evmUsdc + posValue
    : null
  const withdrawable = loaded
    ? Number(state?.withdrawable ?? 0) + (spotUsdc?.free ?? 0) + evmUsdc
    : null

  // trading record from settled fills — the gamified bits
  const dayHist = perf?.find(([k]) => k === "day")?.[1].pnlHistory
  const dayPnl = dayHist?.length ? Number(dayHist[dayHist.length - 1][1]) : null
  const settled = (fills ?? [])
    .map((f) => Number(f.closedPnl ?? 0))
    .filter((v) => v !== 0)
  const wins = settled.filter((v) => v > 0).length
  const losses = settled.length - wins
  const winRate =
    settled.length > 0 ? Math.round((wins / settled.length) * 100) : null
  const bestTrade = settled.length > 0 ? Math.max(...settled) : null

  return (
    <div className="space-y-6">
      <Card className="rounded-2xl bg-surface p-6 relative overflow-hidden flex-row items-end justify-between gap-4 flex-wrap">
        <div className="absolute inset-0 bg-gradient-to-br from-brand/10 via-transparent to-transparent pointer-events-none" />
        <div className="relative">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            Account value
          </div>
          <div className="text-4xl sm:text-5xl font-medium font-heading tabular-nums mt-1">
            {accountValue !== null ? `$${accountValue.toFixed(2)}` : "—"}
          </div>
          {dayPnl !== null && (
            <div
              className={`text-sm font-heading mt-1 ${dayPnl < 0 ? "text-no" : "text-yes"}`}
            >
              {fmtPnl(dayPnl)} today
            </div>
          )}
          <p className="text-xs text-muted-foreground font-mono mt-2 break-all">
            {addr}
          </p>
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => setDepositOpen(true)}
            className="btn-brand inline-flex items-center h-10 px-5 text-sm font-semibold cursor-pointer"
          >
            Deposit USDC
          </button>
          <DepositDialog open={depositOpen} onOpenChange={setDepositOpen} />
        </div>
      </Card>

      <RecoverFunds />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Card className="rounded-xl bg-surface p-4 gap-3">
          <div className="text-xs uppercase tracking-wider text-muted-foreground/70">
            Balances
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Stat
              bare
              label="Positions"
              value={loaded ? `$${posValue.toFixed(2)}` : "—"}
              sub={`${positions.length} open`}
            />
            <Stat
              bare
              label="Cash (USDC)"
              value={
                spotUsdc !== null
                  ? `$${(spotUsdc.total + perpValue + evmUsdc).toFixed(2)}`
                  : "—"
              }
            />
            <Stat
              bare
              label="Withdrawable"
              value={
                withdrawable !== null ? `$${withdrawable.toFixed(2)}` : "—"
              }
            />
          </div>
        </Card>

        <Card className="rounded-xl bg-surface p-4 gap-3">
          <div className="text-xs uppercase tracking-wider text-muted-foreground/70">
            Trading
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat
              bare
              label="Win rate"
              value={winRate !== null ? `${winRate}%` : "—"}
              sub={
                settled.length > 0 ? `${wins}W – ${losses}L` : "no closed trades"
              }
              tone={winRate === null ? undefined : winRate >= 50 ? "yes" : "no"}
            />
            <Stat
              bare
              label="Best trade"
              value={bestTrade !== null ? fmtPnl(bestTrade) : "—"}
              tone={bestTrade !== null && bestTrade > 0 ? "yes" : undefined}
            />
            <Stat
              bare
              label="Trades"
              value={fills !== null ? String(fills.length) : "—"}
              sub="lifetime fills"
            />
            <Stat
              bare
              label="Bet volume"
              value={
                activity !== null
                  ? `$${activity.hip4VolumeUSDC.toFixed(0)}`
                  : "—"
              }
              sub={
                activity !== null
                  ? `${activity.tradeCount} bets here`
                  : undefined
              }
            />
          </div>
        </Card>
      </div>

      {err && (
        <Alert variant="destructive">
          <AlertTitle>{err}</AlertTitle>
        </Alert>
      )}

      {perf && <PnlChart perf={perf} />}

      <section>
        <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-3">
          Open positions{" "}
          {loading && (
            <span className="t-shimmer" data-text="· loading">
              · loading
            </span>
          )}
        </h2>
        {positions.length === 0 ? (
          <Empty className="rounded-2xl border border-dashed border-border bg-surface/50 p-8">
            <EmptyDescription>
              No open outcome positions. Browse{" "}
              <Link href="/" className="text-brand hover:underline">
                markets
              </Link>{" "}
              to get started.
            </EmptyDescription>
          </Empty>
        ) : (
          <Card className="rounded-2xl bg-surface py-0">
            <Table>
              <TableHeader>
                <TableRow className="bg-surface-2/40 hover:bg-surface-2/40">
                  <TableHead>Market</TableHead>
                  <TableHead className="w-36">Chance</TableHead>
                  <TableHead className="text-right">Shares</TableHead>
                  <TableHead className="text-right">Entry</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead className="text-right">PnL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {positions.map((p) => {
                  const mid = mids[p.coin] ? Number(mids[p.coin]) : null
                  const value = mid !== null ? p.total * mid : p.entryNtl
                  const pnl = mid !== null ? value - p.entryNtl : null
                  const info = coinInfo.get(p.coin)
                  return (
                    <TableRow key={p.coin}>
                      <TableCell>
                        {info ? (
                          <Link
                            href={info.href}
                            className="hover:text-brand transition"
                          >
                            {info.label}{" "}
                            <span className="text-xs text-muted-foreground">
                              {info.side}
                            </span>
                          </Link>
                        ) : (
                          <span className="font-mono">{p.coin}</span>
                        )}
                        {p.settled && (
                          <span className="text-xs text-muted-foreground">
                            {" "}
                            · settled, converting…
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {mid !== null ? (
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 flex-1 rounded-full bg-surface-2 overflow-hidden">
                              <div
                                className="h-full bg-brand"
                                style={{ width: `${mid * 100}%` }}
                              />
                            </div>
                            <span className="font-mono text-xs tabular-nums">
                              {Math.round(mid * 100)}%
                            </span>
                          </div>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {p.total.toLocaleString("en-US")}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {fmtCents(p.entryNtl / p.total)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        ${value.toFixed(2)}
                      </TableCell>
                      <TableCell
                        className={`text-right font-heading ${
                          (pnl ?? 0) >= 0 ? "text-yes" : "text-no"
                        }`}
                      >
                        {pnl !== null
                          ? `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`
                          : "—"}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </Card>
        )}
      </section>

      {orders && orders.length > 0 && (
        <section>
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-3">
            Open orders
          </h2>
          <Card className="rounded-2xl bg-surface py-0">
            <Table>
              <TableHeader>
                <TableRow className="bg-surface-2/40 hover:bg-surface-2/40">
                  <TableHead>Market</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="text-right">Limit</TableHead>
                  <TableHead className="text-right">Placed</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((o) => (
                  <TableRow key={o.oid}>
                    <TableCell>{coinLabel(o.coin)}</TableCell>
                    <TableCell
                      className={`text-xs ${o.side === "B" ? "text-yes" : "text-no"}`}
                    >
                      {o.side === "B" ? "Buy" : "Sell"}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {o.sz}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {o.limitPx}
                    </TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground text-xs">
                      {new Date(o.timestamp).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={cancelling === o.oid}
                        onClick={() => void cancel(o)}
                        className="text-xs text-no hover:text-no"
                      >
                        {cancelling === o.oid ? "Cancelling…" : "Cancel"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </section>
      )}

      <section>
        <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-3">
          Recent fills
        </h2>
        {fills && fills.length > 0 ? (
          <Card className="rounded-2xl bg-surface py-0">
            <Table>
              <TableHeader>
                <TableRow className="bg-surface-2/40 hover:bg-surface-2/40">
                  <TableHead>Market</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fills.slice(0, 20).map((f, i) => (
                  <TableRow key={`${f.coin}-${f.time}-${i}`}>
                    <TableCell>{coinLabel(f.coin)}</TableCell>
                    <TableCell
                      className={`text-xs ${f.side === "B" ? "text-yes" : "text-no"}`}
                    >
                      {f.side === "B" ? "Buy" : "Sell"}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {f.sz}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {f.px}
                    </TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground text-xs">
                      {new Date(f.time).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        ) : (
          <Empty className="rounded-2xl border border-dashed border-border bg-surface/50 p-8">
            <EmptyDescription>No fills yet.</EmptyDescription>
          </Empty>
        )}
      </section>

      {activity !== null && activity.ledger.length > 0 && (
        <section>
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-3">
            Transfers
          </h2>
          <Card className="rounded-2xl bg-surface py-0">
            <Table>
              <TableHeader>
                <TableRow className="bg-surface-2/40 hover:bg-surface-2/40">
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">USDC</TableHead>
                  <TableHead className="text-right">Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activity.ledger
                  .slice()
                  .sort((a, b) => b.time - a.time)
                  .slice(0, 20)
                  .map((l, i) => (
                    <TableRow key={`${l.time}-${l.type}-${i}`}>
                      <TableCell className="text-xs">
                        {LEDGER_LABELS[l.type] ?? l.type}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {l.usdc !== null ? `$${l.usdc.toFixed(2)}` : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground text-xs">
                        {new Date(l.time).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </Card>
        </section>
      )}
    </div>
  )
}

type WalletActivity = {
  tradeCount: number
  hip4VolumeUSDC: number
  ledger: { time: number; type: string; usdc: number | null }[]
}

const LEDGER_LABELS: Record<string, string> = {
  deposit: "Deposit",
  withdraw: "Withdraw",
  send: "Send",
  receive: "Receive",
  accountClassTransfer: "Spot ⇄ Perps",
}

const PNL_WINDOWS = [
  ["day", "1D"],
  ["week", "1W"],
  ["month", "1M"],
  ["allTime", "All"],
] as const

const fmtPnl = (v: number) =>
  `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`
const fmtUsd = (v: number) => `$${v.toFixed(2)}`

function PnlChart({ perf }: { perf: PortfolioPerf }) {
  const [win, setWin] = useState<(typeof PNL_WINDOWS)[number][0]>("week")
  // PnL excludes deposits by design, so gacha/bridge income only ever shows in
  // the value series. Both numbers stay on screen; the tap picks what's plotted.
  const [mode, setMode] = useState<"pnl" | "value">("pnl")
  const [hoverX, setHoverX] = useState<number | null>(null)
  const { W, svgRef, setSvgRef } = useSvgWidth(800)
  const H = 180
  // no right gutter: the axis is gone, so the plot runs the full card width
  const PLOT_W = W

  const hist = perf.find(([k]) => k === win)?.[1]
  const series = (raw: [number, string][] | undefined) =>
    (raw ?? [])
      .map(([t, v]) => ({ t, px: Number(v) }))
      .filter((p) => Number.isFinite(p.px))
  const pnlPts = series(hist?.pnlHistory)
  const valPts = series(hist?.accountValueHistory)

  const pts = mode === "pnl" ? pnlPts : valPts
  const fmt = mode === "pnl" ? fmtPnl : fmtUsd
  const last = pts[pts.length - 1]
  const color = "var(--brand)"

  const tabs = (
    <div className="flex gap-1">
      {PNL_WINDOWS.map(([k, label]) => (
        <button
          key={k}
          type="button"
          onClick={() => setWin(k)}
          className={`px-2 py-0.5 rounded-md text-xs font-mono transition ${
            win === k
              ? "bg-surface-2 text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )

  let body: React.ReactNode
  if (pts.length < 2) {
    body = (
      <p className="text-sm text-muted-foreground px-4 py-10 text-center">
        Not enough history yet.
      </p>
    )
  } else {
    const t0 = pts[0].t
    const t1 = pts[pts.length - 1].t
    // PnL keeps 0 in frame (the zero line is the reference); account value
    // must not — forcing 0 in flattens a $17 balance against the top.
    const vs = pts.map((p) => p.px)
    const lo = Math.min(...vs, ...(mode === "pnl" ? [0] : []))
    const hi = Math.max(...vs, ...(mode === "pnl" ? [0] : []))
    const pad = (hi - lo) * 0.15 || 1
    const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * PLOT_W
    const y = (v: number) =>
      H - 24 - ((v - lo + pad) / (hi - lo + 2 * pad)) * (H - 40)

    // one label instead of an axis: the peak. Flip the anchor near the right
    // edge so the text stays inside the plot now that there's no gutter.
    const peak = pts.reduce((a, p) => (p.px > a.px ? p : a), pts[0])
    const peakEnd = x(peak.t) > PLOT_W * 0.8
    const hp =
      hoverX !== null
        ? nearestPoint(pts, t0 + (hoverX / PLOT_W) * (t1 - t0 || 1))
        : null

    const d = linePath(pts.map((p) => ({ x: x(p.t), y: y(p.px) })))
    const base = H - 24 // plot floor, where y(lo - pad) lands

    const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
      const rect = svgRef.current?.getBoundingClientRect()
      if (!rect) return
      const vx = ((e.clientX - rect.left) / rect.width) * W
      setHoverX(vx >= 0 && vx <= PLOT_W ? vx : null)
    }

    body = (
      <svg
        ref={setSvgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full cursor-crosshair"
        style={{ height: H }}
        role="img"
        aria-label={
          mode === "pnl" ? "PnL history chart" : "Account value history chart"
        }
        onMouseMove={onMove}
        onMouseLeave={() => setHoverX(null)}
      >
        <LedPlot id="pnl" d={d} w={PLOT_W} h={H} base={base} color={color} />
        <text
          x={x(peak.t) + (peakEnd ? -8 : 8)}
          y={Math.max(12, y(peak.px) - 8)}
          textAnchor={peakEnd ? "end" : "start"}
          {...AXIS_TEXT}
        >
          {fmt(peak.px)}
        </text>
        {mode === "pnl" && (
          <line
            x1={0}
            x2={PLOT_W}
            y1={y(0)}
            y2={y(0)}
            stroke="var(--muted-foreground)"
            strokeWidth={0.75}
            strokeDasharray="4 4"
            opacity={0.6}
          />
        )}
        <circle cx={x(last.t)} cy={y(last.px)} r={PITCH / 2} fill={color} />
        {hp && (
          <g pointerEvents="none">
            <line
              x1={x(hp.t)}
              x2={x(hp.t)}
              y1={8}
              y2={H - 24}
              stroke="var(--muted-foreground)"
              strokeWidth={0.75}
              opacity={0.5}
            />
            {/* stacked right-aligned with the value below it. No clamp needed:
                the 15% pad in `lo`/`hi` keeps y(hp.px) at ~32 or lower, so
                this baseline never reaches the top edge. */}
            <text
              x={x(hp.t) - 10}
              y={y(hp.px) - 10}
              textAnchor="end"
              fill="var(--muted-foreground)"
              className="text-xs"
              fontFamily="var(--font-geist-mono)"
              {...CHART_TEXT_HALO}
            >
              {fmtHoverTime(hp.t)}
            </text>
            <circle cx={x(hp.t)} cy={y(hp.px)} r={3.5} fill={color} />
            <text
              x={x(hp.t) - 10}
              y={y(hp.px) + 4}
              textAnchor="end"
              fill={color}
              fontWeight={700}
              className="text-xs"
              fontFamily="var(--font-geist-mono)"
              {...CHART_TEXT_HALO}
            >
              {fmt(hp.px)}
            </text>
          </g>
        )}
      </svg>
    )
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        {/* h2 wraps the buttons: keeps the section heading without a second,
            sr-only copy of the same words */}
        <h2 className="flex items-center gap-3 text-xs uppercase tracking-wider text-muted-foreground">
          <SeriesTab
            label="PnL"
            value={pnlPts.length ? fmtPnl(pnlPts[pnlPts.length - 1].px) : "—"}
            tone={
              pnlPts.length && pnlPts[pnlPts.length - 1].px < 0
                ? "text-no"
                : "text-yes"
            }
            active={mode === "pnl"}
            onClick={() => setMode("pnl")}
          />
          <SeriesTab
            label="Value"
            value={valPts.length ? fmtUsd(valPts[valPts.length - 1].px) : "—"}
            tone="text-foreground"
            active={mode === "value"}
            onClick={() => setMode("value")}
          />
        </h2>
        {tabs}
      </div>
      {/* p-0 + overflow-hidden: the plot runs edge to edge, corners still clip */}
      <Card className="rounded-2xl bg-surface p-0 overflow-hidden">{body}</Card>
    </section>
  )
}

function SeriesTab({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string
  value: string
  tone: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`cursor-pointer transition ${active ? "" : "opacity-40 hover:opacity-70"}`}
    >
      {label}{" "}
      <span className={`font-heading normal-case ${tone}`}>{value}</span>
    </button>
  )
}

function Stat({
  label,
  value,
  sub,
  tone,
  bare,
}: {
  label: string
  value: string
  sub?: string
  tone?: "yes" | "no"
  bare?: boolean
}) {
  const body = (
    <>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={`font-heading text-xl tabular-nums ${
          tone === "yes" ? "text-yes" : tone === "no" ? "text-no" : ""
        }`}
      >
        {value}
      </div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </>
  )
  return bare ? (
    <div className="gap-0.5 flex flex-col">{body}</div>
  ) : (
    <Card className="rounded-xl bg-surface px-4 py-3 gap-0.5">{body}</Card>
  )
}
