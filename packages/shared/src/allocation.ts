import type { TipType } from "./enums.js";

/**
 * Allocation engine (spec §10) — pure function, no I/O.
 *
 * worker_score = worked_minutes × role_weight
 * allocation   = pool × worker_score / total_score
 *
 * All amounts are integer USD cents. Rounding uses the largest-remainder
 * method so that the sum of allocations always equals the pool exactly
 * (spec §10.3: 계산 결과 합계는 tip pool 총액과 일치해야 함).
 */

export interface AllocationTipInput {
  tipType: TipType;
  grossAmountUsdCents: number;
  paymentStatus?: "COMPLETED" | "PENDING" | "CANCELED";
  refundStatus?: "NONE" | "PARTIAL" | "FULL";
}

export interface AllocationShiftInput {
  /** null when the external worker is not yet mapped (spec §11.1 check) */
  workerId: string | null;
  externalWorkerId: string;
  role: string;
  workedMinutes: number;
  shiftStatus: "IN_PROGRESS" | "COMPLETED" | "APPROVED" | "VOIDED";
}

export interface AllocationPolicyInput {
  roleWeights: Record<string, number>;
  excludedRoles: string[];
  poolInclusion: Partial<Record<TipType, boolean>>;
}

export type AllocationIssueCode =
  | "UNMAPPED_WORKER"
  | "NON_POSITIVE_MINUTES"
  | "UNKNOWN_ROLE"
  | "REFUNDED_PAYMENT_EXCLUDED"
  | "CANCELED_PAYMENT_EXCLUDED"
  | "EMPTY_POOL"
  | "NO_ELIGIBLE_SHIFTS";

export interface AllocationIssue {
  code: AllocationIssueCode;
  /** true → batch must go to REVIEW_REQUIRED instead of CALCULATED */
  blocking: boolean;
  detail: Record<string, string | number>;
}

export interface WorkerAllocationResult {
  workerId: string;
  score: number;
  pooledTipUsdCents: number;
  netAllocatedUsdCents: number;
}

export interface AllocationBatchResult {
  poolUsdCents: number;
  totalScore: number;
  allocations: WorkerAllocationResult[];
  issues: AllocationIssue[];
}

export function computeAllocationBatch(
  tips: AllocationTipInput[],
  shifts: AllocationShiftInput[],
  policy: AllocationPolicyInput,
): AllocationBatchResult {
  const issues: AllocationIssue[] = [];

  // ── Pool (spec §10.3: tip type별 포함 여부, refund/cancel 제외) ──
  let poolUsdCents = 0;
  for (const tip of tips) {
    if (!policy.poolInclusion[tip.tipType]) continue;
    if (tip.refundStatus === "FULL") {
      issues.push({
        code: "REFUNDED_PAYMENT_EXCLUDED",
        blocking: false,
        detail: { tipType: tip.tipType, amountUsdCents: tip.grossAmountUsdCents },
      });
      continue;
    }
    if (tip.paymentStatus === "CANCELED") {
      issues.push({
        code: "CANCELED_PAYMENT_EXCLUDED",
        blocking: false,
        detail: { tipType: tip.tipType, amountUsdCents: tip.grossAmountUsdCents },
      });
      continue;
    }
    poolUsdCents += tip.grossAmountUsdCents;
  }

  // ── Eligible shifts and scores ──────────────────────────────
  const scoreByWorker = new Map<string, number>();
  for (const shift of shifts) {
    if (shift.shiftStatus !== "COMPLETED" && shift.shiftStatus !== "APPROVED") continue;
    if (policy.excludedRoles.includes(shift.role)) continue;

    if (shift.workerId === null) {
      issues.push({
        code: "UNMAPPED_WORKER",
        blocking: true,
        detail: { externalWorkerId: shift.externalWorkerId, role: shift.role },
      });
      continue;
    }
    if (shift.workedMinutes <= 0) {
      issues.push({
        code: "NON_POSITIVE_MINUTES",
        blocking: true,
        detail: { workerId: shift.workerId, workedMinutes: shift.workedMinutes },
      });
      continue;
    }
    const weight = policy.roleWeights[shift.role];
    if (weight === undefined) {
      issues.push({
        code: "UNKNOWN_ROLE",
        blocking: true,
        detail: { workerId: shift.workerId, role: shift.role },
      });
      continue;
    }
    const score = shift.workedMinutes * weight;
    scoreByWorker.set(shift.workerId, (scoreByWorker.get(shift.workerId) ?? 0) + score);
  }

  const totalScore = [...scoreByWorker.values()].reduce((a, b) => a + b, 0);

  if (poolUsdCents === 0) {
    issues.push({ code: "EMPTY_POOL", blocking: false, detail: {} });
  }
  if (totalScore === 0) {
    issues.push({ code: "NO_ELIGIBLE_SHIFTS", blocking: poolUsdCents > 0, detail: {} });
    return { poolUsdCents, totalScore, allocations: [], issues };
  }

  // ── Largest-remainder split, exact to the cent ──────────────
  const entries = [...scoreByWorker.entries()].sort(([a], [b]) => a.localeCompare(b));
  const raw = entries.map(([workerId, score]) => {
    const exact = (poolUsdCents * score) / totalScore;
    return { workerId, score, floor: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });

  let leftover = poolUsdCents - raw.reduce((sum, r) => sum + r.floor, 0);
  const byRemainder = [...raw].sort(
    (a, b) => b.remainder - a.remainder || a.workerId.localeCompare(b.workerId),
  );
  for (const r of byRemainder) {
    if (leftover <= 0) break;
    r.floor += 1;
    leftover -= 1;
  }

  const allocations: WorkerAllocationResult[] = raw.map((r) => ({
    workerId: r.workerId,
    score: r.score,
    pooledTipUsdCents: r.floor,
    netAllocatedUsdCents: r.floor, // tip-out rules (§10.3) adjust this when implemented
  }));

  const total = allocations.reduce((sum, a) => sum + a.pooledTipUsdCents, 0);
  if (total !== poolUsdCents) {
    throw new Error(`Allocation invariant violated: allocated ${total} != pool ${poolUsdCents}`);
  }

  return { poolUsdCents, totalScore, allocations, issues };
}

/** Business date (YYYY-MM-DD) of an instant in the venue's timezone (spec §10.1). */
export function businessDateInTimezone(instant: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(instant); // en-CA formats as YYYY-MM-DD
}
