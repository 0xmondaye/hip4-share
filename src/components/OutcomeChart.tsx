"use client"

import { useEffect, useState } from "react"
import { LedPlot, PITCH } from "./LedPlot"
import {
  AXIS_TEXT,
  CHART_TEXT_HALO,
  GRID_LINE,
  SERIES_COLORS as COLORS,
  fmtHoverTime,
  holdToNow,
  linePath,
  nearestPoint,
  useSvgWidth,
} from "@/lib/chart-hover"

export type ChartSeries = {
  name: string
  coin: string
  mid: number | null
  /** Override the palette color (e.g. match the market's logo). */
  color?: string
}

type Point = { t: number; c: number }

const MIN_H = 220 // fallback + floor; matches CryptoStats so both charts sit the same
const PAD_R = 56 // y labels on the right, like the reference UI
const PAD_B = 24
const PAD_T = 10

function fmtHour(t: number): string {
  return new Date(t).toLocaleTimeString("en-US", {
    hour: "numeric",
    hour12: true,
  })
}

/** Probability history for the top outcomes of a question, from 1h candles. */
export function OutcomeChart({ series }: { series: ChartSeries[] }) {
  const colorOf = (s: ChartSeries, i: number) =>
    s.color ?? COLORS[i % COLORS.length]
  const [data, setData] = useState<Record<string, Point[]>>({})
  const [now, setNow] = useState(0)
  const [hoverT, setHoverT] = useState<number | null>(null)
  // viewBox tracks rendered size so the chart fills the card without text distortion
  const { W, H, svgRef, setSvgRef } = useSvgWidth(800, MIN_H)

  useEffect(() => {
    let dead = false
    const end = Date.now()
    ;(async () => {
      const entries = await Promise.all(
        series.map(async (s) => {
          try {
            const res = await fetch("https://api.hyperliquid.xyz/info", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                type: "candleSnapshot",
                req: {
                  coin: s.coin,
                  interval: "1h",
                  startTime: end - 24 * 3600_000,
                  endTime: end,
                },
              }),
              cache: "no-store",
            })
            const ks = (await res.json()) as { t: number; c: string }[]
            return [
              s.coin,
              ks.map((k) => ({ t: k.t, c: Number(k.c) })),
            ] as const
          } catch {
            return [s.coin, []] as const
          }
        }),
      )
      if (!dead) {
        setData(Object.fromEntries(entries))
        setNow(end)
      }
    })()
    return () => {
      dead = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series.map((s) => s.coin).join(",")])

  const filled: Record<string, Point[]> = Object.fromEntries(
    series.map((s) => [s.coin, holdToNow(data[s.coin] ?? [], now, s.mid)]),
  )
  const all = series.flatMap((s) => filled[s.coin] ?? [])
  const t0 = all.length ? Math.min(...all.map((p) => p.t)) : 0
  const t1 = all.length ? Math.max(...all.map((p) => p.t)) : 1
  const maxP = Math.max(
    0.1,
    ...all.map((p) => p.c),
    ...series.map((s) => s.mid ?? 0),
  )
  const yMax = Math.min(1, Math.ceil((maxP * 100 + 5) / 10) / 10) // headroom, 10% steps
  const x = (t: number) =>
    t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * (W - PAD_R)
  const y = (c: number) => PAD_T + (1 - c / yMax) * (H - PAD_B - PAD_T)

  // keep ~22px between % labels: 10-point steps on a tall chart, 20 on a short
  const yStep = (H - PAD_T - PAD_B) / (yMax * 100) >= 2.2 ? 10 : 20
  const gridPcts: number[] = []
  for (let p = 0; p <= yMax * 100; p += yStep) gridPcts.push(p)

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || t1 <= t0) return
    const vx = ((e.clientX - rect.left) / rect.width) * W
    setHoverT(
      vx >= 0 && vx <= W - PAD_R ? t0 + (vx / (W - PAD_R)) * (t1 - t0) : null,
    )
  }

  const xTicks =
    t1 > t0
      ? [0, 0.25, 0.5, 0.75, 1].map(
          (f) =>
            [
              t0 + f * (t1 - t0),
              f === 0 ? "start" : f === 1 ? "end" : "middle",
            ] as const,
        )
      : []

  return (
    // same chrome as CryptoStats: no card on mobile, plot runs edge-to-edge
    <div className="flex flex-col gap-2 sm:rounded-2xl sm:border sm:border-border sm:bg-surface sm:p-3">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        {series.map((s, i) => (
          <span key={s.coin} className="inline-flex items-center gap-1.5">
            <span
              className="size-2 rounded-full"
              style={{ background: colorOf(s, i) }}
            />
            <span className="text-muted-foreground">{s.name}</span>
            <span
              className="font-mono tabular-nums font-semibold"
              style={{ color: colorOf(s, i) }}
            >
              {s.mid !== null ? `${Math.round(s.mid * 100)}%` : "—"}
            </span>
          </span>
        ))}
      </div>
      {/* full-bleed: -mx-3 cancels main's px-3 on mobile (no card there),
          -mx-2 cancels most of the card's p-3 from sm up.
          Fixed height until xl: the card is auto-height there, so the svg's
          h-full has nothing to resolve against and sizes itself off the
          viewBox aspect instead — height then scales with width and a wide
          phone gets a 1000px-tall chart. From xl the grid row bounds the
          card, so flex-1 is definite and the chart absorbs the row height. */}
      <div className="-mx-3 sm:-mx-2 h-[220px] xl:h-auto xl:flex-1 xl:min-h-[220px]">
        <svg
          ref={setSvgRef}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="w-full h-full cursor-crosshair"
          onMouseMove={onMove}
          onMouseLeave={() => setHoverT(null)}
        >
          {gridPcts.map((p) => (
            <g key={p}>
              <line
                x1={0}
                x2={W - PAD_R}
                y1={y(p / 100)}
                y2={y(p / 100)}
                {...GRID_LINE}
              />
              <text x={W - PAD_R + 8} y={y(p / 100) + 4} {...AXIS_TEXT}>
                {p}%
              </text>
            </g>
          ))}
          {xTicks.map(([t, anchor]) => (
            <text key={t} x={x(t)} y={H - 6} textAnchor={anchor} {...AXIS_TEXT}>
              {fmtHour(t)}
            </text>
          ))}
          {series.map((s, i) => {
            const pts = filled[s.coin] ?? []
            if (pts.length === 0) return null
            const color = colorOf(s, i)
            const last = pts[pts.length - 1]
            return (
              <g key={s.coin}>
                <LedPlot
                  id={`oc-${i}`}
                  d={linePath(pts.map((p) => ({ x: x(p.t), y: y(p.c) })))}
                  w={W - PAD_R}
                  h={H}
                  base={H - PAD_B}
                  color={color}
                  // single series reads like the portfolio PnL chart — area
                  // fill on; stacked fades only go muddy multi-series
                  area={series.length === 1}
                />
                <circle cx={x(last.t)} cy={y(last.c)} r={PITCH} fill={color} />
                <circle
                  className="head-ping"
                  cx={x(last.t)}
                  cy={y(last.c)}
                  r={7}
                  fill={color}
                />
              </g>
            )
          })}
          {hoverT !== null && all.length > 0 && (
            <g pointerEvents="none">
              <line
                x1={x(hoverT)}
                x2={x(hoverT)}
                y1={PAD_T}
                y2={H - PAD_B}
                stroke="var(--muted-foreground)"
                strokeWidth={0.75}
                opacity={0.5}
              />
              <text
                x={x(hoverT)}
                y={PAD_T + 2}
                textAnchor="middle"
                {...AXIS_TEXT}
                {...CHART_TEXT_HALO}
              >
                {fmtHoverTime(hoverT)}
              </text>
              {(() => {
                // single-line label per series, centered on its dot; nudge
                // labels apart when lines run close so they never overlap
                const hovered = series.flatMap((s, i) => {
                  const pts = filled[s.coin] ?? []
                  if (pts.length === 0) return []
                  const p = nearestPoint(pts, hoverT)
                  return [{ s, i, p, ly: y(p.c) }]
                })
                hovered.sort((a, b) => a.ly - b.ly)
                for (let k = 1; k < hovered.length; k++)
                  hovered[k].ly = Math.max(
                    hovered[k].ly,
                    hovered[k - 1].ly + 16,
                  )
                return hovered.map(({ s, i, p, ly }) => {
                  const color = colorOf(s, i)
                  // hovering the left half puts the label right of the
                  // crosshair, else it runs off the canvas
                  const right = x(p.t) < (W - PAD_R) / 2
                  return (
                    <g key={s.coin}>
                      <circle cx={x(p.t)} cy={y(p.c)} r={4} fill={color} />
                      <text
                        x={x(p.t) + (right ? 10 : -10)}
                        y={ly + 4}
                        fontWeight={700}
                        textAnchor={right ? "start" : "end"}
                        {...AXIS_TEXT}
                        fill={color}
                        {...CHART_TEXT_HALO}
                      >
                        {/* name lives in the legend — the dot colour already
                            says which series this is */}
                        {Math.round(p.c * 100)}%
                      </text>
                    </g>
                  )
                })
              })()}
            </g>
          )}
        </svg>
      </div>
    </div>
  )
}
