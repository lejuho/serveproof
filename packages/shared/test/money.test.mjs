import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseUsdToCents,
  formatCentsToUsd,
  centsToUsdcBaseUnits,
  usdcBaseUnitsToCents,
} from "../dist/money.js";

test("parseUsdToCents parses spec CSV amounts", () => {
  assert.equal(parseUsdToCents("120.00"), 12000);
  assert.equal(parseUsdToCents("0.5"), 50);
  assert.equal(parseUsdToCents("7"), 700);
});

test("parseUsdToCents rejects invalid input", () => {
  assert.throws(() => parseUsdToCents("1.234"));
  assert.throws(() => parseUsdToCents("abc"));
  assert.throws(() => parseUsdToCents("$5"));
});

test("formatCentsToUsd round-trips", () => {
  assert.equal(formatCentsToUsd(12000), "120.00");
  assert.equal(formatCentsToUsd(50), "0.50");
  assert.equal(formatCentsToUsd(-105), "-1.05");
});

test("USD cents ↔ USDC base units (6 decimals) is exact", () => {
  assert.equal(centsToUsdcBaseUnits(12000), 120_000_000n);
  assert.equal(usdcBaseUnitsToCents(120_000_000n), 12000);
  assert.throws(() => usdcBaseUnitsToCents(1n));
});
