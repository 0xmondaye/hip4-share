"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { AllMids } from "@/lib/types";
import { useLiveMids } from "@/lib/useLiveMids";
import { FlagImg } from "./FlagImg";
import { SportsLogo } from "./SportsLogo";
import { Card } from "@/components/ui/card";

export type EventOutcomeRow = {
  id: number;
  name: string;
  coin: string;
  href: string;
};

function pct(mid: number | null): string {
  if (mid === null || !Number.isFinite(mid)) return "—";
  const p = mid * 100;
  if (p > 0 && p < 1) return "<1%";
  if (p > 99 && p < 100) return ">99%";
  return `${Math.round(p)}%`;
}

/** Right-hand outcomes panel for a multi-outcome question. */
export function EventOutcomes({
  rows,
  selectedId,
  initialMids,
  keepOrder = false,
  sports = false,
}: {
  rows: EventOutcomeRow[];
  selectedId: number;
  initialMids: AllMids;
  /** true = preserve given order (price buckets); false = live-sort by mid */
  keepOrder?: boolean;
  sports?: boolean;
}) {
  const { mids } = useLiveMids(initialMids);
  const [vols, setVols] = useState<Record<string, number>>({});

  useEffect(() => {
    let dead = false;
    const end = Date.now();
    // ponytail: cap vol fetches at 12 coins — enough for the visible list
    const coins = rows.slice(0, 12).map((r) => r.coin);
    (async () => {
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
            });
            const ks = (await res.json()) as { c: string; v: string }[];
            return [
              coin,
              ks.reduce((acc, k) => acc + Number(k.v) * Number(k.c), 0),
            ] as const;
          } catch {
            return [coin, 0] as const;
          }
        }),
      );
      if (!dead) setVols(Object.fromEntries(entries));
    })();
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.map((r) => r.coin).join(",")]);

  const live = rows.map((r) => ({
    ...r,
    mid: mids[r.coin] !== undefined ? Number(mids[r.coin]) : null,
  }));
  if (!keepOrder) live.sort((a, b) => (b.mid ?? -1) - (a.mid ?? -1));

  return (
    <Card className="rounded-2xl bg-surface p-3 gap-0">
      <h2 className="text-sm font-semibold px-1 pb-2">Outcomes</h2>
      <div className="space-y-1.5 max-h-[560px] overflow-y-auto">
        {live.map((r) => {
          const active = r.id === selectedId;
          return (
            <Link
              key={r.id}
              href={r.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-start justify-between gap-2.5 rounded-xl border px-2 py-2 transition ${
                active
                  ? "border-foreground/40 bg-surface-2"
                  : "border-transparent hover:bg-surface-2/60"
              }`}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                {sports && <SportsLogo name={r.name} />}
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate">
                    {!sports && <FlagImg name={r.name} className="h-3.5 rounded-[3px] mr-1.5" />}
                    {r.name}
                  </div>
                  <div className="text-xs text-muted-foreground font-heading tabular-nums mt-0.5">
                    {vols[r.coin] !== undefined && vols[r.coin] > 0
                      ? `$${Math.round(vols[r.coin]).toLocaleString("en-US")} Vol.`
                      : " "}
                  </div>
                </div>
              </div>
              <span className="font-mono tabular-nums font-semibold shrink-0">
                {pct(r.mid)}
              </span>
            </Link>
          );
        })}
      </div>
    </Card>
  );
}
