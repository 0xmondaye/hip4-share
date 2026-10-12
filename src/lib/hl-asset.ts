export const OUTCOME_ASSET_BASE = 100_000_000;

export function outcomeAssetId(outcome: number, sideIdx: number): number {
  return OUTCOME_ASSET_BASE + outcome * 10 + sideIdx;
}

export function outcomeCoinName(outcome: number, sideIdx: number): string {
  return `#${outcome * 10 + sideIdx}`;
}

export function clampOutcomePrice(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.max(0.001, Math.min(0.999, p));
}

export function roundToTick(p: number, tick = 0.0001): string {
  const rounded = Math.round(p / tick) * tick;
  return rounded.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
