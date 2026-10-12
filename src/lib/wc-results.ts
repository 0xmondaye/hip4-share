// .ts extensions so the file also runs under node --experimental-strip-types (tests)
import { flagCode } from "./flags.ts";
import { WC_SEED, WC_SEED_MAX_ID } from "./wc-results-seed.ts";

/** One settled outcome, flattened from the `settledOutcome` info response. */
export type SettledRow = {
  id: number;
  name: string;
  sides: string[];
  /** Settle fraction of side 0 ("Yes" for Yes/No markets). */
  fraction: number;
  details: string;
};

export type MatchResult = {
  /** Highest outcome id of the match — settlement-order key, newest = biggest. */
  id: number;
  /** "Quarterfinal" etc. from "World Cup X: A vs B" names; null for older formats. */
  stage: string | null;
  teams: [string, string];
  /** Winning team name, or null for a draw. */
  winner: string | null;
  /** "1–1" when the settlement details carry a score. */
  score: string | null;
};

const isTeam = (n: string) => flagCode(n) !== null;

function scoreOf(details: string): string | null {
  const m = details.match(/(\d+)-(\d+)/);
  return m ? `${m[1]}–${m[2]}` : null;
}

/**
 * Rebuild finished World Cup matches from settled outcomes. HIP-4 has used
 * two market shapes:
 *  - single outcome "World Cup Quarterfinal: A vs B" with the teams as sides;
 *  - one Yes/No outcome per team (group stage adds a Draw outcome), where a
 *    match's outcomes share one `details` sentence and adjacent ids.
 */
export function worldCupResults(rows: SettledRow[]): MatchResult[] {
  const out: MatchResult[] = [];
  const multi: SettledRow[] = [];

  for (const r of rows) {
    const m = r.name.match(/^World Cup ([^:]+): (.+) vs .+$/);
    if (m && r.sides.length === 2 && !r.sides.includes("Yes")) {
      out.push({
        id: r.id,
        stage: m[1],
        teams: [r.sides[0], r.sides[1]],
        winner: r.fraction >= 0.5 ? r.sides[0] : r.sides[1],
        score: scoreOf(r.details),
      });
    } else if (
      r.sides[0] === "Yes" &&
      (isTeam(r.name) || r.name === "Draw")
    ) {
      multi.push(r);
    }
  }

  // Group adjacent per-team outcomes sharing the same details sentence.
  multi.sort((a, b) => a.id - b.id);
  let group: SettledRow[] = [];
  const flush = () => {
    const g = group;
    group = [];
    const teams = g.filter((r) => r.name !== "Draw").map((r) => r.name);
    if (teams.length !== 2) return; // partial data (missing side) — skip
    const winRow = g.find((r) => r.fraction >= 0.5);
    const drew = winRow?.name === "Draw" || /\bdrew\b/i.test(g[0].details);
    if (!drew && !winRow) return; // winner row missing — skip
    out.push({
      id: g[g.length - 1].id,
      stage: null,
      teams: [teams[0], teams[1]],
      winner: drew ? null : winRow!.name,
      score: scoreOf(g[0].details),
    });
  };
  for (const r of multi) {
    const prev = group[group.length - 1];
    if (prev && (r.details !== prev.details || r.id - prev.id > 3)) flush();
    group.push(r);
  }
  flush();

  return out.sort((a, b) => b.id - a.id); // newest first
}

async function fetchSettled(id: number): Promise<SettledRow | null> {
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "settledOutcome", outcome: id }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const r = (await res.json()) as {
      spec: { name: string; sideSpecs: { name: string }[] };
      settleFraction: string;
      details: string;
    } | null;
    if (!r) return null;
    return {
      id,
      name: r.spec.name,
      sides: r.spec.sideSpecs.map((s) => s.name),
      fraction: Number(r.settleFraction),
      details: r.details,
    };
  } catch {
    return null;
  }
}

/**
 * Finished World Cup matches: frozen seed history + a scan of settled
 * outcomes after the seed. No bulk settled endpoint exists, so recent ids
 * are probed one by one — the seed keeps that window small (~tens of ids,
 * well under the 1200 weight/min IP budget the page's own calls share).
 * Callers must cache the result (page uses unstable_cache).
 * ponytail: seed is frozen at build time — regenerate wc-results-seed.ts
 * after the tournament if the scan window ever grows past a few hundred ids.
 */
export async function fetchWorldCupResults(maxId: number): Promise<MatchResult[]> {
  const ids: number[] = [];
  for (let i = maxId; i > WC_SEED_MAX_ID; i--) ids.push(i); // newest first
  const rows: SettledRow[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const r = await fetchSettled(ids[cursor++]);
      if (r) rows.push(r);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return [...worldCupResults(rows), ...WC_SEED].sort((a, b) => b.id - a.id);
}
