"use client";

import { useState } from "react";
import { LedPlot, PITCH } from "./LedPlot";
import {
  AXIS_TEXT,
  CHART_TEXT_HALO,
  GRID_LINE,
  coinColor,
  fmtHoverTime,
  linePath,
  nearestPoint,
  niceStep,
  timeTicks,
  useSvgWidth,
} from "@/lib/chart-hover";

const H = 260;
const PAD_R = 84;

/** Day chart: underlying closes, dashed price-to-beat, settle dot, hover crosshair. */
export function DayChart({
  closes,
  target,
  coin,
}: {
  closes: { t: number; px: number }[];
  target: number;
  coin: string;
}) {
  const color = coinColor(coin);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const { W, svgRef, setSvgRef } = useSvgWidth(800);
  const PLOT_W = W - PAD_R;

  const t0 = closes[0].t;
  const t1 = closes[closes.length - 1].t;
  const pxs = closes.map((p) => p.px).concat(target);
  const lo = Math.min(...pxs);
  const hi = Math.max(...pxs);
  const pad = (hi - lo) * 0.15 || hi * 0.001;

  const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * PLOT_W;
  const y = (px: number) =>
    H - 24 - ((px - lo + pad) / (hi - lo + 2 * pad)) * (H - 48);

  const d = linePath(closes.map((p) => ({ x: x(p.t), y: y(p.px) })));
  const last = closes[closes.length - 1];

  const step = niceStep((hi - lo + 2 * pad) / 4);
  const gridVals: number[] = [];
  for (let v = Math.ceil((lo - pad) / step) * step; v < hi + pad; v += step)
    gridVals.push(v);
  const fmtPx = (v: number) =>
    `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

  const xTicks = timeTicks(t0, t1, PLOT_W, 3 * 3600_000);
  const fmtTime = (t: number) =>
    new Date(t).toLocaleTimeString("en-US", {
      hour: "numeric",
      hour12: true,
      timeZone: "UTC",
    });

  const yT = Math.min(H - 24, Math.max(12, y(target)));

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    setHoverX(vx >= 0 && vx <= PLOT_W ? vx : null);
  };
  const hp =
    hoverX !== null
      ? nearestPoint(closes, t0 + (hoverX / PLOT_W) * (t1 - t0 || 1))
      : null;

  return (
    <svg
      ref={setSvgRef}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="w-full cursor-crosshair"
      style={{ height: H }}
      role="img"
      aria-label="Day price chart"
      onMouseMove={onMove}
      onMouseLeave={() => setHoverX(null)}
    >
      {gridVals.map((v) => (
        <g key={v}>
          <line x1={0} x2={PLOT_W} y1={y(v)} y2={y(v)} {...GRID_LINE} />
          <text x={PLOT_W + 8} y={y(v) + 3} {...AXIS_TEXT}>
            {fmtPx(v)}
          </text>
        </g>
      ))}
      <line
        x1={0}
        x2={PLOT_W}
        y1={yT}
        y2={yT}
        stroke="var(--muted-foreground)"
        strokeWidth={1}
        strokeDasharray="4 4"
      />
      <rect
        x={PLOT_W + 2}
        y={yT - 9}
        width={PAD_R - 4}
        height={18}
        rx={4}
        fill="var(--surface-2)"
        stroke="var(--border)"
      />
      <text
        x={PLOT_W + PAD_R / 2}
        y={yT + 3}
        textAnchor="middle"
        fill="var(--foreground)"
        className="text-xs"
        fontFamily="var(--font-geist-mono)"
      >
        {fmtPx(target)}
      </text>
      <LedPlot id="day" d={d} w={PLOT_W} h={H} base={H - 24} color={color} />
      <circle cx={x(last.t)} cy={y(last.px)} r={PITCH / 2} fill={color} />
      <circle className="head-ping" cx={x(last.t)} cy={y(last.px)} r={7} fill={color} />
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
      {hp && (
        <g pointerEvents="none">
          <line
            x1={x(hp.t)}
            x2={x(hp.t)}
            y1={12}
            y2={H - 24}
            stroke="var(--muted-foreground)"
            strokeWidth={0.75}
            opacity={0.5}
          />
          <text
            x={x(hp.t)}
            y={10}
            textAnchor="middle"
            fill="var(--muted-foreground)"
            className="text-xs"
            fontFamily="var(--font-geist-mono)"
            {...CHART_TEXT_HALO}
          >
            {fmtHoverTime(hp.t, "UTC")}
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
            {fmtPx(hp.px)}
          </text>
        </g>
      )}
    </svg>
  );
}
