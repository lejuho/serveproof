import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAllocationBatch, businessDateInTimezone } from "../dist/allocation.js";

const policy = {
  roleWeights: { SERVER: 1.0, BUSSER: 0.7 },
  excludedRoles: ["MANAGER"],
  poolInclusion: { CARD_TIP: true, QR_TIP: true, CASH_TIP: false },
};

const demoShifts = [
  {
    workerId: "A",
    externalWorkerId: "w1",
    role: "SERVER",
    workedMinutes: 300,
    shiftStatus: "COMPLETED",
  },
  {
    workerId: "B",
    externalWorkerId: "w2",
    role: "SERVER",
    workedMinutes: 360,
    shiftStatus: "COMPLETED",
  },
  {
    workerId: "C",
    externalWorkerId: "w3",
    role: "BUSSER",
    workedMinutes: 270,
    shiftStatus: "COMPLETED",
  },
];

test("demo scenario: $120 card tip pool splits exactly", () => {
  const result = computeAllocationBatch(
    [{ tipType: "CARD_TIP", grossAmountUsdCents: 12000 }],
    demoShifts,
    policy,
  );
  assert.equal(result.poolUsdCents, 12000);
  // scores: A=300, B=360, C=189 → total 849
  assert.equal(result.totalScore, 849);
  const total = result.allocations.reduce((s, a) => s + a.pooledTipUsdCents, 0);
  assert.equal(total, 12000);
  const byWorker = Object.fromEntries(
    result.allocations.map((a) => [a.workerId, a.pooledTipUsdCents]),
  );
  assert.equal(byWorker.A, 4240);
  assert.equal(byWorker.B, 5088);
  assert.equal(byWorker.C, 2672); // largest remainder gets the leftover cent
});

test("cash tips excluded from pool by policy (CASH_RETAINED separation)", () => {
  const result = computeAllocationBatch(
    [
      { tipType: "CARD_TIP", grossAmountUsdCents: 10000 },
      { tipType: "CASH_TIP", grossAmountUsdCents: 3550 },
    ],
    demoShifts,
    policy,
  );
  assert.equal(result.poolUsdCents, 10000);
});

test("unmapped worker produces blocking issue and is excluded", () => {
  const result = computeAllocationBatch(
    [{ tipType: "CARD_TIP", grossAmountUsdCents: 12000 }],
    [
      ...demoShifts,
      {
        workerId: null,
        externalWorkerId: "w4",
        role: "SERVER",
        workedMinutes: 100,
        shiftStatus: "COMPLETED",
      },
    ],
    policy,
  );
  const issue = result.issues.find((i) => i.code === "UNMAPPED_WORKER");
  assert.ok(issue);
  assert.equal(issue.blocking, true);
  assert.equal(result.allocations.length, 3);
});

test("excluded roles, voided shifts, zero minutes, unknown roles", () => {
  const result = computeAllocationBatch(
    [{ tipType: "CARD_TIP", grossAmountUsdCents: 9000 }],
    [
      {
        workerId: "A",
        externalWorkerId: "w1",
        role: "SERVER",
        workedMinutes: 100,
        shiftStatus: "COMPLETED",
      },
      {
        workerId: "M",
        externalWorkerId: "w9",
        role: "MANAGER",
        workedMinutes: 480,
        shiftStatus: "COMPLETED",
      },
      {
        workerId: "V",
        externalWorkerId: "w8",
        role: "SERVER",
        workedMinutes: 100,
        shiftStatus: "VOIDED",
      },
      {
        workerId: "Z",
        externalWorkerId: "w7",
        role: "SERVER",
        workedMinutes: 0,
        shiftStatus: "COMPLETED",
      },
      {
        workerId: "U",
        externalWorkerId: "w6",
        role: "SOMMELIER",
        workedMinutes: 100,
        shiftStatus: "COMPLETED",
      },
    ],
    policy,
  );
  assert.deepEqual(
    result.allocations.map((a) => a.workerId),
    ["A"],
  );
  assert.equal(result.allocations[0].pooledTipUsdCents, 9000);
  assert.ok(result.issues.some((i) => i.code === "NON_POSITIVE_MINUTES" && i.blocking));
  assert.ok(result.issues.some((i) => i.code === "UNKNOWN_ROLE" && i.blocking));
});

test("fully refunded payments are excluded with a non-blocking issue", () => {
  const result = computeAllocationBatch(
    [
      { tipType: "CARD_TIP", grossAmountUsdCents: 5000 },
      { tipType: "CARD_TIP", grossAmountUsdCents: 2000, refundStatus: "FULL" },
    ],
    demoShifts,
    policy,
  );
  assert.equal(result.poolUsdCents, 5000);
  assert.ok(result.issues.some((i) => i.code === "REFUNDED_PAYMENT_EXCLUDED" && !i.blocking));
});

test("rounding never loses or creates cents across many workers", () => {
  const shifts = Array.from({ length: 7 }, (_, i) => ({
    workerId: `W${i}`,
    externalWorkerId: `x${i}`,
    role: "SERVER",
    workedMinutes: 100 + i * 37,
    shiftStatus: "COMPLETED",
  }));
  const result = computeAllocationBatch(
    [{ tipType: "CARD_TIP", grossAmountUsdCents: 10001 }],
    shifts,
    policy,
  );
  const total = result.allocations.reduce((s, a) => s + a.pooledTipUsdCents, 0);
  assert.equal(total, 10001);
});

test("businessDateInTimezone converts UTC instant to venue-local date", () => {
  // 2026-08-06T02:00Z is still Aug 5 in New York (UTC-4)
  assert.equal(
    businessDateInTimezone(new Date("2026-08-06T02:00:00Z"), "America/New_York"),
    "2026-08-05",
  );
  assert.equal(
    businessDateInTimezone(new Date("2026-08-06T02:00:00Z"), "Asia/Seoul"),
    "2026-08-06",
  );
});
