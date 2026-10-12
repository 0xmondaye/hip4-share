import type {
  AllMids,
  EnrichedOutcome,
  EnrichedQuestion,
  L2Book,
  OutcomeMeta,
  OutcomeTemplate,
} from "./types.ts";
import {
  coinFor,
  expandTemplates,
  firstPartyOnly,
  parseOutcomePositions,
  parseRecurringDescription,
  type OutcomePosition,
} from "./types.ts";

export type { OutcomePosition };

const BASE = "https://api.hyperliquid.xyz/info";

async function info<T>(body: object, init?: RequestInit): Promise<T> {
  // HL rate-limits per IP; serverless egress IPs are shared, so 429s are
  // routine on Vercel — retry briefly instead of 500ing the page render.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...init,
    });
    if (res.ok) return (await res.json()) as T;
    if (res.status !== 429 || attempt >= 2) {
      throw new Error(`Hyperliquid ${res.status}: ${await res.text()}`);
    }
    await new Promise((r) => setTimeout(r, 250 * 3 ** attempt)); // 250ms, 750ms
  }
}

/** Client-safe generic info call (user-scoped queries live in components). */
export const hlInfo = info;

/**
 * The balance-read pair every money surface needs — one clearinghouseState +
 * one spotClearinghouseState. Exposes the components; callers sum per their
 * own display policy (the header shows total equity incl. positions, the pack
 * CTA shows only what a pull's funding leg can actually draw). Keep the
 * fetching here so an endpoint change lands once, not per component.
 */
export async function getBalanceParts(
  user: string,
  init: RequestInit = { cache: "no-store" },
): Promise<{
  perpsEquity: number;
  perpsWithdrawable: number;
  spotUsdc: { total: number; free: number };
  spotHype: number;
  positions: OutcomePosition[];
}> {
  const [perps, spot] = await Promise.all([
    info<{ marginSummary?: { accountValue?: string }; withdrawable?: string }>(
      { type: "clearinghouseState", user },
      init,
    ),
    getSpotState(user, init),
  ]);
  return {
    perpsEquity: Number(perps.marginSummary?.accountValue ?? 0),
    perpsWithdrawable: Number(perps.withdrawable ?? 0),
    spotUsdc: spot.usdc,
    spotHype: spot.hype,
    positions: spot.positions,
  };
}

/**
 * Has this account ever paid Hyperliquid's one-time $1 activation fee? Activation happens on
 * the first `send` that touches the account — inbound from another user (the sender pays) or
 * outbound (the account pays). Bridge deposits and HyperEVM system-address credits do NOT
 * activate, which is exactly the state of a guest whose only money arrived from the EVM side.
 * Verified 2026-09-06 against a live ledger (inbound Relay `send` → later outbound sends ok).
 * Fails open (true): a flaky info call must not shave $1 off an activated account's Max.
 */
export async function isHlActivated(user: string): Promise<boolean> {
  try {
    const updates = await info<{ delta?: { type?: string } }[]>(
      { type: "userNonFundingLedgerUpdates", user, startTime: 0 },
      { cache: "no-store" },
    );
    return updates.some((u) => u.delta?.type === "send");
  } catch {
    return true;
  }
}

/** Perps-account withdrawable USDC. */
export async function getPerpWithdrawable(user: string): Promise<number> {
  const s = await info<{ withdrawable?: string }>(
    { type: "clearinghouseState", user },
    { cache: "no-store" },
  );
  return Number(s.withdrawable ?? 0);
}

/** Spot USDC: total (incl. order holds) and free (total − hold). */
export async function getSpotUsdc(
  user: string,
): Promise<{ total: number; free: number }> {
  const s = await info<{
    balances: { coin: string; total: string; hold: string }[];
  }>({ type: "spotClearinghouseState", user }, { cache: "no-store" });
  const b = s.balances.find((x) => x.coin === "USDC");
  const total = Number(b?.total ?? 0);
  return { total, free: Math.max(0, total - Number(b?.hold ?? 0)) };
}

/**
 * Outcome share positions. They live in the SPOT clearinghouse as "+NNNN"
 * balances (clearinghouseState has no outcome data — don't query it for this).
 */
export async function getOutcomePositions(
  user: string,
  init?: RequestInit,
): Promise<OutcomePosition[]> {
  const s = await info<{
    balances: { coin: string; total: string; hold: string; entryNtl: string }[];
  }>({ type: "spotClearinghouseState", user }, init);
  return parseOutcomePositions(s.balances);
}

/** USDC balance + outcome positions from one spotClearinghouseState call. */
export async function getSpotState(
  user: string,
  init?: RequestInit,
): Promise<{
  usdc: { total: number; free: number };
  /** Free spot HYPE — a guest who sent HYPE here can send it on (SendHypeDialog). */
  hype: number;
  positions: OutcomePosition[];
}> {
  const s = await info<{
    balances: { coin: string; total: string; hold: string; entryNtl: string }[];
  }>({ type: "spotClearinghouseState", user }, init);
  const b = s.balances.find((x) => x.coin === "USDC");
  const total = Number(b?.total ?? 0);
  const h = s.balances.find((x) => x.coin === "HYPE");
  return {
    usdc: { total, free: Math.max(0, total - Number(b?.hold ?? 0)) },
    hype: Math.max(0, Number(h?.total ?? 0) - Number(h?.hold ?? 0)),
    positions: parseOutcomePositions(s.balances),
  };
}

export async function getOutcomeMeta(init?: RequestInit): Promise<OutcomeMeta> {
  // Templated markets (name "template:<id>") carry only keyword args in
  // their description; the display text lives in the templates registry.
  // A failed registry fetch degrades to raw template keys instead of erroring.
  const [meta, templates] = await Promise.all([
    info<OutcomeMeta>({ type: "outcomeMeta" }, init),
    info<OutcomeTemplate[]>({ type: "outcomeTemplates" }, init).catch(
      () => [] as OutcomeTemplate[],
    ),
  ]);
  return expandTemplates(firstPartyOnly(meta), templates);
}

export function getAllMids(init?: RequestInit): Promise<AllMids> {
  return info<AllMids>({ type: "allMids" }, init);
}

export function getL2Book(coin: string, init?: RequestInit): Promise<L2Book> {
  return info<L2Book>({ type: "l2Book", coin }, init);
}

/**
 * 24h traded USDC volume for a coin, summed from 1h candles.
 * Candle `v` is contracts traded; each contract locks $1 of USDC
 * (Yes payer p + No payer 1-p), so sum(v) is the market's dollar volume
 * and is identical on both side coins.
 */
export async function getVolume24h(
  coin: string,
  init?: RequestInit,
): Promise<number | null> {
  try {
    const end = Date.now();
    const ks = await info<{ v: string }[]>(
      {
        type: "candleSnapshot",
        req: { coin, interval: "1h", startTime: end - 24 * 3600_000, endTime: end },
      },
      init,
    );
    return ks.reduce((acc, k) => acc + Number(k.v), 0);
  } catch {
    return null;
  }
}

/** Raw close-price candles for a coin over [start, end]. */
export async function getCloses(
  coin: string,
  interval: string,
  startTime: number,
  endTime: number,
  init?: RequestInit,
): Promise<{ t: number; px: number }[]> {
  const ks = await info<{ t: number; c: string }[]>(
    { type: "candleSnapshot", req: { coin, interval, startTime, endTime } },
    init,
  );
  return ks
    .map((k) => ({ t: k.t, px: Number(k.c) }))
    .filter((p) => Number.isFinite(p.px));
}

/**
 * Historical settle prices for a recurring market's underlying, at the
 * settle time-of-day taken from expiry ("YYYYMMDD-HHMM", UTC).
 * ponytail: 1h candle close ≈ mark price at settle (few bps off) — exact
 * historical mark prices are not exposed by the API.
 */
export async function getSettleHistory(
  underlying: string,
  expiry: string,
  days = 30,
  init?: RequestInit,
): Promise<{ time: number; price: number }[]> {
  const hh = Number(expiry.slice(9, 11));
  const end = Date.now();
  const ks = await info<{ t: number; c: string }[]>(
    {
      type: "candleSnapshot",
      req: {
        coin: underlying,
        interval: "1h",
        startTime: end - (days + 1) * 86400_000,
        endTime: end,
      },
    },
    init,
  );
  return ks
    .filter((k) => {
      const settleAt = k.t + 3600_000; // candle close boundary
      return (
        settleAt <= end && new Date(settleAt).getUTCHours() === hh
      );
    })
    .map((k) => ({ time: k.t + 3600_000, price: Number(k.c) }));
}

export function enrichMarkets(
  meta: OutcomeMeta,
  mids: AllMids,
): {
  questions: EnrichedQuestion[];
  loose: EnrichedOutcome[];
} {
  const byId = new Map<number, EnrichedOutcome>();
  for (const o of meta.outcomes) {
    const sides = o.sideSpecs.map((s, idx) => {
      const coin = coinFor(o.outcome, idx);
      const raw = mids[coin];
      return {
        outcomeId: o.outcome,
        sideIdx: idx,
        sideName: s.name,
        coin,
        mid: raw !== undefined ? Number(raw) : null,
      };
    });
    byId.set(o.outcome, {
      ...o,
      sides,
      parsedMeta: parseRecurringDescription(o.description),
    });
  }

  const claimed = new Set<number>();
  const questions: EnrichedQuestion[] = meta.questions.map((q) => {
    const outcomes = q.namedOutcomes
      .map((id) => byId.get(id))
      .filter((o): o is EnrichedOutcome => Boolean(o));
    for (const id of q.namedOutcomes) claimed.add(id);
    if (q.fallbackOutcome) claimed.add(q.fallbackOutcome);
    return {
      ...q,
      outcomes,
      fallback: byId.get(q.fallbackOutcome) ?? null,
    };
  });

  const loose: EnrichedOutcome[] = [];
  for (const o of byId.values()) {
    if (!claimed.has(o.outcome)) loose.push(o);
  }

  return { questions, loose };
}
