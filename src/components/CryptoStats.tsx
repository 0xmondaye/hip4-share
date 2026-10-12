"use client"

import Link from "next/link"
import { useEffect, useReducer, useRef, useState } from "react"
import { parseExpiry } from "@/lib/types"
import { PopDigits } from "./PopDigits"
import {
  AXIS_TEXT,
  CHART_TEXT_HALO,
  GRID_LINE,
  coinColor,
  fmtHoverTime,
  holdToNow,
  linePath,
  nearestPoint,
  niceStep,
  timeTicks,
  useSvgWidth,
} from "@/lib/chart-hover"
import { LedPlot, PITCH } from "./LedPlot"
import { midOf, useLiveMids } from "@/lib/useLiveMids"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowUp02Icon,
} from "@hugeicons/core-free-icons"

interface CryptoStatsProps {
  underlying: string // e.g. "BTC" — a HyperCore perp coin
  target: number
  expiry?: string
  coin: string // outcome side-0 coin, for the chance chart
  chance: number | null // initial side-0 mid, 0..1
  results: { time: number; up: boolean }[] // newest first
  resultsHref: string
}

type Point = { t: number; px: number }

const WS_URL = "wss://api.hyperliquid.xyz/ws"
const WINDOW_MS = 30_000 // visible time span

function fmtUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : 2 })}`
}

export function CryptoStats({
  underlying,
  target,
  expiry,
  coin,
  chance,
  results,
  resultsHref,
}: CryptoStatsProps) {
  const pointsRef = useRef<Point[]>([])
  const [, frame] = useReducer((x: number) => x + 1, 0)
  const [live, setLive] = useState(false)
  const [mode, setMode] = useState<"price" | "chance">("price")
  const [chancePts, setChancePts] = useState<Point[] | null>(null)
  const { mids } = useLiveMids({})

  // chance history: 1m candles of the outcome coin, polled while visible
  useEffect(() => {
    if (mode !== "chance") return
    let stopped = false
    const load = async () => {
      try {
        const end = Date.now()
        const res = await fetch("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "candleSnapshot",
            req: {
              coin,
              interval: "1m",
              startTime: end - 6 * 3600_000,
              endTime: end,
            },
          }),
          cache: "no-store",
        })
        if (!res.ok) return
        const ks = (await res.json()) as { t: number; c: string }[]
        if (stopped) return
        const pts = ks
          .map((k) => ({ t: k.t, px: Number(k.c) }))
          .filter((p) => Number.isFinite(p.px))
        setChancePts(pts)
      } catch {
        /* keep last data */
      }
    }
    load()
    const id = setInterval(load, 60_000)
    return () => {
      stopped = true
      clearInterval(id)
    }
  }, [mode, coin])

  // WS feed → ref only; rendering is driven by the rAF loop below
  useEffect(() => {
    pointsRef.current = []
    setLive(false)
    let ws: WebSocket | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let ping: ReturnType<typeof setInterval> | undefined
    let stopped = false

    const connect = () => {
      if (stopped) return
      ws = new WebSocket(WS_URL)
      ws.onopen = () => {
        ws?.send(
          JSON.stringify({
            method: "subscribe",
            subscription: { type: "activeAssetCtx", coin: underlying },
          }),
        )
        // HL closes sockets with no client message for 60s; keepalive
        ping = setInterval(
          () => ws?.send(JSON.stringify({ method: "ping" })),
          30_000,
        )
      }
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as {
          channel: string
          data?: { ctx?: { midPx?: string; markPx?: string } }
        }
        if (msg.channel !== "activeAssetCtx") return
        const px = Number(msg.data?.ctx?.midPx ?? msg.data?.ctx?.markPx)
        if (Number.isFinite(px)) {
          pointsRef.current = [
            ...pointsRef.current.slice(-599),
            { t: Date.now(), px },
          ]
          setLive(true)
        }
      }
      ws.onclose = () => {
        if (ping) clearInterval(ping)
        if (!stopped) retry = setTimeout(connect, 3000)
      }
      ws.onerror = () => ws?.close()
    }

    // backfill the window from recent trades so the chart isn't blank on open
    const seed = async () => {
      try {
        const res = await fetch("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "recentTrades", coin: underlying }),
          cache: "no-store",
        })
        if (!res.ok) return
        const trades = (await res.json()) as { time: number; px: string }[]
        if (stopped) return
        const firstLive = pointsRef.current[0]?.t ?? Infinity
        const old = trades
          .map((tr) => ({ t: tr.time, px: Number(tr.px) }))
          .filter((p) => Number.isFinite(p.px) && p.t < firstLive)
          .sort((a, b) => a.t - b.t)
        if (old.length > 0) {
          pointsRef.current = [...old, ...pointsRef.current]
          setLive(true)
        }
      } catch {
        /* live feed fills the chart anyway */
      }
    }

    seed()
    connect()
    return () => {
      stopped = true
      if (retry) clearTimeout(retry)
      if (ping) clearInterval(ping)
      ws?.close()
    }
  }, [underlying])

  // rAF loop: re-render every frame so the chart scrolls with the clock
  useEffect(() => {
    let raf = 0
    const tick = () => {
      frame()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const color = coinColor(underlying)
  const points = pointsRef.current
  const current = points.length > 0 ? points[points.length - 1].px : null
  const delta = current !== null ? current - target : null
  // Chance is the book mid (allMids), per HIP-4: price *is* the implied
  // probability. Candle closes are trade prints — on a thin outcome book the
  // last one can sit outside the current spread, so they never drive the
  // headline number. They only draw history, held to now at the mid.
  const liveChance = midOf(mids, coin) ?? chance
  const chanceLine = chancePts
    ? holdToNow(
        chancePts.map((p) => ({ t: p.t, c: p.px })),
        Date.now(),
        liveChance,
      ).map((p) => ({ t: p.t, px: p.c }))
    : null

  return (
    // ponytail: card chrome is sm+ only — on mobile the plot runs edge-to-edge
    <div className="flex flex-col gap-2 sm:rounded-2xl sm:border sm:border-border sm:bg-surface sm:p-3">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        {mode === "price" ? (
          <div className="flex gap-8">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                ◎ Target
              </div>
              <div className="text-2xl font-normal font-heading tabular-nums mt-0.5">
                {fmtUsd(target)}
              </div>
            </div>
            <div>
              <div
                className="text-xs uppercase tracking-wider"
                style={{ color }}
              >
                ● Current
              </div>
              <div className="text-2xl font-normal font-heading tabular-nums mt-0.5 flex items-baseline gap-2">
                <span style={{ color }}>
                  {current !== null ? fmtUsd(current) : "—"}
                </span>
                {delta !== null && (
                  <span
                    className={`text-xs ${delta >= 0 ? "text-yes" : "text-no"}`}
                  >
                    {delta >= 0 ? "↑" : "↓"}$
                    {Math.abs(delta).toLocaleString("en-US", {
                      maximumFractionDigits: 0,
                    })}
                  </span>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div>
            <div className="text-xs uppercase tracking-wider" style={{ color }}>
              ● Chance
            </div>
            <div
              className="text-2xl font-normal font-mono tabular-nums mt-0.5"
              style={{ color }}
            >
              {liveChance !== null ? `${Math.floor(liveChance * 100)}%` : "—"}
            </div>
          </div>
        )}
        <Countdown expiry={expiry} />
      </div>
      {/* full-bleed: -mx-3 cancels main's px-3 on mobile (card has no padding
          there), -mx-2 cancels most of the card's p-3 from sm up;
          flex-1 so the chart absorbs whatever height the grid row gives the card */}
      <div className="-mx-3 sm:-mx-2 flex-1 min-h-[220px]">
        {mode === "price" ? (
          live && points.length > 0 ? (
            <Chart points={points} target={target} color={color} />
          ) : (
            <div className="h-full min-h-[220px] flex items-center justify-center text-xs text-muted-foreground">
              Connecting to live feed…
            </div>
          )
        ) : chanceLine && chanceLine.length > 1 ? (
          <ChanceChart points={chanceLine} color={color} />
        ) : (
          <div className="h-full min-h-[220px] flex items-center justify-center text-xs text-muted-foreground">
            {chancePts === null
              ? "Loading chance history…"
              : "No chance history yet."}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <PastResults results={results} href={resultsHref} />
        <div className="ml-auto flex rounded-lg border border-border bg-surface-2 p-0.5 text-xs">
          {(["price", "chance"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-label={m === "price" ? "Price" : "Chance"}
              className={`px-2.5 py-1 rounded-md transition ${
                mode === m
                  ? "bg-surface text-foreground font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <span className="sm:hidden">{m === "price" ? "$" : "%"}</span>
              <span className="hidden sm:inline">
                {m === "price" ? "Price" : "Chance"}
              </span>
            </button>
          ))}
        </div>
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

function PastResults({
  results,
  href,
}: {
  results: { time: number; up: boolean }[]
  href: string
}) {
  if (results.length === 0) return null
  const fmtDay = (ms: number) =>
    new Date(ms).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    })
  const dayHref = (ms: number) =>
    `${href}?d=${new Date(ms).toISOString().slice(0, 10).replace(/-/g, "")}`
  return (
    <div className="flex items-center gap-1 sm:gap-2">
      <details className="relative group">
        <summary className="cursor-pointer list-none rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1 hover:border-brand/40 transition">
          Past
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            className="size-3.5 transition group-open:rotate-180"
          />
        </summary>
        <div className="absolute bottom-full left-0 mb-2 w-44 rounded-xl border border-border bg-surface-2 p-1.5 shadow-lg z-10">
          {results.slice(0, 7).map((r) => (
            <Link
              key={r.time}
              href={dayHref(r.time)}
              className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface transition"
            >
              <ResultArrow up={r.up} />
              <span className="text-sm">{fmtDay(r.time)}</span>
            </Link>
          ))}
          <Link
            href={href}
            className="block px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition"
          >
            All results →
          </Link>
        </div>
      </details>
      {/* last 4 results, newest rightmost — click through to full results */}
      {results
        .slice(0, 4)
        .reverse()
        .map((r) => (
          <Link key={r.time} href={dayHref(r.time)} title="Past results">
            <ResultArrow up={r.up} />
          </Link>
        ))}
    </div>
  )
}

const CHANCE_HOURS = 6

// measured width + mouse position in plot-space x (0..plotW), null outside
function usePlotHover(padR = PAD_R) {
  const { W, H, svgRef, setSvgRef } = useSvgWidth(640, MIN_H)
  const plotW = W - padR
  const [hoverX, setHoverX] = useState<number | null>(null)
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const vx = ((e.clientX - rect.left) / rect.width) * W
    setHoverX(vx >= 0 && vx <= plotW ? vx : null)
  }
  return {
    W,
    H,
    plotW,
    hoverX,
    svgRef,
    setSvgRef,
    onMove,
    onLeave: () => setHoverX(null),
  }
}

function Crosshair({
  px,
  py,
  H,
  label,
  timeLabel,
  color,
}: {
  px: number
  py: number
  H: number
  label: string
  timeLabel: string
  color: string
}) {
  return (
    <g pointerEvents="none">
      <line
        x1={px}
        x2={px}
        y1={12}
        y2={H - 24}
        stroke="var(--muted-foreground)"
        strokeWidth={0.75}
        opacity={0.5}
      />
      <text
        x={px}
        y={10}
        textAnchor="middle"
        fill="var(--muted-foreground)"
        className="text-xs"
        fontFamily="var(--font-geist-mono)"
        {...CHART_TEXT_HALO}
      >
        {timeLabel}
      </text>
      <circle cx={px} cy={py} r={3.5} fill={color} />
      <text
        x={px - 10}
        y={py + 4}
        textAnchor="end"
        fill={color}
        fontWeight={700}
        className="text-xs"
        fontFamily="var(--font-geist-mono)"
        {...CHART_TEXT_HALO}
      >
        {label}
      </text>
    </g>
  )
}

function ChanceChart({ points, color }: { points: Point[]; color: string }) {
  const { W, H, plotW, hoverX, setSvgRef, onMove, onLeave } =
    usePlotHover(PAD_R_PCT)
  const now = points[points.length - 1].t
  // outcome coins only print candles for minutes with trades — clamp the
  // window to the data so a young/quiet market fills the chart, no blank gap
  const t0 = Math.max(now - CHANCE_HOURS * 3600_000, points[0].t)
  const visible = points.filter((p) => p.t >= t0)
  const x = (t: number) => ((t - t0) / (now - t0 || 1)) * plotW
  const y = (p: number) => H - 24 - p * (H - 48)
  const d = linePath(visible.map((p) => ({ x: x(p.t), y: y(p.px) })))
  const head = visible[visible.length - 1]

  const xTicks = timeTicks(t0, now, plotW, 3600_000)
  const fmtTime = (t: number) =>
    new Date(t).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    })

  return (
    <svg
      ref={setSvgRef}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="w-full h-full cursor-crosshair"
      role="img"
      aria-label="Chance chart"
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      {[0, 0.2, 0.4, 0.6, 0.8, 1].map((v) => (
        <g key={v}>
          <line x1={0} x2={plotW} y1={y(v)} y2={y(v)} {...GRID_LINE} />
          <text x={plotW + 8} y={y(v) + 3} {...AXIS_TEXT}>
            {Math.round(v * 100)}%
          </text>
        </g>
      ))}
      <LedPlot id="chance" d={d} w={plotW} h={H} base={H - 24} color={color} />
      {head && (
        <>
          <circle cx={x(head.t)} cy={y(head.px)} r={PITCH / 2} fill={color} />
          <circle
            className="head-ping"
            cx={x(head.t)}
            cy={y(head.px)}
            r={7}
            fill={color}
          />
        </>
      )}
      {xTicks.map((t) => (
        <text
          key={t}
          x={x(t)}
          y={H - 6}
          textAnchor={x(t) < 28 ? "start" : "middle"}
          {...AXIS_TEXT}
        >
          {fmtTime(t)}
        </text>
      ))}
      {hoverX !== null &&
        visible.length > 0 &&
        (() => {
          const p = nearestPoint(
            visible,
            t0 + (hoverX / plotW) * (now - t0 || 1),
          )
          return (
            <Crosshair
              px={x(p.t)}
              py={y(p.px)}
              H={H}
              label={`${Math.round(p.px * 100)}%`}
              timeLabel={fmtHoverTime(p.t)}
              color={color}
            />
          )
        })()}
    </svg>
  )
}

function Countdown({ expiry }: { expiry?: string }) {
  const ts = parseExpiry(expiry)
  // null until mounted: a server-rendered clock hydrates one second later and
  // React flags the mismatch. Nothing to show before the client has a clock.
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  if (ts === null || now === null) return null
  const diff = Math.max(0, ts - now)
  const h = Math.floor(diff / 3600_000)
  const m = Math.floor((diff % 3600_000) / 60_000)
  const s = Math.floor((diff % 60_000) / 1000)
  const pad = (v: number) => String(v).padStart(2, "0")
  return (
    // it counts down, so digits drop in from above instead of rising.
    // One PopDigits per unit so the colons stay out of the fixed digit cells.
    <div
      className="ml-auto self-end text-sm font-normal font-heading tabular-nums text-foreground"
      style={{ "--digit-dir-y": "-1" } as React.CSSProperties}
      aria-label={`${h}h ${m}m ${s}s remaining`}
    >
      <PopDigits value={pad(h)} />
      <span className="opacity-60">:</span>
      <PopDigits value={pad(m)} />
      <span className="opacity-60">:</span>
      <PopDigits value={pad(s)} />
    </div>
  )
}

const MIN_H = 220 // fallback + floor; charts fill the card via h-full
// right gutter for the y labels, sized to the widest one each chart draws:
// "$63,004" + the target badge on the price chart, just "100%" on chance
const PAD_R = 72
const PAD_R_PCT = 40

function Chart({
  points,
  target,
  color,
}: {
  points: Point[]
  target: number
  color: string
}) {
  const { W, H, plotW, hoverX, setSvgRef, onMove, onLeave } = usePlotHover()
  // smoothing state survives across frames
  const dispRef = useRef<number>(NaN)
  const loRef = useRef<number>(NaN)
  const hiRef = useRef<number>(NaN)

  const now = Date.now()
  const t0 = now - WINDOW_MS

  // visible slice + one point before the left edge so the line enters cleanly
  let start = points.findIndex((p) => p.t >= t0)
  if (start === -1) start = points.length - 1
  const visible = points.slice(Math.max(0, start - 1))
  // no data reaching the left edge yet → anchor flat so there's no blank gap
  if (visible[0].t > t0) {
    visible.unshift({ t: t0 - 1000, px: visible[0].px })
  }

  const lastPx = points[points.length - 1].px
  // head eases toward the latest tick instead of jumping
  if (!Number.isFinite(dispRef.current)) dispRef.current = lastPx
  dispRef.current += (lastPx - dispRef.current) * 0.12

  const pxs = visible.map((p) => p.px).concat(dispRef.current)
  let wantLo = Math.min(...pxs)
  let wantHi = Math.max(...pxs)
  const pad = Math.max((wantHi - wantLo) * 0.25, wantHi * 0.00004)
  wantLo -= pad
  wantHi += pad
  // y domain eases toward the visible range instead of snapping
  if (!Number.isFinite(loRef.current)) {
    loRef.current = wantLo
    hiRef.current = wantHi
  } else {
    loRef.current += (wantLo - loRef.current) * 0.08
    hiRef.current += (wantHi - hiRef.current) * 0.08
  }
  const lo = loRef.current
  const hi = hiRef.current

  const x = (t: number) => ((t - t0) / WINDOW_MS) * plotW
  const y = (px: number) => H - 24 - ((px - lo) / (hi - lo)) * (H - 48)

  // draw through the real ticks, then on to the eased head at `now`
  const series: Point[] = [...visible, { t: now, px: dispRef.current }]
  const d = linePath(series.map((p) => ({ x: x(p.t), y: y(p.px) })))

  const step = niceStep((hi - lo) / 4)
  const gridVals: number[] = []
  for (let v = Math.ceil(lo / step) * step; v < hi; v += step) gridVals.push(v)
  const digits = step < 1 ? 2 : 0
  const fmtPx = (v: number) =>
    `$${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`

  const xTicks = timeTicks(t0, now, plotW, 5000)
  const fmtTime = (t: number) =>
    new Date(t).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })

  const yT = Math.min(H - 24, Math.max(12, y(target)))
  const headX = x(now)
  const headY = y(dispRef.current)

  return (
    <svg
      ref={setSvgRef}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="w-full h-full cursor-crosshair"
      role="img"
      aria-label="Underlying price chart"
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      {gridVals.map((v) => (
        <g key={v}>
          <line x1={0} x2={plotW} y1={y(v)} y2={y(v)} {...GRID_LINE} />
          <text x={plotW + 8} y={y(v) + 3} {...AXIS_TEXT}>
            {fmtPx(v)}
          </text>
        </g>
      ))}
      <line
        x1={0}
        x2={plotW}
        y1={yT}
        y2={yT}
        stroke="var(--muted-foreground)"
        strokeWidth={1}
        strokeDasharray="4 4"
      />
      <rect
        x={plotW + 2}
        y={yT - 9}
        width={PAD_R - 4}
        height={18}
        rx={4}
        fill="var(--surface-2)"
        stroke="var(--border)"
      />
      <text
        x={plotW + PAD_R / 2}
        y={yT + 3}
        textAnchor="middle"
        fill="var(--foreground)"
        className="text-xs"
        fontFamily="var(--font-geist-mono)"
      >
        {fmtPx(target)}
      </text>
      <LedPlot id="px" d={d} w={plotW} h={H} base={H - 24} color={color} />
      <circle cx={headX} cy={headY} r={PITCH / 2} fill={color} />
      <circle className="head-ping" cx={headX} cy={headY} r={7} fill={color} />
      {xTicks.map((t) => (
        <text
          key={t}
          x={x(t)}
          y={H - 6}
          textAnchor={x(t) < 28 ? "start" : "middle"}
          {...AXIS_TEXT}
        >
          {fmtTime(t)}
        </text>
      ))}
      {hoverX !== null &&
        (() => {
          const p = nearestPoint(series, t0 + (hoverX / plotW) * WINDOW_MS)
          return (
            <Crosshair
              px={x(p.t)}
              py={y(p.px)}
              H={H}
              label={fmtPx(p.px)}
              timeLabel={fmtTime(p.t)}
              color={color}
            />
          )
        })()}
    </svg>
  )
}
