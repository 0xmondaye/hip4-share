// run: node --experimental-strip-types src/lib/relay-deposit.test.mjs
import assert from "node:assert";
import {
  DEPOSIT_CHAINS,
  DEFAULT_DEPOSIT_CHAIN,
  depositQuoteBody,
  HL_CHAIN_ID,
  HL_USDC,
} from "./relay-deposit-core.ts";

// --- registry sanity ---
assert.equal(DEPOSIT_CHAINS.length, 5);
assert.equal(DEFAULT_DEPOSIT_CHAIN.chainId, 42161); // Arbitrum stays the default
assert.equal(new Set(DEPOSIT_CHAINS.map((c) => c.chainId)).size, 5); // no dupes
for (const c of DEPOSIT_CHAINS) {
  assert.match(c.usdc, /^0x[0-9a-fA-F]{40}$/, `${c.name} usdc address`);
  assert.ok(c.name && c.label, `${c.chainId} has name+label`);
}

// Pinned native-USDC contracts — a typo here loses user funds.
const usdcByChain = Object.fromEntries(
  DEPOSIT_CHAINS.map((c) => [c.chainId, c.usdc]),
);
assert.equal(usdcByChain[42161], "0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
assert.equal(usdcByChain[8453], "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
assert.equal(usdcByChain[1], "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
assert.equal(usdcByChain[10], "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85");
assert.equal(usdcByChain[137], "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359");

// --- depositQuoteBody: correct routing for every chain ---
const USER = "0x1111111111111111111111111111111111111111";
for (const chain of DEPOSIT_CHAINS) {
  const body = depositQuoteBody(USER, chain);
  assert.equal(body.user, USER);
  assert.equal(body.recipient, USER);
  assert.equal(body.originChainId, chain.chainId);
  assert.equal(body.originCurrency, chain.usdc);
  assert.equal(body.destinationChainId, HL_CHAIN_ID);
  assert.equal(body.destinationCurrency, HL_USDC);
  assert.equal(body.tradeType, "EXACT_INPUT");
  assert.equal(body.useDepositAddress, true);
  assert.equal(body.refundTo, USER); // refunds land on the origin chain
  assert.ok(!("appFees" in body)); // Relay rejects empty/undefined appFees arrays
}

// --- appFees passthrough ---
const withFee = depositQuoteBody(USER, DEFAULT_DEPOSIT_CHAIN, [
  { recipient: "0x3333333333333333333333333333333333333333", fee: "100" },
]);
assert.equal(withFee.appFees[0].fee, "100");
assert.ok(!("appFees" in depositQuoteBody(USER, DEFAULT_DEPOSIT_CHAIN, [])));

// --- fee sponsorship ---
// Default off, and omitted (not false) when off — Relay treats explicit
// unknown/false fields differently across endpoints; send only when on.
const off = depositQuoteBody(USER, DEFAULT_DEPOSIT_CHAIN);
assert.ok(!("subsidizeFees" in off));
assert.ok(!("maxSubsidizationAmount" in off));
// When on, the cap MUST accompany subsidizeFees: an absent
// maxSubsidizationAmount is treated as cap 0 → sponsored $0 (real deposit
// 2026-07-18 lost $1.21 this way).
const on = depositQuoteBody(USER, DEFAULT_DEPOSIT_CHAIN, undefined, "5000000");
assert.equal(on.subsidizeFees, true);
assert.equal(on.maxSubsidizationAmount, "5000000");

console.log("relay-deposit.test.mjs OK");
