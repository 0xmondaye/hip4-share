// run: node --experimental-strip-types src/lib/recover.test.mjs
import assert from "node:assert";
import {
  DEPOSIT_CHAINS,
  MIN_RECOVER_RAW,
  recoverQuoteBody,
  parseRecoverQuote,
  HL_CHAIN_ID,
  HL_USDC,
} from "./recover-core.ts";

const USER = "0x1111111111111111111111111111111111111111";

// --- recoverQuoteBody: correct routing for every chain ---
for (const chain of DEPOSIT_CHAINS) {
  const body = recoverQuoteBody(USER, chain, "25500000");
  assert.equal(body.user, USER);
  assert.equal(body.recipient, USER);
  assert.equal(body.originChainId, chain.chainId);
  assert.equal(body.originCurrency, chain.usdc);
  assert.equal(body.destinationChainId, HL_CHAIN_ID);
  assert.equal(body.destinationCurrency, HL_USDC);
  assert.equal(body.amount, "25500000");
  assert.equal(body.tradeType, "EXACT_INPUT");
  assert.equal(body.usePermit, true); // gasless origin — the whole point
  assert.equal(body.refundTo, USER);
  assert.ok(!("useDepositAddress" in body)); // wallet-executed, not an open address
}

// --- sponsorship: same mandatory-cap rule as deposits ---
const off = recoverQuoteBody(USER, DEPOSIT_CHAINS[0], "5000000");
assert.ok(!("subsidizeFees" in off));
assert.ok(!("maxSubsidizationAmount" in off));
const on = recoverQuoteBody(USER, DEPOSIT_CHAINS[0], "5000000", "5000000");
assert.equal(on.subsidizeFees, true);
assert.equal(on.maxSubsidizationAmount, "5000000");

// --- dust floor ---
assert.equal(MIN_RECOVER_RAW, 1_000_000n);

// --- parseRecoverQuote: signature step (gasless permit path) ---
const sigQuote = {
  steps: [
    {
      id: "authorize",
      kind: "signature",
      requestId: "0xabc",
      items: [
        {
          status: "incomplete",
          data: {
            sign: { domain: { chainId: 42161 }, types: {}, value: {}, primaryType: "ReceiveWithAuthorization" },
            post: { endpoint: "/execute/permits", method: "POST", body: { x: 1 } },
          },
          check: { endpoint: "/intents/status/v3?requestId=0xabc", method: "GET" },
        },
      ],
    },
  ],
  details: { currencyOut: { amountFormatted: "25.48" } },
};
const parsed = parseRecoverQuote(sigQuote);
assert.equal(parsed.requestId, "0xabc");
assert.equal(parsed.receiveUsd, "25.48");
assert.equal(parsed.items.length, 1);
assert.equal(parsed.items[0].kind, "signature");
assert.equal(parsed.items[0].post.endpoint, "/execute/permits");
assert.equal(parsed.items[0].check.endpoint, "/intents/status/v3?requestId=0xabc");

// --- parseRecoverQuote: transaction steps, completed items skipped ---
const txQuote = {
  steps: [
    {
      id: "approve",
      kind: "transaction",
      requestId: "0xdef",
      items: [{ status: "complete", data: { to: "0x2222222222222222222222222222222222222222" } }],
    },
    {
      id: "deposit",
      kind: "transaction",
      requestId: "0xdef",
      items: [
        {
          status: "incomplete",
          data: { to: "0x3333333333333333333333333333333333333333", data: "0xdead", value: "0", chainId: 8453 },
          check: { endpoint: "/check", method: "GET" },
        },
      ],
    },
  ],
};
const parsedTx = parseRecoverQuote(txQuote);
assert.equal(parsedTx.items.length, 1); // complete item skipped
assert.equal(parsedTx.items[0].kind, "transaction");
assert.equal(parsedTx.items[0].tx.to, "0x3333333333333333333333333333333333333333");
assert.equal(parsedTx.items[0].tx.chainId, 8453);

// --- parseRecoverQuote: refuses shapes it can't execute ---
assert.throws(() => parseRecoverQuote({ steps: [] }), /no executable steps/);
assert.throws(
  () => parseRecoverQuote({ steps: [{ kind: "signature", requestId: "0x1", items: [{ data: {} }] }] }),
  /missing sign\/post/,
);
assert.throws(
  () => parseRecoverQuote({ steps: [{ kind: "wat", requestId: "0x1", items: [{ data: { to: "0x2" } }] }] }),
  /Unsupported Relay step kind/,
);
assert.throws(
  () =>
    parseRecoverQuote({
      steps: [{ kind: "transaction", items: [{ data: { to: "0x2222222222222222222222222222222222222222" } }] }],
    }),
  /missing requestId/,
);

console.log("recover.test.mjs OK");
