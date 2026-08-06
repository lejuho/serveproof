/**
 * Money rules (single implementation for the whole monorepo):
 * - USD amounts are carried as integer cents (2 decimals) to avoid float drift.
 * - USDC on-chain amounts use 6 decimals (spec §29.3: tUSDC decimals = 6).
 */

export const USD_DECIMALS = 2;
export const USDC_DECIMALS = 6;

/** Parse a decimal string like "120.00" into integer cents. Rejects >2 decimal places. */
export function parseUsdToCents(value: string): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid USD amount: ${value}`);
  }
  const [, sign, whole, frac = ""] = match;
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return sign === "-" ? -cents : cents;
}

export function formatCentsToUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Convert integer USD cents to USDC base units (6 decimals), exact. */
export function centsToUsdcBaseUnits(cents: number): bigint {
  if (!Number.isInteger(cents)) {
    throw new Error(`Cents must be an integer: ${cents}`);
  }
  return BigInt(cents) * 10_000n;
}

/** Convert USDC base units to USD cents. Throws if sub-cent precision would be lost. */
export function usdcBaseUnitsToCents(baseUnits: bigint): number {
  if (baseUnits % 10_000n !== 0n) {
    throw new Error(`USDC amount ${baseUnits} has sub-cent precision`);
  }
  return Number(baseUnits / 10_000n);
}
