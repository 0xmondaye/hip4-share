// run: node --experimental-strip-types src/lib/relay-withdraw.test.mjs
import assert from "node:assert";
import {
  toUnits8,
  buildWithdrawQuoteBody,
  parseWithdrawQuote,
  buildHypeQuoteBody,
  parseHypeQuote,
} from "./relay-withdraw-core.ts";

// --- toUnits8: USD decimal string → 8-dp integer string, no floats ---
assert.equal(toUnits8("20"), "2000000000");
assert.equal(toUnits8("20.5"), "2050000000");
assert.equal(toUnits8("0.00000001"), "1");
assert.equal(toUnits8("5.123456"), "512345600");
assert.equal(toUnits8(" 7.25 "), "725000000"); // trimmed
assert.equal(toUnits8("123456789.99"), "12345678999000000"); // > 2^53 safe
assert.throws(() => toUnits8("0"), /amount/i);
assert.throws(() => toUnits8(""), /amount/i);
assert.throws(() => toUnits8("abc"), /amount/i);
assert.throws(() => toUnits8("1.123456789"), /amount/i); // >8 decimals
assert.throws(() => toUnits8("-5"), /amount/i);
assert.throws(() => toUnits8("1e3"), /amount/i);

// --- buildWithdrawQuoteBody ---
const body = buildWithdrawQuoteBody({
  user: "0x1111111111111111111111111111111111111111",
  recipient: "0x2222222222222222222222222222222222222222",
  amountUsd: "20",
  appFees: [{ recipient: "0x3333333333333333333333333333333333333333", fee: "100" }],
});
assert.equal(body.originChainId, 1337);
assert.equal(body.destinationChainId, 42161);
assert.equal(body.originCurrency, "0x00000000000000000000000000000000");
assert.equal(body.destinationCurrency, "0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
assert.equal(body.amount, "2000000000");
assert.equal(body.tradeType, "EXACT_INPUT");
assert.equal(body.protocolVersion, "v2");
assert.equal(body.refundTo, "0x1111111111111111111111111111111111111111");
assert.equal(body.recipient, "0x2222222222222222222222222222222222222222");
assert.equal(body.appFees[0].fee, "100");
// no appFees key at all when not configured (Relay rejects empty arrays)
const noFee = buildWithdrawQuoteBody({
  user: "0x1111111111111111111111111111111111111111",
  recipient: "0x2222222222222222222222222222222222222222",
  amountUsd: "20",
});
assert.equal("appFees" in noFee, false);
// keyless quotes carry no sponsorship block at all
assert.equal("subsidizeFees" in noFee, false);
// server-side: relayer fee sponsored, app fee NOT (subsidizeFees alone refunds our own appFee)
const sponsored = buildWithdrawQuoteBody({
  user: "0x1111111111111111111111111111111111111111",
  recipient: "0x2222222222222222222222222222222222222222",
  amountUsd: "20",
  appFees: [{ recipient: "0x3333333333333333333333333333333333333333", fee: "100" }],
  subsidyCapUsdc: 5,
});
assert.equal(sponsored.subsidizeFees, true);
assert.deepEqual(sponsored.sponsoredFeeComponents, ["execution", "swap", "relay"]);
assert.equal(sponsored.maxSubsidizationAmount, "5000000"); // USDC 6dp, mandatory

// --- parseWithdrawQuote: trimmed real /quote/v2 response (live, 2026-07-07) ---
const quoteFixture = {
  steps: [
    {
      id: "authorize",
      kind: "signature",
      requestId: "0x25f03a9b1bf85925fb584c7ea7667150b6b1b0206c2738cefb3f45fcc1121204",
      items: [
        {
          status: "incomplete",
          data: {
            sign: {
              signatureKind: "eip712",
              domain: { name: "RelayNonceMapping", version: "2", chainId: 1, verifyingContract: "0x0000000000000000000000000000000000000000" },
              types: { NonceMapping: [ { name: "chainId", type: "string" }, { name: "wallet", type: "address" }, { name: "depositor", type: "address" }, { name: "id", type: "bytes32" }, { name: "nonce", type: "uint256" } ] },
              value: { chainId: "hyperliquid", wallet: "0x63FaC9201494f0bd17B9892B9fae4d52fe3BD377", nonce: 1783458363420, id: "0xdf8b", depositor: "0x63FaC9201494f0bd17B9892B9fae4d52fe3BD377" },
              primaryType: "NonceMapping",
            },
            post: {
              endpoint: "/authorize",
              method: "POST",
              body: { type: "nonce-mapping", walletChainId: 1337, wallet: "0x63fac9", nonce: 1783458363420, id: "0xdf8b", depositor: "0x63FaC9", signatureChainId: 1 },
            },
          },
        },
      ],
    },
    {
      id: "deposit",
      kind: "transaction",
      requestId: "0x25f03a9b1bf85925fb584c7ea7667150b6b1b0206c2738cefb3f45fcc1121204",
      items: [
        {
          status: "incomplete",
          data: {
            action: {
              type: "sendAsset",
              parameters: { hyperliquidChain: "Mainnet", destination: "0x865eb9baa5492cef598adf7afb1038654fcb7081", sourceDex: "", destinationDex: "", token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054", amount: "20.000000", fromSubAccount: "", nonce: 1783458363420 },
            },
            nonce: 1783458363420,
          },
          check: { endpoint: "/intents/status/v3?requestId=0x25f0", method: "GET" },
        },
      ],
    },
  ],
  fees: {
    relayer: { amountUsd: "0.006984" },
    app: { amountUsd: "0.199964" },
  },
  details: {
    currencyOut: { amount: "19793015", amountFormatted: "19.793015", amountUsd: "19.789432" },
    timeEstimate: 2,
  },
};

const q = parseWithdrawQuote(quoteFixture);
assert.equal(q.requestId, "0x25f03a9b1bf85925fb584c7ea7667150b6b1b0206c2738cefb3f45fcc1121204");
assert.equal(q.authorize.post.endpoint, "/authorize");
assert.equal(q.authorize.sign.primaryType, "NonceMapping");
assert.equal(q.deposit.nonce, 1783458363420);
assert.equal(q.deposit.parameters.destination, "0x865eb9baa5492cef598adf7afb1038654fcb7081");
assert.equal(q.deposit.parameters.amount, "20.000000");
assert.equal(q.deposit.check.endpoint, "/intents/status/v3?requestId=0x25f0");
assert.equal(q.receiveUsd, "19.793015");
assert.equal(q.receiveRaw, "19793015"); // raw base units, for quote-covers checks
assert.equal(q.totalFeeUsd, "0.21"); // 0.006984 + 0.199964 rounded to cents
// sponsored quote: the fee shown is what the user pays after our subsidy
const sub = structuredClone(quoteFixture);
sub.fees.relayer = { amountUsd: "1.21" };
sub.fees.subsidized = { amount: "1210000", amountUsd: "1.21" };
assert.equal(parseWithdrawQuote(sub).totalFeeUsd, "0.20"); // app fee only
assert.equal(q.timeEstimate, 2);

// malformed responses throw with a useful message
assert.throws(() => parseWithdrawQuote({}), /quote/i);
assert.throws(() => parseWithdrawQuote({ steps: [{ id: "authorize", items: [] }] }), /quote/i);
// nonce mismatch between steps must be rejected (Relay can't match the transfer)
const bad = structuredClone(quoteFixture);
bad.steps[1].items[0].data.nonce = 1;
bad.steps[1].items[0].data.action.parameters.nonce = 1;
assert.throws(() => parseWithdrawQuote(bad), /nonce/i);
// requestId mismatch across steps must be rejected
const badId = structuredClone(quoteFixture);
badId.steps[1].requestId = "0xother";
assert.throws(() => parseWithdrawQuote(badId), /requestId/i);

// --- buildHypeQuoteBody: native HYPE on 999 → picked destination, deposit-style sponsorship ---
const hype = buildHypeQuoteBody({
  user: "0x1111111111111111111111111111111111111111",
  recipient: "0x2222222222222222222222222222222222222222",
  amountWei: "1000000000000000000",
  destinationId: "arb-usdc",
  appFees: [{ recipient: "0x3333333333333333333333333333333333333333", fee: "100" }],
  subsidyCapUsdc: 5,
});
assert.equal(hype.originChainId, 999);
assert.equal(hype.originCurrency, "0x0000000000000000000000000000000000000000");
assert.equal(hype.destinationChainId, 42161);
assert.equal(hype.destinationCurrency, "0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
assert.equal(hype.amount, "1000000000000000000");
assert.equal(hype.refundTo, "0x1111111111111111111111111111111111111111");
assert.equal(hype.subsidizeFees, true);
assert.equal(hype.maxSubsidizationAmount, "5000000");
assert.deepEqual(hype.sponsoredFeeComponents, ["execution", "swap", "relay"]);
assert.throws(() => buildHypeQuoteBody({ user: "0x1", recipient: "0x2", amountWei: "1", destinationId: "nope" }), /destination/i);
assert.throws(() => buildHypeQuoteBody({ user: "0x1", recipient: "0x2", amountWei: "1.5", destinationId: "arb-usdc" }), /amount/i);
assert.throws(() => buildHypeQuoteBody({ user: "0x1", recipient: "0x2", amountWei: "0", destinationId: "arb-usdc" }), /amount/i);

// --- parseHypeQuote: trimmed live /quote/v2 (2026-09-06), one tx step on 999 ---
const hypeFixture = {
  steps: [{
    id: "deposit", kind: "transaction", requestId: "0x1788",
    items: [{ status: "incomplete", data: { from: "0x63Fa", to: "0x4cd00e387622c35bddb9b4c962c136462338bc31", data: "0x49290c1c", value: "1000000000000000000", chainId: 999, gas: "32713" },
      check: { endpoint: "/intents/status/v3?requestId=0x1788", method: "GET" } }],
  }],
  fees: { gas: { amountUsd: "0.001276" }, relayer: { amountUsd: "0.576742" }, app: { amountUsd: "0.10" }, subsidized: { amountUsd: "0.576742" } },
  details: { currencyOut: { amountFormatted: "0.034402316230409724" } },
};
const hq = parseHypeQuote(hypeFixture);
assert.equal(hq.requestId, "0x1788");
assert.equal(hq.items.length, 1);
assert.equal(hq.items[0].kind, "transaction");
assert.equal(hq.items[0].tx.value, "1000000000000000000");
assert.equal(hq.receive, "0.034402316230409724");
assert.equal(hq.totalFeeUsd, "0.10"); // relayer sponsored, app fee stays
assert.equal(hq.gasUsd, "0.00");
// a quote whose tx is on another chain is refused — we only ever sign on HyperEVM here
const wrongChain = structuredClone(hypeFixture);
wrongChain.steps[0].items[0].data.chainId = 1;
assert.throws(() => parseHypeQuote(wrongChain), /HyperEVM/);

console.log("relay-withdraw-core: all tests passed");
