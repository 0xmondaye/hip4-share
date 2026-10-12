"use client";

import { useEffect, useState } from "react";
import { formatVolume, nextGoal } from "@/lib/leaderboard";

// Client-side fetch by request; creds live in /api/leaderboard proxy.
const MEDALS: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" };

type Row = {
  rank: number;
  name: string;
  address: string;
  tradeCount: number;
  hip4VolumeUSDC: number;
};

const TABS = [
  { metric: "volume", label: "Bets", blurb: "Top bettors by USDC volume. Updates every 5 minutes." },
  { metric: "packs", label: "Packs", blurb: "Top pack spenders. Updates every minute." },
] as const;

export default function LeaderboardPage() {
  const [metric, setMetric] = useState<(typeof TABS)[number]["metric"]>("volume");
  const [rows, setRows] = useState<Row[] | null | undefined>(undefined);
  useEffect(() => {
    setRows(undefined);
    fetch(`/api/leaderboard?metric=${metric}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { rows?: Row[] } | null) =>
        setRows(Array.isArray(d?.rows) ? d.rows : null),
      )
      .catch(() => setRows(null));
  }, [metric]);
  const packs = metric === "packs";
  return (
    <div className="mx-auto w-full max-w-2xl">
      <h1 className="font-heading text-2xl mb-1">Leaderboard</h1>
      <p className="text-xs text-muted-foreground mb-3">
        {TABS.find((t) => t.metric === metric)!.blurb}
      </p>
      <div className="flex gap-1 mb-5 p-1 rounded-full bg-surface-2/60 w-fit">
        {TABS.map((t) => (
          <button
            key={t.metric}
            onClick={() => setMetric(t.metric)}
            aria-pressed={metric === t.metric}
            className={`px-4 py-1.5 rounded-full text-sm transition ${
              metric === t.metric
                ? "bg-brand text-black font-medium"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {rows === undefined ? (
        <div className="rounded-2xl border border-border bg-surface p-8 text-center text-sm text-muted-foreground">
          Loading…
        </div>
      ) : !rows?.length ? (
        <div className="rounded-2xl border border-border bg-surface p-8 text-center text-sm text-muted-foreground">
          {/* empty is not broken: a fresh packs board really has nobody on it */}
          {rows
            ? "Nobody on the board yet. Pull a pack to be first."
            : "Leaderboard is unavailable right now. Check back soon."}
        </div>
      ) : (
        <>
          {!packs &&
            (() => {
              const goal = nextGoal(rows[0].hip4VolumeUSDC);
              const pct = {
                "--pct": `${Math.min(100, (rows[0].hip4VolumeUSDC / goal) * 100)}%`,
              } as React.CSSProperties;
              return (
            <div className="mb-4">
              <div className="flex items-end justify-between mb-1">
                <span className="text-xs text-muted-foreground">
                  Road to glory
                </span>
                <span
                  className="font-heading text-3xl leading-none goal-shimmer"
                  style={pct}
                >
                  {formatVolume(goal)}
                </span>
              </div>
              <div className="liquid-chart">
                <div className="bar3d" style={pct}>
                  <div className="face top">
                    <div className="growing-bar" />
                  </div>
                  <div className="face side-0">
                    <div className="growing-bar" />
                  </div>
                  <div className="face floor">
                    <div className="growing-bar" />
                  </div>
                  <div className="face side-a" />
                  <div className="face side-b" />
                  <div className="face side-1">
                    <div className="growing-bar" />
                  </div>
                </div>
              </div>
            </div>
              );
            })()}
        <div className="rounded-2xl border border-border bg-surface overflow-hidden">
          <div className="grid grid-cols-[3rem_1fr_4rem_6rem] px-4 py-2 text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border">
            <span>#</span>
            <span>{packs ? "Puller" : "Bettor"}</span>
            <span className="text-right">{packs ? "Pulls" : "Bets"}</span>
            <span className="text-right">{packs ? "Spent" : "Volume"}</span>
          </div>
          <div className="divide-y divide-border">
            {rows.map((r) => (
              <div
                key={r.rank}
                className="grid grid-cols-[3rem_1fr_4rem_6rem] items-center px-4 py-3 text-sm hover:bg-surface-2/60 transition"
              >
                <span className={r.rank <= 3 ? "" : "text-muted-foreground"}>
                  {MEDALS[r.rank] ?? r.rank}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{r.name}</span>
                  {r.address ? (
                    <span className="block text-[11px] text-muted-foreground font-mono">
                      {r.address}
                    </span>
                  ) : null}
                </span>
                <span className="text-right text-muted-foreground font-heading font-semibold">
                  {r.tradeCount}
                </span>
                <span className="text-right font-heading font-semibold">
                  {formatVolume(r.hip4VolumeUSDC)}
                </span>
              </div>
            ))}
          </div>
        </div>
        </>
      )}
    </div>
  );
}
