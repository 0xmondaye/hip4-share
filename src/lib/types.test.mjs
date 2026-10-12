// run: node --experimental-strip-types src/lib/types.test.mjs
import assert from "node:assert";
import {
  firstPartyOnly,
  parseRecurringDescription,
  coinFor,
  marketPath,
  dailyResults,
  bucketLabel,
  bucketThresholds,
  bucketTitle,
  outcomeIndex,
  matchStatus,
  parseOutcomePositions,
  parseMatchDate,
} from "./types.ts";

// match status: date-only kickoff must not mean "Live" on match day
const day = Date.UTC(2026, 6, 5); // Jul 5 00:00 UTC
const flat = [0.7, 0.701, 0.699];
const moving = [0.7, 0.65, 0.74];
assert.equal(matchStatus(0.7, day, day - 3600_000, flat), "Not Started"); // day before
assert.equal(matchStatus(0.7, day, day + 8 * 3600_000, flat), "Not Started"); // match day, flat book
assert.equal(matchStatus(0.7, day, day + 18 * 3600_000, moving), "Live"); // prices swinging
assert.equal(matchStatus(0.9995, day, day + 20 * 3600_000, flat), "Ended"); // settled
assert.equal(matchStatus(null, null, day, []), "Not Started"); // no data, no claim

// structured recurring descriptor parses
const m = parseRecurringDescription(
  "class:priceBinary|underlying:BTC|expiry:20260705-0600|targetPrice:62464|period:1d",
);
assert.equal(m?.class, "priceBinary");
assert.equal(m?.underlying, "BTC");
assert.equal(m?.expiry, "20260705-0600");

// prose containing "|" and ":" must NOT parse (real R16 market descriptions do this)
assert.equal(
  parseRecurringDescription(
    "The market resolves to USA if FIFA officially declares USA the winner. Notes: a | b",
  ),
  null,
);

assert.equal(coinFor(740, 1), "#7401");

// SEO slug: /{category}/o-{id}-{slug}; id alone when name is all symbols
const looseO = (outcome, name, parsedMeta = null) => ({
  outcome,
  name,
  description: "",
  parsedMeta,
});
assert.equal(
  marketPath(looseO(123, "Will BTC hit $100K?")),
  "/economics/o-123-will-btc-hit-100k",
);
assert.equal(marketPath(looseO(9, "???")), "/economics/o-9");
assert.equal(
  marketPath(looseO(7, "BTC >= 62464", m)),
  "/crypto/o-7-bitcoin-up-or-down-daily",
);

// settle pairs: newest first, tie counts as up (Yes wins at >=)
const rows = dailyResults([
  { time: 1, price: 100 },
  { time: 2, price: 101 },
  { time: 3, price: 101 },
  { time: 4, price: 99 },
]);
assert.deepEqual(
  rows.map((r) => [r.time, r.up]),
  [
    [4, false],
    [3, true],
    [2, true],
  ],
);
// order book grouping: bids floor, asks ceil, sizes summed, sorted toward spread
import { groupLevels } from "./types.ts";
const lv = (px, sz) => ({ px: String(px), sz: String(sz), n: 1 });
assert.deepEqual(
  groupLevels([lv(0.64, 10), lv(0.643, 5), lv(0.61, 2)], 0.01, "bid"),
  [
    { px: 0.64, sz: 15 },
    { px: 0.61, sz: 2 },
  ],
);
assert.deepEqual(
  groupLevels([lv(0.652, 3), lv(0.66, 4)], 0.01, "ask"),
  [
    { px: 0.66, sz: 7 },
  ],
);
// exact-boundary price must not creep up a bucket (0.66 stays 0.66 on ask)
assert.deepEqual(groupLevels([lv(0.66, 1)], 0.01, "ask"), [{ px: 0.66, sz: 1 }]);

// price bucket labels: <P1, [P1,P2), ≥P2 per HIP-4 contract specs
const qm = parseRecurringDescription(
  "class:priceBucket|underlying:BTC|expiry:20260706-0600|priceThresholds:61476,63985|period:1d",
);
const th = bucketThresholds(qm);
assert.deepEqual(th, [61476, 63985]);
assert.equal(bucketLabel(th, 0), "↓ $61,476");
assert.equal(bucketLabel(th, 1), "$61,476 – $63,985");
assert.equal(bucketLabel(th, 2), "↑ $63,985");
assert.equal(bucketTitle(qm), "Bitcoin Multi Outcomes Daily");
assert.equal(outcomeIndex("index:2"), 2);

// question path: /{category}/q-{id}-{slug}; ?outcome= only when >1 named outcome
const bucketQ = {
  question: 758,
  name: "BTC buckets",
  description:
    "class:priceBucket|underlying:BTC|expiry:20260706-0600|priceThresholds:61476,63985|period:1d",
  namedOutcomes: [11],
};
assert.equal(
  marketPath(looseO(11, "index:0"), bucketQ),
  "/crypto/q-758-bitcoin-multi-outcomes-daily",
);
assert.equal(
  marketPath(looseO(11, "index:0"), { ...bucketQ, namedOutcomes: [11, 12] }),
  "/crypto/q-758-bitcoin-multi-outcomes-daily?outcome=11",
);
assert.equal(
  marketPath(looseO(189, "USA"), {
    question: 32,
    name: "2026 World Cup Champion",
    description: "Resolves to the winner of the 2026 FIFA World Cup.",
    namedOutcomes: [189, 190],
  }),
  "/sports/q-32-2026-world-cup-champion?outcome=189",
);

// outcome positions: spot "+NNNN" balances → "#NNNN" positions; settled
// "oNNNN" balances kept (flagged) until the chain converts them; USDC,
// zero-balance rows, and non-numeric coins are dropped
assert.deepStrictEqual(
  parseOutcomePositions([
    { coin: "USDC", total: "929.93", hold: "136.60", entryNtl: "0.0" },
    { coin: "o458", total: "0.0", hold: "0.0", entryNtl: "0.0" },
    { coin: "o459", total: "50.0", hold: "0.0", entryNtl: "20.0" },
    { coin: "oops", total: "5.0", hold: "0.0", entryNtl: "1.0" },
    { coin: "+7501", total: "100010.0", hold: "100010.0", entryNtl: "16.26" },
    { coin: "+7400", total: "0.0", hold: "0.0", entryNtl: "0.0" },
  ]),
  [
    { coin: "#459", total: 50, hold: 0, entryNtl: 20, settled: true },
    { coin: "#7501", total: 100010, hold: 100010, entryNtl: 16.26 },
  ],
);

// position value: shares × mid when priced, cost basis when no mid yet
import { positionsValue } from "./types.ts";
const pos = (coin, total, entryNtl) => ({ coin, total, hold: 0, entryNtl });
assert.equal(
  positionsValue(
    [pos("#7501", 200, 100), pos("#7401", 100, 100)],
    { "#7501": "0.6", "#7401": "0.9" },
  ),
  200 * 0.6 + 100 * 0.9,
);
assert.equal(positionsValue([pos("#7501", 200, 100)], {}), 100); // no mid → entry cost
assert.equal(positionsValue([], { "#7501": "0.6" }), 0);
assert.equal(positionsValue([pos("#7501", 200, 100)], { "#7501": "bogus" }), 100);

// template expansion: name/description come from the registry, args from the market
import { expandTemplates, catOfQuestion, catOfOutcome } from "./types.ts";
const REGISTRY = [
  {
    id: "policyRateDecision",
    name: "{institution} {decisionLabel} rate decision",
    description:
      "Covers the {decisionLabel} {institution} decision, scheduled for {scheduledDecision} UTC. metadata=category:economics|subCategory:N/A",
  },
  {
    id: "policyRateNoChange",
    name: "No change",
    description: "Resolves to Yes on no change. metadata=category:economics",
  },
  {
    id: "binaryPrice",
    name: "{perp} above {threshold} at {time}?",
    description: "Yes if above. metadata=category:price",
  },
];
const expanded = expandTemplates(
  {
    outcomes: [
      {
        outcome: 1227,
        name: "template:policyRateNoChange",
        description: "",
        sideSpecs: [{ name: "Yes" }, { name: "No" }],
        quoteToken: "USDC",
      },
      {
        outcome: 1210,
        name: "template:binaryPrice",
        description: "perp:BTC|seconds:1|threshold:100000|time:20261001-0000",
        sideSpecs: [{ name: "template:Yes" }, { name: "template:No" }],
        quoteToken: "USDC",
      },
      {
        outcome: 9,
        name: "template:unknownTemplate",
        description: "a:b",
        sideSpecs: [],
        quoteToken: "USDC",
      },
    ],
    questions: [
      {
        question: 191,
        name: "template:policyRateDecision",
        description:
          "decisionLabel:September 2026|institution:Federal Reserve's Open Market Committee|scheduledDecision:20260916-1800",
        fallbackOutcome: 1226,
        namedOutcomes: [1227],
        settledNamedOutcomes: [],
      },
    ],
  },
  REGISTRY,
);
const q191 = expanded.questions[0];
assert.equal(
  q191.name,
  "Federal Reserve's Open Market Committee September 2026 rate decision",
);
assert.equal(
  q191.description,
  "Covers the September 2026 Federal Reserve's Open Market Committee decision, scheduled for Sep 16, 2026, 18:00 UTC.",
);
assert.equal(catOfQuestion(q191), "economics");
assert.equal(expanded.outcomes[0].name, "No change");
// numbers pretty-printed, dateTimes rendered UTC, registry metadata tail stripped
assert.equal(
  expanded.outcomes[1].name,
  "BTC above 100,000 at Oct 1, 2026, 00:00 UTC?",
);
assert.equal(expanded.outcomes[1].description, "Yes if above.");
// live markets ship sides as "template:Yes"/"template:No" — prefix stripped
assert.deepStrictEqual(expanded.outcomes[1].sideSpecs, [
  { name: "Yes" },
  { name: "No" },
]);
assert.equal(
  catOfOutcome({ ...expanded.outcomes[1], parsedMeta: null }),
  "crypto",
);
// unknown template id stays raw instead of guessing
assert.equal(expanded.outcomes[2].name, "template:unknownTemplate");

// September 2026 sports templates interpolate side labels and type string args.
{
  const market = {
    outcome: 1866,
    name: "template:sportsContestWinner",
    description:
      "competition:NFL|participantA:Dallas Cowboys|participantB:New York Giants|scheduledStart:20260914-0020|season:2026|shortNameA:Cowboys|shortNameB:Giants|stage:Regular Season",
    sideSpecs: [{ name: "template:{shortNameA}" }, { name: "template:{shortNameB}" }],
    quoteToken: "USDC",
  };
  const registry = [{
    id: "sportsContestWinner",
    name: "{competition} {stage}: {participantA} v {participantB}",
    description: "The {season} game is scheduled for {scheduledStart} UTC. metadata=category:sports",
    keywords: [["season", "string"], ["shortNameA", "shortString"], ["shortNameB", "shortString"], ["scheduledStart", "dateTime"]],
  }];
  const meta = { outcomes: [market], questions: [] };
  const sports = expandTemplates(meta, registry).outcomes[0];
  assert.deepEqual(sports.sideSpecs, [{ name: "Cowboys" }, { name: "Giants" }]);
  assert.equal(sports.name, "NFL Regular Season: Dallas Cowboys v New York Giants");
  assert.equal(sports.description, "The 2026 game is scheduled for Sep 14, 2026, 00:20 UTC.");
  assert.equal(catOfOutcome({ ...sports, parsedMeta: null }), "sports");
  assert.equal(catOfQuestion(sports), "sports");
  assert.equal(marketPath({ ...sports, parsedMeta: null }), "/sports/o-1866-nfl-regular-season-dallas-cowboys-v-new-york-giants");
  assert.equal(+parseMatchDate(sports.description, sports.templateArgs.scheduledStart), Date.UTC(2026, 8, 14, 0, 20));
  assert.equal(+parseMatchDate("A match scheduled for July 6, 2026."), Date.UTC(2026, 6, 6));
  assert.equal(parseMatchDate("No scheduled date", "invalid"), null);
  assert.deepEqual(expandTemplates(meta, []), meta);
  assert.equal(market.sideSpecs[0].name, "template:{shortNameA}"); // input unchanged
}

// firstPartyOnly: deployer-set outcomes dropped, questions with no surviving
// outcome dropped, question with a surviving fallback kept
{
  const o = (outcome, deployer) => ({
    outcome,
    name: `o${outcome}`,
    description: "",
    sideSpecs: [{ name: "Yes" }, { name: "No" }],
    quoteToken: "USDC",
    ...(deployer ? { deployer } : {}),
  });
  const q = (question, namedOutcomes, fallbackOutcome) => ({
    question,
    name: `q${question}`,
    description: "",
    fallbackOutcome,
    namedOutcomes,
    settledNamedOutcomes: [],
  });
  const filtered = firstPartyOnly({
    outcomes: [o(1), o(2, "0xabc"), o(3, "0xabc"), o(4)],
    questions: [q(10, [1, 2], 4), q(11, [2, 3], 3), q(12, [3], 4)],
  });
  assert.deepEqual(
    filtered.outcomes.map((x) => x.outcome),
    [1, 4],
  );
  assert.deepEqual(
    filtered.questions.map((x) => x.question),
    [10, 12], // 11 fully third-party; 12 survives via first-party fallback
  );
}

console.log("ok");
