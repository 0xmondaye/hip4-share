// run: node --experimental-strip-types src/lib/relay-activity.test.mjs
// Relay /requests/v3 parse. The amount path is the ONE breaking change from v2
// (data.metadata deleted), and getting it wrong renders a silent blank — which
// is the failure this migration exists to prevent.
import assert from "node:assert/strict"
import { activityAmountUsd, parseDepositActivity } from "./relay-activity.ts"

// --- v3 shape: amount under data.route.actual.origin.inputCurrency ---
const v3 = {
  requests: [
    {
      status: "success",
      createdAt: "2026-08-24T03:49:12.036Z",
      data: {
        route: {
          actual: { origin: { inputCurrency: { amountUsd: "15.350418" } } },
          quoted: { origin: { inputCurrency: { amountUsd: "15.000000" } } },
        },
      },
    },
  ],
}
assert.deepEqual(parseDepositActivity(v3), [
  { status: "success", amountUsd: "15.350418", createdAt: "2026-08-24T03:49:12.036Z" },
])

// `actual` must WIN over `quoted`: for an open deposit address the quoted amount
// is not what the user actually pushed, so preferring quoted would show a number
// the user never sent.
assert.equal(
  activityAmountUsd({
    route: {
      actual: { origin: { inputCurrency: { amountUsd: "9" } } },
      quoted: { origin: { inputCurrency: { amountUsd: "1" } } },
    },
  }),
  "9",
)
// quoted is the documented fallback while actual is absent (still-pending fills)
assert.equal(
  activityAmountUsd({ route: { quoted: { origin: { inputCurrency: { amountUsd: "1.5" } } } } }),
  "1.5",
)

// --- v2 shapes still parse, so a rollback or a stale response isn't a blank ---
assert.equal(activityAmountUsd({ metadata: { currencyIn: { amountUsd: "20.5" } } }), "20.5")
assert.equal(activityAmountUsd({ currencyIn: { amountUsd: "3" } }), "3")
// v3 wins when both are somehow present
assert.equal(
  activityAmountUsd({
    route: { actual: { origin: { inputCurrency: { amountUsd: "7" } } } },
    metadata: { currencyIn: { amountUsd: "99" } },
  }),
  "7",
)

// --- absent / malformed must be undefined, never "undefined" or a throw ---
for (const d of [undefined, null, {}, { route: {} }, { route: { actual: {} } }, "nope", 42])
  assert.equal(activityAmountUsd(d), undefined, `bad input ${JSON.stringify(d)}`)
// a numeric amount is coerced rather than dropped
assert.equal(activityAmountUsd({ route: { actual: { origin: { inputCurrency: { amountUsd: 12.5 } } } } }), "12.5")

// --- every v3 status value survives the parse verbatim ---
// `success` in particular drives the perps->spot sweep in DepositDialog, so a
// mangled value would silently strand deposits in the perps account.
const STATUSES = ["refund", "waiting", "depositing", "failure", "pending", "submitted", "success"]
assert.deepEqual(
  parseDepositActivity({ requests: STATUSES.map((status) => ({ status })) }).map((a) => a.status),
  STATUSES,
)

// --- a body that isn't what we expect yields [], never a throw ---
for (const b of [undefined, null, {}, { requests: null }, { requests: "x" }, [], 7])
  assert.deepEqual(parseDepositActivity(b), [], `bad body ${JSON.stringify(b)}`)
// a missing status defaults to pending rather than undefined
assert.deepEqual(parseDepositActivity({ requests: [{}] }), [
  { status: "pending", amountUsd: undefined, createdAt: undefined },
])
// a non-string createdAt is dropped, not stringified
assert.equal(parseDepositActivity({ requests: [{ createdAt: 123 }] })[0].createdAt, undefined)

console.log("relay-activity.test.mjs OK")
