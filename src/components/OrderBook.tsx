"use client";

import { useEffect, useRef, useState } from "react";
import { groupLevels, type L2Book } from "@/lib/types";
import { Card } from "@/components/ui/card";

interface OrderBookProps {
  coin: string;
  sideLabel: string;
  initial: L2Book | null;
  intervalMs?: number;
}

function cents(px: string | number): string {
  const c = Number(px) * 100;
  const s = c.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `${s}¢`;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

type Row = { px: number; sz: number; total: number };

const SCALES = [0.001, 0.01, 0.1, 1, 10]; // in cents

function withTotals(levels: { px: number; sz: number }[]): Row[] {
  let total = 0;
  return levels.slice(0, 8).map(({ px, sz }) => {
    total += px * sz;
    return { px, sz, total };
  });
}

export function OrderBook({
  coin,
  sideLabel,
  initial,
  intervalMs = 2000,
}: OrderBookProps) {
  const [book, setBook] = useState<L2Book | null>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [scale, setScale] = useState(1); // cents per bucket
  const aborted = useRef(false);

  useEffect(() => {
    aborted.current = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const res = await fetch("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "l2Book", coin }),
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as L2Book;
        if (aborted.current) return;
        setBook(data);
        setErr(null);
      } catch (e) {
        if (!aborted.current)
          setErr(e instanceof Error ? e.message : "fetch error");
      } finally {
        if (!aborted.current) timer = setTimeout(tick, intervalMs);
      }
    };
    timer = setTimeout(tick, intervalMs);
    return () => {
      aborted.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [coin, intervalMs]);

  const tick = scale / 100; // cents → dollars
  const bids = withTotals(groupLevels(book?.levels?.[0] ?? [], tick, "bid"));
  const asks = withTotals(groupLevels(book?.levels?.[1] ?? [], tick, "ask"));
  const bb = bids[0]?.px;
  const ba = asks[0]?.px;
  const spread =
    bb !== undefined && ba !== undefined ? cents(ba - bb) : null;

  return (
    <Card className="rounded-2xl bg-surface py-0 gap-0 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold">Order Book</h3>
        <div className="flex items-center gap-2">
          {err && <span className="text-xs text-no">err: {err}</span>}
          <span className="text-xs text-muted-foreground">{sideLabel}</span>
          <select
            aria-label="Price scale"
            value={scale}
            onChange={(e) => setScale(Number(e.target.value))}
            className="bg-surface-2 border border-border rounded-md px-2 py-1 text-xs font-mono text-foreground"
          >
            {SCALES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-3 px-4 py-1.5 text-xs uppercase tracking-wider text-muted-foreground">
        <span>Price</span>
        <span className="text-right">Shares</span>
        <span className="text-right">Total</span>
      </div>
      <BookRows rows={[...asks].reverse()} variant="ask" />
      <div className="relative grid grid-cols-3 px-4 py-1.5 text-xs font-mono bg-surface-2/60 border-y border-border">
        <span className="font-heading">{spread ?? "—"}</span>
        <span />
        <span className="text-right text-muted-foreground">Spread</span>
      </div>
      <BookRows rows={bids} variant="bid" />
      {!book && (
        <div className="px-4 py-6 text-center text-xs">
          <span className="t-shimmer" data-text="Loading book…">
            Loading book…
          </span>
        </div>
      )}
    </Card>
  );
}

function BookRows({ rows, variant }: { rows: Row[]; variant: "bid" | "ask" }) {
  // ponytail: fixed 8-row height (24px/row) so live row-count changes don't jitter the page grid
  if (rows.length === 0) {
    return (
      <div className="min-h-[192px] flex items-center justify-center text-xs text-muted-foreground">
        no {variant === "bid" ? "bids" : "asks"}
      </div>
    );
  }
  const maxTotal = Math.max(1, ...rows.map((r) => r.total));
  const color = variant === "bid" ? "text-yes" : "text-no";
  const fill = variant === "bid" ? "bg-yes/10" : "bg-no/10";
  return (
    <div className="min-h-[192px]">
      {rows.map((r, i) => (
        <div
          key={`${variant}-${i}-${r.px}`}
          className="relative grid grid-cols-3 px-4 py-1 text-xs font-mono tabular-nums"
        >
          <div
            className={`absolute inset-y-0 left-0 ${fill}`}
            style={{ width: `${(r.total / maxTotal) * 100}%` }}
          />
          <span className={`relative font-heading font-semibold ${color}`}>
            {cents(r.px)}
          </span>
          <span className="relative text-right">{fmtInt(r.sz)}</span>
          <span className="relative text-right text-muted-foreground font-heading">
            ${fmtInt(r.total)}
          </span>
        </div>
      ))}
    </div>
  );
}
