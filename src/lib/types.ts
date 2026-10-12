export type SideSpec = { name: string };

export type Outcome = {
  outcome: number;
  name: string;
  description: string;
  sideSpecs: SideSpec[];
  quoteToken: string;
  /** Deployer address for permissionless (template-deployed) markets; absent = first-party. */
  deployer?: string;
  /** Registry category ("price", "economics", "sports") for a template ref. */
  templateCategory?: string;
  /** Raw template keyword args (perp, target, time, …) for templated markets. */
  templateArgs?: Record<string, string>;
};

export type Question = {
  question: number;
  name: string;
  description: string;
  fallbackOutcome: number;
  namedOutcomes: number[];
  settledNamedOutcomes: number[];
  /** Registry category ("price", "economics", "sports") for a template ref. */
  templateCategory?: string;
  /** Raw template keyword args for templated questions. */
  templateArgs?: Record<string, string>;
};

export type OutcomeMeta = {
  outcomes: Outcome[];
  questions: Question[];
};

// ponytail: first-party markets only — permissionless HIP-4 deployers share
// outcomeMeta's namespace (live since 2026-08-29); swap for a deployer
// allowlist if we ever list third-party or self-deployed markets.
export function firstPartyOnly(meta: OutcomeMeta): OutcomeMeta {
  const outcomes = meta.outcomes.filter((o) => !o.deployer);
  const ids = new Set(outcomes.map((o) => o.outcome));
  return {
    outcomes,
    questions: meta.questions.filter(
      (q) =>
        q.namedOutcomes.some((id) => ids.has(id)) || ids.has(q.fallbackOutcome),
    ),
  };
}

export type AllMids = Record<string, string>;

export type L2Level = { px: string; sz: string; n: number };
export type L2Book = {
  coin: string;
  time: number;
  levels: [L2Level[], L2Level[]];
};

// Group book levels into price buckets of `tick` dollars.
// Bids round down, asks round up (conservative toward the spread).
export function groupLevels(
  levels: L2Level[],
  tick: number,
  side: "bid" | "ask",
): { px: number; sz: number }[] {
  const buckets = new Map<number, number>();
  for (const l of levels) {
    const px = Number(l.px);
    // integer bucket key avoids float-drift duplicate buckets
    const key =
      side === "bid" ? Math.floor(px / tick + 1e-9) : Math.ceil(px / tick - 1e-9);
    buckets.set(key, (buckets.get(key) ?? 0) + Number(l.sz));
  }
  return [...buckets]
    .map(([k, sz]) => ({ px: k * tick, sz }))
    .sort((a, b) => (side === "bid" ? b.px - a.px : a.px - b.px));
}

export type SidePrice = {
  outcomeId: number;
  sideIdx: number;
  sideName: string;
  coin: string;
  mid: number | null;
};

export type EnrichedOutcome = Outcome & {
  sides: SidePrice[];
  parsedMeta: Record<string, string> | null;
};

export type EnrichedQuestion = Question & {
  outcomes: EnrichedOutcome[];
  fallback: EnrichedOutcome | null;
};

export function coinFor(outcomeId: number, sideIdx: number): string {
  return `#${outcomeId * 10 + sideIdx}`;
}

export interface OutcomePosition {
  /** Market coin, "#7501" — outcomeId*10 + sideIdx, same as the order coin. */
  coin: string;
  /** Shares held. */
  total: number;
  /** Shares locked in open orders. */
  hold: number;
  /** USDC paid for the current holding; entry price = entryNtl / total. */
  entryNtl: number;
  /** Market settled, shares awaiting auto-conversion to quote tokens. */
  settled?: boolean;
}

/**
 * Outcome shares appear in spotClearinghouseState as "+NNNN" balances;
 * "oNNNN" is the same position after settlement, briefly held while the
 * chain converts it to quote tokens — keep it visible instead of having
 * the position vanish before the USDC lands.
 */
export function parseOutcomePositions(
  balances: { coin: string; total: string; hold: string; entryNtl: string }[],
): OutcomePosition[] {
  return balances
    .filter((b) => /^[+o]\d+$/.test(b.coin) && Number(b.total) > 0)
    .map((b) => ({
      coin: `#${b.coin.slice(1)}`,
      total: Number(b.total),
      hold: Number(b.hold),
      entryNtl: Number(b.entryNtl),
      ...(b.coin.startsWith("o") ? { settled: true } : {}),
    }));
}

/**
 * Current USDC value of outcome holdings. A position with no mid yet is
 * valued at cost (entryNtl) — better than pricing real shares at $0.
 */
export function positionsValue(
  positions: OutcomePosition[],
  mids: Record<string, string>,
): number {
  return positions.reduce((acc, p) => {
    const mid = mids[p.coin] !== undefined ? Number(mids[p.coin]) : null;
    return acc + (mid !== null && Number.isFinite(mid) ? p.total * mid : p.entryNtl);
  }, 0);
}

export const COIN_NAMES: Record<string, string> = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana",
  HYPE: "HYPE",
};

export function marketDisplayName(
  name: string,
  parsedMeta: Record<string, string> | null,
): string {
  if (parsedMeta?.class === "priceBinary") {
    const u = parsedMeta.underlying ?? "";
    return `${COIN_NAMES[u] ?? u} Up or Down Daily`;
  }
  return name;
}

/** Thresholds from a priceBucket question's parsed description. */
export function bucketThresholds(
  qMeta: Record<string, string> | null,
): number[] {
  return (qMeta?.priceThresholds ?? "")
    .split(",")
    .map(Number)
    .filter(Number.isFinite);
}

/** Bucket outcome's position, from its "index:N" description. */
export function outcomeIndex(desc: string): number {
  return Number(desc.match(/index:(\d+)/)?.[1] ?? 0);
}

/** "↓ $61,476" / "$61,476 – $63,985" / "↑ $63,985" — buckets are <P1, [P1,P2), ≥P2. */
export function bucketLabel(thresholds: number[], idx: number): string {
  const fmt = (n: number) => `$${n.toLocaleString("en-US")}`;
  if (thresholds.length === 0) return `Outcome ${idx + 1}`;
  if (idx === 0) return `↓ ${fmt(thresholds[0])}`;
  if (idx >= thresholds.length)
    return `↑ ${fmt(thresholds[thresholds.length - 1])}`;
  return `${fmt(thresholds[idx - 1])} – ${fmt(thresholds[idx])}`;
}

/** "Bitcoin Multi Outcomes Daily" — display title for a priceBucket question. */
export function bucketTitle(qMeta: Record<string, string> | null): string {
  const u = qMeta?.underlying ?? "?";
  return `${COIN_NAMES[u] ?? u} Multi Outcomes Daily`;
}

export type MarketCat = "crypto" | "economics" | "sports";

export function isSports(text: string): boolean {
  return /world cup/i.test(text);
}

function catOfTemplate(templateCategory: string): MarketCat {
  if (templateCategory === "sports") return "sports";
  return templateCategory === "economics" ? "economics" : "crypto";
}

export function catOfOutcome(o: {
  name: string;
  description: string;
  parsedMeta: Record<string, string> | null;
  templateCategory?: string;
}): MarketCat {
  if (o.templateCategory) return catOfTemplate(o.templateCategory);
  if (isSports(o.name + o.description)) return "sports";
  if (o.parsedMeta?.class) return "crypto";
  return "economics";
}

export function catOfQuestion(q: {
  name: string;
  description: string;
  templateCategory?: string;
}): MarketCat {
  if (q.templateCategory) return catOfTemplate(q.templateCategory);
  if (q.description.includes("class:")) return "crypto";
  if (isSports(q.name + q.description)) return "sports";
  return "economics";
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * outcome.xyz-style path: /sports/q-32-2026-world-cup-champion?outcome=189.
 * q-{id} keys a question, o-{id} a loose outcome with no parent question.
 * Leading id is authoritative; slug is cosmetic — page redirects to canonical.
 */
export function marketPath(
  o: {
    outcome: number;
    name: string;
    description: string;
    parsedMeta: Record<string, string> | null;
  },
  q: {
    question: number;
    name: string;
    description: string;
    namedOutcomes: number[];
  } | null = null,
): string {
  if (q) {
    const qm = parseRecurringDescription(q.description);
    const title = qm?.class === "priceBucket" ? bucketTitle(qm) : q.name;
    const slug = slugify(title);
    const path = `/${catOfQuestion(q)}/q-${q.question}${slug ? `-${slug}` : ""}`;
    return q.namedOutcomes.length > 1 ? `${path}?outcome=${o.outcome}` : path;
  }
  const slug = slugify(marketDisplayName(o.name, o.parsedMeta));
  return `/${catOfOutcome(o)}/o-${o.outcome}${slug ? `-${slug}` : ""}`;
}

/** Pair consecutive settles into rows: did the price close up vs the prior settle? */
export function dailyResults(
  settles: { time: number; price: number }[],
): { time: number; price: number; prior: number; up: boolean }[] {
  const rows = [];
  for (let i = 1; i < settles.length; i++) {
    rows.push({
      time: settles[i].time,
      price: settles[i].price,
      prior: settles[i - 1].price,
      // ponytail: settle rule assumed >= (Yes wins ties) — matches HIP-4 "above or at" phrasing
      up: settles[i].price >= settles[i - 1].price,
    });
  }
  return rows.reverse(); // newest first
}

/** "20260705-0600" (UTC) → epoch ms, or null. */
export function parseExpiry(s: string | undefined): number | null {
  if (!s || !/^\d{8}-\d{4}$/.test(s)) return null;
  return Date.UTC(
    Number(s.slice(0, 4)),
    Number(s.slice(4, 6)) - 1,
    Number(s.slice(6, 8)),
    Number(s.slice(9, 11)),
    Number(s.slice(11, 13)),
  );
}

/** Template kickoff in UTC, falling back to legacy date-only match prose. */
export function parseMatchDate(desc: string, scheduledStart?: string): Date | null {
  const ms = parseExpiry(scheduledStart);
  if (ms !== null) return new Date(ms);
  const m = desc.match(/scheduled for ([A-Za-z]+ \d{1,2}, \d{4})/);
  if (!m) return null;
  const d = new Date(`${m[1]} UTC`);
  return Number.isNaN(+d) ? null : d;
}

/**
 * Match status without a score feed. Descriptions carry a date only (no
 * kickoff time), so midnight UTC on match day must NOT mean "Live".
 * ponytail: "Live" inferred from recent price movement — in-play prediction
 * markets swing, pre-match books are flat. Quiet stretch mid-match can read
 * "Not Started"; add a real fixtures feed if that matters.
 */
export function matchStatus(
  mid: number | null,
  kickoffMs: number | null,
  now: number,
  recentMids: number[], // mids from the last ~15 min
): "Ended" | "Live" | "Not Started" {
  if (mid !== null && (mid >= 0.999 || mid <= 0.001)) return "Ended";
  if (kickoffMs !== null && now < kickoffMs) return "Not Started";
  const inPlay =
    recentMids.length >= 2 &&
    Math.max(...recentMids) - Math.min(...recentMids) > 0.02;
  return inPlay ? "Live" : "Not Started";
}

/** One entry from the info { type: "outcomeTemplates" } registry. */
export type OutcomeTemplate = {
  id: string;
  name: string;
  description: string;
  keywords?: [string, string][];
};

/** "20260916-1800" → "Sep 16, 2026, 18:00 UTC"; "100000" → "100,000"; else raw. */
function fmtTemplateValue(v: string, hint?: string): string {
  // Numeric-looking strings (season "2026", short names) stay literal.
  if (hint && !["dateTime", "uInt", "uDecimal"].includes(hint)) return v;
  const ms = parseExpiry(v);
  if (ms !== null) {
    const d = new Date(ms);
    const date = d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${date}, ${hh}:${mm} UTC`;
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v).toLocaleString("en-US");
  return v;
}

/**
 * Expand HIP-4 templated markets. A templated question/outcome ships with
 * name "template:<id>" and a description holding only keyword:value|... args;
 * the display text lives in the outcomeTemplates registry as {keyword}
 * placeholders. Rewrites name/description in place so everything downstream
 * (titles, slugs, categories) sees plain text. Unknown template ids are left
 * raw rather than guessed at.
 */
export function expandTemplates(
  meta: OutcomeMeta,
  templates: OutcomeTemplate[],
): OutcomeMeta {
  if (templates.length === 0) return meta;
  const byId = new Map(templates.map((t) => [t.id, t]));

  function expand<T extends Outcome | Question>(x: T): T {
    if (!x.name.startsWith("template:")) return x;
    const t = byId.get(x.name.slice("template:".length));
    if (!t) return x;
    const hints = new Map(t.keywords);
    const args: Record<string, string> = {};
    for (const part of x.description.split("|")) {
      const i = part.indexOf(":");
      if (i > 0) args[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    const sub = (s: string) =>
      s
        .replace(/\{(\w+)\}/g, (m, k: string) =>
          Object.hasOwn(args, k) ? fmtTemplateValue(args[k], hints.get(k)) : m,
        )
        // registry text often reads "{time} UTC" — our dateTime rendering
        // already ends in UTC, so collapse the doubled suffix
        .replace(/UTC UTC\b/g, "UTC");
    // registry description carries a "metadata=category:...|..." tail meant
    // for deployers, not traders — split it off the market rules text
    const [rules, metaTail] = t.description.split("metadata=");
    return {
      ...x,
      name: sub(t.name),
      description: sub(rules).trim(),
      templateCategory: metaTail?.match(/category:(\w+)/)?.[1],
      templateArgs: args,
      ...("sideSpecs" in x
        ? {
            sideSpecs: x.sideSpecs.map((s) =>
              s.name.startsWith("template:")
                ? { ...s, name: sub(s.name.slice("template:".length)) }
                : s,
            ),
          }
        : {}),
    };
  }

  return {
    ...meta,
    outcomes: meta.outcomes.map(expand),
    questions: meta.questions.map(expand),
  };
}

export function parseRecurringDescription(
  desc: string,
): Record<string, string> | null {
  if (!desc.includes("|") || !desc.includes(":")) return null;
  const out: Record<string, string> = {};
  for (const part of desc.split("|")) {
    const [k, ...rest] = part.split(":");
    if (!k || rest.length === 0) continue;
    out[k.trim()] = rest.join(":").trim();
  }
  // only structured recurring descriptors count — prose containing "|" and ":" does not
  return out.class ? out : null;
}
