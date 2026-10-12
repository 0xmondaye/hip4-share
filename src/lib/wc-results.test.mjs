// run: node --experimental-strip-types src/lib/wc-results.test.mjs
import assert from "node:assert";
import { worldCupResults } from "./wc-results.ts";

const drewDetails =
  "FIFA reported Canada and Bosnia and Herzegovina drew 1-1 in the Game.";
const mexDetails = "FIFA declared Mexico the winner of the Game.";

const rows = [
  // group-stage triple, draw
  { id: 240, name: "Canada", sides: ["Yes", "No"], fraction: 0, details: drewDetails },
  { id: 241, name: "Draw", sides: ["Yes", "No"], fraction: 1, details: drewDetails },
  { id: 242, name: "Bosnia and Herzegovina", sides: ["Yes", "No"], fraction: 0, details: drewDetails },
  // knockout pair (no Draw outcome)
  { id: 378, name: "Mexico", sides: ["Yes", "No"], fraction: 1, details: mexDetails },
  { id: 380, name: "Korea Republic", sides: ["Yes", "No"], fraction: 0, details: mexDetails },
  // single-outcome format, teams as sides
  {
    id: 779,
    name: "World Cup Quarterfinal: Spain vs Belgium",
    sides: ["Spain", "Belgium"],
    fraction: 1,
    details: "FIFA declared Spain the winner of the Game.",
  },
  // incomplete pair (partner id missing from scan) — must be dropped
  { id: 500, name: "Switzerland", sides: ["Yes", "No"], fraction: 1, details: "FIFA declared Switzerland the winner of the Game." },
  // recurring/crypto noise — must be ignored
  { id: 600, name: "Recurring Named Outcome", sides: ["Yes", "No"], fraction: 1, details: "price:60921.7" },
  { id: 601, name: "NBA Finals Game 5", sides: ["San Antonio", "New York"], fraction: 0, details: "The NBA declared New York the winner." },
];

const res = worldCupResults(rows);
assert.equal(res.length, 3);
// newest first by id
assert.deepEqual(res.map((r) => r.id), [779, 380, 242]);

const [qf, pair, triple] = res;
assert.equal(qf.stage, "Quarterfinal");
assert.deepEqual(qf.teams, ["Spain", "Belgium"]);
assert.equal(qf.winner, "Spain");

assert.deepEqual(pair.teams, ["Mexico", "Korea Republic"]);
assert.equal(pair.winner, "Mexico");
assert.equal(pair.score, null);

assert.deepEqual(triple.teams, ["Canada", "Bosnia and Herzegovina"]);
assert.equal(triple.winner, null); // draw
assert.equal(triple.score, "1–1");

// identical details but far-apart ids = two different matches, not one group
const dup = "FIFA declared Mexico the winner of the Game.";
const twoMatches = worldCupResults([
  { id: 248, name: "Mexico", sides: ["Yes", "No"], fraction: 1, details: dup },
  { id: 249, name: "Draw", sides: ["Yes", "No"], fraction: 0, details: dup },
  { id: 250, name: "South Africa", sides: ["Yes", "No"], fraction: 0, details: dup },
  { id: 378, name: "Mexico", sides: ["Yes", "No"], fraction: 1, details: dup },
  { id: 380, name: "Korea Republic", sides: ["Yes", "No"], fraction: 0, details: dup },
]);
assert.equal(twoMatches.length, 2);
assert.deepEqual(twoMatches[0].teams, ["Mexico", "Korea Republic"]);
assert.deepEqual(twoMatches[1].teams, ["Mexico", "South Africa"]);

console.log("wc-results ok");
