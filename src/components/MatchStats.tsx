"use client"

import { useEffect, useRef, useState } from "react"
import {
  AXIS_TEXT,
  CHART_TEXT_HALO,
  GRID_LINE,
  LINE_W,
  SERIES_COLORS,
  linePath,
  useSvgWidth,
} from "@/lib/chart-hover"
import { matchStatus } from "@/lib/types"
import { SportsLogo } from "./SportsLogo"
import { Button } from "@/components/ui/button"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ChartCandlestickIcon,
  ChartLineData01Icon,
} from "@hugeicons/core-free-icons"

interface MatchStatsProps {
  coins: [string, string] // side 0, side 1 outcome coins
  names: [string, string]
  initialMids: [number | null, number | null]
  kickoffMs?: number | null
}

type Point = { t: number; p0: number; p1: number }

const POLL_MS = 2500
const C0 = SERIES_COLORS[0] // side 0 line
const C1 = SERIES_COLORS[1] // side 1 line

function abbr(name: string): string {
  return name.length <= 4 ? name.toUpperCase() : name.slice(0, 3).toUpperCase()
}

export function MatchStats({
  coins,
  names,
  initialMids,
  kickoffMs,
}: MatchStatsProps) {
  const [points, setPoints] = useState<Point[]>([])
  const [mids, setMids] = useState<[number | null, number | null]>(initialMids)
  const [now, setNow] = useState(() => Date.now())
  const aborted = useRef(false)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    aborted.current = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const info = async (body: object) => {
      const res = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      return res.json()
    }

    const candles = (coin: string) =>
      info({
        type: "candleSnapshot",
        req: {
          coin,
          interval: "5m",
          startTime: Date.now() - 6 * 3600_000,
          endTime: Date.now(),
        },
      }) as Promise<{ T: number; c: string }[]>

    const seed = async () => {
      try {
        const [k0, k1] = await Promise.all([
          candles(coins[0]),
          candles(coins[1]),
        ])
        if (aborted.current) return
        const p1ByT = new Map(k1.map((k) => [k.T, Number(k.c)]))
        setPoints(
          k0.map((k) => {
            const p0 = Number(k.c)
            return { t: k.T, p0, p1: p1ByT.get(k.T) ?? 1 - p0 }
          }),
        )
      } catch {
        /* chart stays empty */
      }
      poll()
    }

    const poll = async () => {
      try {
        const all = (await info({ type: "allMids" })) as Record<string, string>
        const m0 = Number(all[coins[0]])
        const m1 = Number(all[coins[1]])
        if (!aborted.current && Number.isFinite(m0)) {
          setMids([m0, Number.isFinite(m1) ? m1 : null])
          setPoints((prev) => [
            ...prev.slice(-720),
            { t: Date.now(), p0: m0, p1: Number.isFinite(m1) ? m1 : 1 - m0 },
          ])
        }
      } catch {
        /* transient */
      } finally {
        if (!aborted.current) timer = setTimeout(poll, POLL_MS)
      }
    }

    seed()
    return () => {
      aborted.current = true
      if (timer) clearTimeout(timer)
    }
  }, [coins[0], coins[1]]) // eslint-disable-line react-hooks/exhaustive-deps

  // ponytail: no score/status feed — see matchStatus() for the heuristic
  const recentMids = points.filter((p) => now - p.t < 15 * 60_000).map((p) => p.p0)
  const status = matchStatus(mids[0], kickoffMs ?? null, now, recentMids)
  const beforeMatchDay = kickoffMs != null && now < kickoffMs

  return (
    <div className="rounded-2xl border border-border bg-surface p-3 flex flex-col gap-5">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div className="text-center">
          <SportsLogo name={names[0]} className="size-12" />
          <div className="text-sm font-semibold mt-2">{names[0]}</div>
        </div>
        <div className="text-center">
          <div className="flex items-center gap-3 justify-center text-2xl font-bold text-muted-foreground">
            <span>–</span>
            <span className="text-xs font-normal">VS</span>
            <span>–</span>
          </div>
          <div className="inline-flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
            <span
              className={`size-1.5 rounded-full ${
                status === "Live" ? "bg-no pulse-dot" : "bg-muted-foreground"
              }`}
            />
            {status}
          </div>
          {status === "Not Started" && kickoffMs != null && (
            <div className="text-xs font-mono tabular-nums text-muted-foreground mt-1">
              {beforeMatchDay ? fmtCountdown(kickoffMs - now) : "Today"}
            </div>
          )}
        </div>
        <div className="text-center">
          <SportsLogo name={names[1]} className="size-12" />
          <div className="text-sm font-semibold mt-2">{names[1]}</div>
        </div>
      </div>

      {/* flex-1 so the chart absorbs whatever height the grid row gives the card */}
      <div className="-mx-2 flex-1 min-h-[260px]">
        <ProbChart points={points} names={names} />
      </div>

      <div className="flex justify-end gap-1 -mt-3">
        <Button size="icon-sm" variant="secondary" aria-label="Line chart">
          <HugeiconsIcon icon={ChartLineData01Icon} />
        </Button>
        {/* ponytail: candle view not implemented — probability line only */}
        <Button
          size="icon-sm"
          variant="ghost"
          disabled
          aria-label="Candlestick chart (unavailable)"
        >
          <HugeiconsIcon icon={ChartCandlestickIcon} />
        </Button>
      </div>
    </div>
  )
}

function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400)
  const pad = (n: number) => String(n).padStart(2, "0")
  const hms = `${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
  return d > 0 ? `${d}d ${hms}` : hms
}

const MIN_H = 260 // fallback + floor; chart fills the card via h-full
const PAD_R = 92 // room for end labels + axis
const PAD_T = 24
const PAD_B = 24

function ProbChart({
  points,
  names,
}: {
  points: Point[]
  names: [string, string]
}) {
  const [hoverI, setHoverI] = useState<number | null>(null)
  const { W, H, svgRef, setSvgRef } = useSvgWidth(640, MIN_H)

  if (points.length < 2) {
    return (
      <div className="h-full min-h-[260px] flex items-center justify-center text-xs text-muted-foreground">
        Loading chart…
      </div>
    )
  }
  const vals = points.flatMap((p) => [p.p0, p.p1])
  let lo = Math.min(...vals)
  let hi = Math.max(...vals)
  const pad = Math.max((hi - lo) * 0.25, 0.03)
  lo = Math.max(0, lo - pad)
  hi = Math.min(1, hi + pad)
  const t0 = points[0].t
  const t1 = points[points.length - 1].t
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD_R)
  const y = (p: number) =>
    H - PAD_B - ((p - lo) / (hi - lo)) * (H - PAD_T - PAD_B)
  const path = (get: (p: Point) => number) =>
    linePath(points.map((pt) => ({ x: x(pt.t), y: y(get(pt)) })))

  // crosshair: marker follows the cursor; snaps back to live on leave
  const cur = hoverI !== null ? points[hoverI] : points[points.length - 1]
  const isLivePoint = hoverI === null || hoverI === points.length - 1
  const xEnd = x(cur.t)

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const vx = ((e.clientX - rect.left) / rect.width) * W
    if (vx >= W - PAD_R) {
      setHoverI(null)
      return
    }
    const t = t0 + (vx / (W - PAD_R)) * (t1 - t0)
    let idx = points.findIndex((p) => p.t >= t)
    if (idx < 0) idx = points.length - 1
    setHoverI(idx)
  }

  // keep the two end labels from overlapping
  let y0 = y(cur.p0)
  let y1 = y(cur.p1)
  if (Math.abs(y0 - y1) < 16) {
    const mid = (y0 + y1) / 2
    if (y0 <= y1) {
      y0 = mid - 8
      y1 = mid + 8
    } else {
      y0 = mid + 8
      y1 = mid - 8
    }
  }

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + (hi - lo) * f)
  const fmtHour = (t: number) =>
    new Date(t).toLocaleTimeString("en-US", { hour: "numeric" })
  const nowLabel = `${new Date(cur.t).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })} at ${new Date(cur.t).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  })}`

  // labels appear on hover only
  const endLabel = (name: string, p: number, ly: number, color: string) => (
    <g
      fontFamily="var(--font-geist-mono)"
      className="opacity-0 group-hover:opacity-100 transition-opacity duration-200"
    >
      <text
        x={xEnd + 10}
        y={ly + 4}
        fill={color}
        className="text-xs"
        fontWeight={700}
        {...CHART_TEXT_HALO}
      >
        {abbr(name)} {Math.round(p * 100)}%
      </text>
    </g>
  )

  const pulsingDot = (cy: number, color: string) => (
    <>
      <circle cx={xEnd} cy={cy} r={3.5} fill={color}>
        {isLivePoint && (
          <animate
            attributeName="opacity"
            values="1;0.6;1"
            dur="1.8s"
            repeatCount="indefinite"
          />
        )}
      </circle>
      {isLivePoint && (
        <circle cx={xEnd} cy={cy} r={3.5} fill="none" stroke={color}>
          <animate
            attributeName="r"
            values="3.5;11"
            dur="1.8s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0.7;0"
            dur="1.8s"
            repeatCount="indefinite"
          />
        </circle>
      )}
    </>
  )

  return (
    <svg
      ref={setSvgRef}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="w-full h-full group cursor-crosshair"
      role="img"
      aria-label="Win probability chart"
      onMouseMove={onMove}
      onMouseLeave={() => setHoverI(null)}
    >
      {ticks.map((v) => (
        <g key={v}>
          <line x1={0} x2={W - PAD_R} y1={y(v)} y2={y(v)} {...GRID_LINE} />
          <text x={W - 8} y={y(v) + 3} textAnchor="end" {...AXIS_TEXT}>
            {Math.round(v * 100)}%
          </text>
        </g>
      ))}

      {/* now marker */}
      <line
        x1={xEnd}
        x2={xEnd}
        y1={PAD_T - 8}
        y2={H - PAD_B}
        stroke="var(--muted-foreground)"
        strokeWidth={0.75}
        opacity={0.5}
      />
      <text
        x={xEnd > 160 ? xEnd - 6 : xEnd + 6}
        y={PAD_T - 12}
        textAnchor={xEnd > 160 ? "end" : "start"}
        fill="var(--muted-foreground)"
        className="text-xs"
        fontFamily="var(--font-geist-mono)"
        {...CHART_TEXT_HALO}
      >
        {nowLabel}
      </text>

      <path d={path((p) => p.p1)} fill="none" stroke={C1} strokeWidth={LINE_W} />
      <path d={path((p) => p.p0)} fill="none" stroke={C0} strokeWidth={LINE_W} />
      {pulsingDot(y(cur.p1), C1)}
      {pulsingDot(y(cur.p0), C0)}
      {endLabel(names[1], cur.p1, y1, C1)}
      {endLabel(names[0], cur.p0, y0, C0)}

      {[0.08, 0.32, 0.56, 0.8].map((f) => {
        const t = t0 + (t1 - t0) * f
        return (
          <text key={f} x={x(t)} y={H - 6} textAnchor="middle" {...AXIS_TEXT}>
            {fmtHour(t)}
          </text>
        )
      })}
    </svg>
  )
}
