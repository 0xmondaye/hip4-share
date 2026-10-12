// Single source of truth for chart look & feel + shared hover helpers.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

// Multi-series palette (blue / yellow / red / purple).
export const SERIES_COLORS = ["#3b82f6", "#eab308", "#ef4444", "#a78bfa"];
export const LINE_W = 1.5;

// Single-series charts (live price / chance / past results) accent with the
// underlying's own brand color. Anything not listed falls back to app lime.
const COIN_COLORS: Record<string, string> = {
  BTC: "#f7931a",
  ETH: "#8ba2ff",
  SOL: "#b478ff",
  HYPE: "#97fce4",
};
export const coinColor = (coin: string) => COIN_COLORS[coin] ?? "var(--brand)";

export const GRID_LINE = {
  stroke: "var(--border)",
  strokeWidth: 0.5,
} as const;

export const AXIS_TEXT = {
  fill: "var(--muted-foreground)",
  className: "text-xs",
  fontFamily: "var(--font-geist-mono)",
} as const;

// Time ticks that never crowd: widen `stepMs` to whole multiples until each
// label owns ~`minPx` of plot width. 68px fits "16:42:45" at text-xs mono.
export function timeTicks(
  t0: number,
  t1: number,
  plotW: number,
  stepMs: number,
  minPx = 68,
): number[] {
  const span = t1 - t0;
  if (span <= 0 || plotW <= 0) return [];
  const step = Math.ceil(span / Math.max(1, Math.floor(plotW / minPx)) / stepMs) * stepMs;
  const out: number[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) out.push(t);
  return out;
}

// HIP-4 outcome coins trade thin, so each series' last candle is stale by a
// different amount and the raw lines stop at different x. Carry a series flat
// to `now` at its live mid: every line then reaches the right edge and its end
// dot agrees with the legend. No candles at all = nothing to anchor to.
export function holdToNow(
  pts: { t: number; c: number }[],
  now: number,
  mid: number | null,
): { t: number; c: number }[] {
  if (!pts.length || mid === null || !Number.isFinite(mid)) return pts;
  return pts[pts.length - 1].t >= now ? pts : [...pts, { t: now, c: mid }];
}

export function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m > 5 ? 10 : m > 2 ? 5 : m > 1 ? 2 : 1) * p;
}

// Monotone cubic path (d3 curveMonotoneX style): smooth, but never
// overshoots the data — safe for bounded series like probabilities.
export function linePath(pts: { x: number; y: number }[]): string {
  const n = pts.length;
  const f = (v: number) => v.toFixed(1);
  if (n === 0) return "";
  let d = `M${f(pts[0].x)},${f(pts[0].y)}`;
  if (n === 1) return d;
  if (n === 2) return `${d}L${f(pts[1].x)},${f(pts[1].y)}`;
  const h: number[] = [];
  const s: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h[i] = pts[i + 1].x - pts[i].x || 1e-9;
    s[i] = (pts[i + 1].y - pts[i].y) / h[i];
  }
  const t: number[] = new Array(n);
  for (let i = 1; i < n - 1; i++) {
    const p = (s[i - 1] * h[i] + s[i] * h[i - 1]) / (h[i - 1] + h[i]);
    t[i] =
      (Math.sign(s[i - 1]) + Math.sign(s[i])) *
        Math.min(Math.abs(s[i - 1]), Math.abs(s[i]), 0.5 * Math.abs(p)) || 0;
  }
  t[0] = (3 * s[0] - t[1]) / 2;
  t[n - 1] = (3 * s[n - 2] - t[n - 2]) / 2;
  for (let i = 0; i < n - 1; i++) {
    const dx = h[i] / 3;
    d += `C${f(pts[i].x + dx)},${f(pts[i].y + dx * t[i])} ${f(pts[i + 1].x - dx)},${f(pts[i + 1].y - dx * t[i + 1])} ${f(pts[i + 1].x)},${f(pts[i + 1].y)}`;
  }
  return d;
}

// 1px visible halo (stroke is centered, so width 2) matching the card
// background so labels stay readable over chart lines.
export const CHART_TEXT_HALO = {
  stroke: "var(--surface)",
  strokeWidth: 2,
  paintOrder: "stroke",
} as const;

// viewBox width tracks rendered width (height stays fixed) so chart text
// renders 1:1 at the same font size as the rest of the UI. Callback ref, not
// effect: charts often mount behind a loading state, so the svg may not exist
// on first commit — measure whenever the node actually attaches.
// ponytail: window resize only, no ResizeObserver — container-only resizes
// (no viewport change) are not tracked; add RO back if a layout needs it.
export function useSvgWidth(
  fallback: number,
  fallbackH = 0, // pass when the svg fills its container (h-full) instead of a fixed height
): {
  W: number;
  H: number;
  svgRef: RefObject<SVGSVGElement | null>;
  setSvgRef: (el: SVGSVGElement | null) => void;
} {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [W, setW] = useState(fallback);
  const [H, setH] = useState(fallbackH);
  const measure = useCallback(() => {
    const w = svgRef.current?.clientWidth ?? 0;
    if (w > 0) setW(w); // 0 = hidden/unlaid-out; keep last known width
    const h = svgRef.current?.clientHeight ?? 0;
    if (h > 0) setH(h);
  }, []);
  const setSvgRef = useCallback(
    (el: SVGSVGElement | null) => {
      svgRef.current = el;
      measure();
    },
    [measure],
  );
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);
  return { W, H, svgRef, setSvgRef };
}

export function fmtHoverTime(t: number, timeZone?: string): string {
  const d = new Date(t);
  const day = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone,
  });
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
  return `${day} at ${time}`;
}

export function nearestPoint<P extends { t: number }>(pts: P[], t: number): P {
  return pts.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
}
