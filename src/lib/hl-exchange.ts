"use client";

import * as hl from "@nktkas/hyperliquid";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { ConnectedWallet } from "@privy-io/react-auth";
import { makeSigner, walletChainIdHex } from "./privy-signer";
import { outcomeAssetId } from "./hl-asset";
import { getPerpWithdrawable, getSpotUsdc } from "./hyperliquid";

type Tif = "Gtc" | "Ioc" | "Alo" | "FrontendMarket";

interface PlaceOrderInput {
  outcome: number;
  sideIdx: number;
  isBuy: boolean;
  price: string;
  size: string;
  tif?: Tif;
  reduceOnly?: boolean;
}

const transport = new hl.HttpTransport();

// Agent-wallet pattern (Privy Hyperliquid guide): the user wallet only signs
// user-signed actions (approveAgent / approveBuilderFee) at its OWN chain;
// orders are L1 actions (EIP-712 chainId 1337) signed by a local agent key —
// no wallet popup, no chain switching. The agent key can only trade on HL for
// this master (no withdrawals); losing it just means re-approving a new one.
function agentAccount(master: string) {
  const storageKey = `hl-agent-${master.toLowerCase()}`;
  let pk = localStorage.getItem(storageKey);
  if (!pk) {
    pk = generatePrivateKey();
    localStorage.setItem(storageKey, pk);
  }
  return privateKeyToAccount(pk as `0x${string}`);
}

function agentExchange(wallet: ConnectedWallet): hl.ExchangeClient {
  return new hl.ExchangeClient({
    transport,
    wallet: agentAccount(wallet.address),
  });
}

async function masterExchange(wallet: ConnectedWallet): Promise<hl.ExchangeClient> {
  return new hl.ExchangeClient({
    transport,
    wallet: await makeSigner(wallet),
    signatureChainId: walletChainIdHex(wallet),
  });
}

async function ensureAgent(wallet: ConnectedWallet) {
  const master = await masterExchange(wallet);
  await master.approveAgent({
    agentAddress: agentAccount(wallet.address).address,
    agentName: "gambit",
  });
}

/** Run an agent-signed action; on "agent not registered" approve it once and retry. */
async function withAgent<T>(
  wallet: ConnectedWallet,
  fn: (exchange: hl.ExchangeClient) => Promise<T>,
): Promise<T> {
  try {
    return await fn(agentExchange(wallet));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (!/does not exist|api wallet|agent/i.test(msg)) throw e;
    await ensureAgent(wallet);
    return await fn(agentExchange(wallet));
  }
}

// Builder-code fee revenue. Unset env → orders carry no builder field.
const BUILDER = (process.env.NEXT_PUBLIC_BUILDER_ADDRESS ?? "") as `0x${string}`;
// f is in tenths of a basis point per the HL spec: 10 = 1bp = 0.01% — keep in sync with maxFeeRate below
const BUILDER_FEE_TENTH_BPS = 10;

/** One-time per user; orders with a builder code are rejected until approved. */
export async function approveBuilderFee(wallet: ConnectedWallet) {
  if (!BUILDER) return;
  const master = await masterExchange(wallet);
  return master.approveBuilderFee({
    maxFeeRate: "0.01%", // = BUILDER_FEE_TENTH_BPS (10 tenths-bp)
    builder: BUILDER,
  });
}

const infoClient = new hl.InfoClient({ transport });
let builderApproved = false; // per-session cache; on-chain is source of truth

/**
 * Ensure the user has approved our builder fee before an order carries it.
 * Checks the on-chain approved max (`maxBuilderFee`, tenths of a bp) and only
 * prompts a signature when it's below our fee — no reliance on matching a
 * rejection string. Resilient: if the query fails we don't block the order
 * (the reactive retry in TradePanel is the fallback).
 */
async function ensureBuilderApproved(wallet: ConnectedWallet) {
  if (!BUILDER || builderApproved) return;
  try {
    const approved = Number(
      await infoClient.maxBuilderFee({
        user: wallet.address as `0x${string}`,
        builder: BUILDER,
      }),
    );
    if (approved >= BUILDER_FEE_TENTH_BPS) {
      builderApproved = true;
      return;
    }
  } catch {
    return; // query failed — let the order proceed; reactive retry covers it
  }
  await approveBuilderFee(wallet);
  builderApproved = true;
}

export async function cancelOutcomeOrder(
  wallet: ConnectedWallet,
  input: { assetId: number; oid: number },
) {
  return withAgent(wallet, (exchange) =>
    exchange.cancel({ cancels: [{ a: input.assetId, o: input.oid }] }),
  );
}

/**
 * HIP-4 convert operations (`userOutcome` L1 action, agent-signed):
 * - splitOutcome: X USDC → X Yes + X No shares of an outcome
 * - mergeOutcome: X Yes + X No shares → X USDC (amount null = max)
 * - mergeQuestion: X Yes shares of every outcome of a question (incl. fallback) → X USDC
 * - negateOutcome: X No shares of one outcome → X Yes shares of every other outcome of the question
 */
export type ConvertParams = Parameters<hl.ExchangeClient["userOutcome"]>[0];

export async function convertOutcome(
  wallet: ConnectedWallet,
  params: ConvertParams,
) {
  // splitOutcome spends spot USDC — same guarantee as buys
  const split = (params as { splitOutcome?: { amount?: string | number } })
    .splitOutcome;
  if (split?.amount) await ensureSpotUsdc(wallet, Number(split.amount));
  return withAgent(wallet, (exchange) => exchange.userOutcome(params));
}

// USDC lives in two HL accounts: deposits credit perps, HIP-4 orders settle
// in spot. CEX users expect ONE balance, so the app keeps everything in spot —
// sweep perps→spot whenever trading hits a shortfall, and pull back only a
// withdrawal's shortfall (Relay withdrawals draw perps USDC). Both transfers
// are user-signed EIP-712, hence master wallet — see HANDOFF.md.

const usd2 = (n: number) => (Math.floor(n * 100) / 100).toFixed(2);

// HL rejects usdClassTransfer for accounts with unified-account abstraction
// enabled ("Action disabled when unified account is active"). Unified means
// there IS only one balance — the transfer is unnecessary, so treat the
// rejection as success rather than failing the surrounding action.
// ponytail: user still signs one pointless popup; pre-check abstraction mode if that annoys.
const unifiedAccountNoop = (e: unknown) => {
  if (e instanceof Error && /unified account/i.test(e.message)) return undefined;
  throw e;
};

/** Move ALL perps USDC to spot. No-op under a cent. */
export async function sweepPerpsToSpot(wallet: ConnectedWallet) {
  const w = await getPerpWithdrawable(wallet.address);
  if (w < 0.01) return;
  const master = await masterExchange(wallet);
  return master
    .usdClassTransfer({ amount: usd2(w), toPerp: false })
    .catch(unifiedAccountNoop);
}

/**
 * Guarantee `needUsd` of free spot USDC before an action that spends it,
 * sweeping the perps account when spot is short. This is THE mechanism that
 * hides HL's perp/spot split — deterministic, runs before the action, no
 * error-string matching. Never throws: if anything here fails, the action
 * proceeds and HL's own balance check is the arbiter (the reactive retry in
 * TradePanel is the backstop).
 */
export async function ensureSpotUsdc(wallet: ConnectedWallet, needUsd: number) {
  try {
    const spot = await getSpotUsdc(wallet.address);
    if (spot.free >= needUsd) return;
    await sweepPerpsToSpot(wallet);
  } catch {
    /* fall through to the action itself */
  }
}

/** Top the perps account up to `amountUsd` from spot (for withdrawals). */
export async function coverPerpsFromSpot(
  wallet: ConnectedWallet,
  amountUsd: number,
) {
  const [perp, spot] = await Promise.all([
    getPerpWithdrawable(wallet.address),
    getSpotUsdc(wallet.address),
  ]);
  const need = Math.min(amountUsd - perp + 0.01, spot.free); // +1¢ rounding headroom
  if (need < 0.01) return;
  const master = await masterExchange(wallet);
  return master
    .usdClassTransfer({ amount: usd2(need), toPerp: true })
    .catch(unifiedAccountNoop);
}

export async function placeOutcomeOrder(
  wallet: ConnectedWallet,
  input: PlaceOrderInput,
) {
  const a = outcomeAssetId(input.outcome, input.sideIdx);
  // Buys reserve size × limit price of spot USDC — make sure it's there
  // BEFORE the order, so users whose deposits sit in perps never see
  // "Insufficient spot balance".
  if (input.isBuy) {
    await ensureSpotUsdc(wallet, Number(input.price) * Number(input.size));
  }
  // Proactively authorize the builder fee (on-chain-checked) so the order
  // below isn't rejected for an unapproved builder code.
  await ensureBuilderApproved(wallet);
  return withAgent(wallet, (exchange) =>
    exchange.order({
      orders: [
        {
          a,
          b: input.isBuy,
          p: input.price,
          s: input.size,
          r: input.reduceOnly ?? false,
          t: { limit: { tif: input.tif ?? "Gtc" } },
        },
      ],
      grouping: "na",
      ...(BUILDER
        ? { builder: { b: BUILDER, f: BUILDER_FEE_TENTH_BPS } }
        : {}),
    }),
  );
}

// ── HyperCore → HyperEVM ─────────────────────────────────────────────────────
// Core USDC (token index 0) bridges by spotSend to its system address; a
// system tx then has Circle's CoreDepositWallet (spotMeta evmContract,
// 0x6b9e77…) release native USDC 0xb88339… to the same address on HyperEVM,
// ~2s later. Verified 2026-09-03 (HANDOFF "Wine gacha"). Mainnet ids only —
// testnet Core USDC is a different token and the wine testnet pay token is a
// mock, so callers gate on chain 999 and on tokenAt(0) == HL_USDC_EVM.
/** Core USDC system address. spotSend Core USDC here to reach the EVM. ONE direction only: on
 *  the EVM side Circle has blacklisted this address in the USDC contract — the reverse is
 *  `deposit()` on CORE_DEPOSIT_WALLET (hyperevm-funds.ts moveUsdcToHyperCore). */
export const USDC_SYSTEM_ADDRESS = "0x2000000000000000000000000000000000000000";
/** Circle's CoreDepositWallet — Core USDC's `evmContract` in spotMeta. Releases native USDC on
 *  Core→EVM; `deposit(amount, 4294967295)` is the EVM→Core entry. */
export const CORE_DEPOSIT_WALLET = "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24";
const USDC_CORE_TOKEN = "USDC:0x6d1e7cde53ba9467b783cb7c530ce054";
/** Native USDC on HyperEVM mainnet — what the bridge delivers. */
export const HL_USDC_EVM = "0xb88339CB7199b77E23DB6E890353E22632Ba630f";

/** Move `amountUsd` of the user's HL balance to native USDC in their HyperEVM
 *  wallet. Sweeps perps→spot first (one balance policy); user-signed. */
export async function moveUsdcToHyperEvm(wallet: ConnectedWallet, amountUsd: number) {
  await ensureSpotUsdc(wallet, amountUsd);
  const master = await masterExchange(wallet);
  await master.spotSend({
    destination: USDC_SYSTEM_ADDRESS,
    token: USDC_CORE_TOKEN,
    amount: usd2(amountUsd),
  });
}

/** Hyperliquid's one-time $1 account activation fee, charged on the FIRST outbound transfer when
 *  nothing inbound paid it — every account funded from the HyperEVM side (system-address credits
 *  don't activate). Comes out of the account's USDC; the info API has no "activated" flag, so
 *  callers learn it from this refusal. Nothing has moved when it fires. */
export const isActivationFeeError = (e: unknown) =>
  /token transfer gas/i.test(e instanceof Error ? e.message : "");
/** What the account must hold in USDC for the fee to clear, with rounding headroom. 6 dp. */
export const ACTIVATION_FEE_UNITS6 = BigInt(1_010_000);

// ── HyperCore spot HYPE → HyperEVM native HYPE ───────────────────────────────
/** HYPE system address on HyperEVM. Core spot HYPE spotSent here arrives as native HYPE at
 *  the same address a few seconds later (the mirror of the USDC system address above). */
export const HYPE_SYSTEM_ADDRESS = "0x2222222222222222222222222222222222222222";
let hypeCoreToken: Promise<string> | undefined;
/** "HYPE:<tokenId>" from spotMeta — looked up, not hardcoded, so a wrong literal can never
 *  send someone else's token to the bridge. */
const hypeToken = () =>
  (hypeCoreToken ??= infoClient.spotMeta().then((m) => {
    const t = m.tokens.find((t) => t.name === "HYPE");
    if (!t) throw new Error("HYPE is not in spotMeta");
    return `HYPE:${t.tokenId}`;
  }));

/** Move `amount` HYPE (decimal string, ≤ 8 dp — Core HYPE weiDecimals) from the user's spot
 *  balance to native HYPE in their HyperEVM wallet. User-signed, gasless on Core. */
export async function moveHypeToHyperEvm(wallet: ConnectedWallet, amount: string) {
  const master = await masterExchange(wallet);
  await master.spotSend({ destination: HYPE_SYSTEM_ADDRESS, token: await hypeToken(), amount });
}
