"use client";

import { useEffect, useState } from "react";
import type { AllMids } from "./types";

const DEFAULT_INTERVAL_MS = 2500;

// allMids is a ~15 KB map and every consumer wants the same one, so a single
// loop feeds all of them — a market page mounts this hook two or three times.
// ponytail: first subscriber's interval wins; make it a min() across
// subscribers if a caller ever needs a genuinely faster tick than another.
let latest: AllMids | null = null;
const subscribers = new Set<(mids: AllMids) => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

function startPolling(intervalMs: number) {
  const tick = async () => {
    try {
      const res = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "allMids" }),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as AllMids;
      latest = data;
      for (const notify of subscribers) notify(data);
    } catch {
      /* keep the last good map */
    } finally {
      timer = subscribers.size > 0 ? setTimeout(tick, intervalMs) : undefined;
    }
  };
  timer = setTimeout(tick, intervalMs);
}

export function useLiveMids(
  initial: AllMids,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): { mids: AllMids } {
  // `latest` is null during SSR and on the first client render of a fresh
  // load, so the server HTML and the hydrating render both use `initial`.
  const [mids, setMids] = useState<AllMids>(() => latest ?? initial);

  useEffect(() => {
    if (latest) setMids(latest);
    subscribers.add(setMids);
    if (!timer) startPolling(intervalMs);
    return () => {
      subscribers.delete(setMids);
      if (subscribers.size === 0 && timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
  }, [intervalMs]);

  return { mids };
}

/** Mid for one coin, or null when it isn't quoted. */
export function midOf(mids: AllMids, coin: string): number | null {
  const raw = mids[coin];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
