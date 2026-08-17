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
  provider: string;
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
  /** null → held share for a not-yet-connected external worker */
  workerId: string | null;
  provider: string | null;
  externalWorkerId: string | null;
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
  // Unmapped workers still get their exact share (the split depends only on
  // minutes and role, never on account connection); the share is emitted as a
  // held allocation keyed by provider + external ID, so nothing blocks and no
  // clawback is ever needed when they connect later.
  interface RecipientIdentity {
    workerId: string | null;
    provider: string | null;
    externalWorkerId: string | null;
  }
  const scoreByKey = new Map<string, number>();
  const identityByKey = new Map<string, RecipientIdentity>();
  for (const shift of shifts) {
    if (shift.shiftStatus !== "COMPLETED" && shift.shiftStatus !== "APPROVED") continue;
    if (policy.excludedRoles.includes(shift.role)) continue;

    const shiftLabel = shift.workerId ?? `${shift.provider}:${shift.externalWorkerId}`;
    if (shift.workerId === null) {
      issues.push({
        code: "UNMAPPED_WORKER",
        blocking: false,
        detail: {
          externalWorkerId: shift.externalWorkerId,
          provider: shift.provider,
          role: shift.role,
        },
      });
    }
    if (shift.workedMinutes <= 0) {
      issues.push({
        code: "NON_POSITIVE_MINUTES",
        blocking: true,
        detail: { workerId: shiftLabel, workedMinutes: shift.workedMinutes },
      });
      continue;
    }
    const weight = policy.roleWeights[shift.role];
    if (weight === undefined) {
      issues.push({
        code: "UNKNOWN_ROLE",
        blocking: true,
        detail: { workerId: shiftLabel, role: shift.role },
      });
      continue;
    }
    const score = shift.workedMinutes * weight;
    const key = shift.workerId
      ? `worker:${shift.workerId}`
      : `held:${shift.provider}:${shift.externalWorkerId}`;
    scoreByKey.set(key, (scoreByKey.get(key) ?? 0) + score);
    identityByKey.set(
      key,
      shift.workerId
        ? { workerId: shift.workerId, provider: null, externalWorkerId: null }
        : { workerId: null, provider: shift.provider, externalWorkerId: shift.externalWorkerId },
    );
  }

  const totalScore = [...scoreByKey.values()].reduce((a, b) => a + b, 0);

  if (poolUsdCents === 0) {
    issues.push({ code: "EMPTY_POOL", blocking: false, detail: {} });
  }
  if (totalScore === 0) {
    issues.push({ code: "NO_ELIGIBLE_SHIFTS", blocking: poolUsdCents > 0, detail: {} });
    return { poolUsdCents, totalScore, allocations: [], issues };
  }

  // ── Largest-remainder split, exact to the cent ──────────────
  const entries = [...scoreByKey.entries()].sort(([a], [b]) => a.localeCompare(b));
  const raw = entries.map(([key, score]) => {
    const exact = (poolUsdCents * score) / totalScore;
    return { key, score, floor: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });

  let leftover = poolUsdCents - raw.reduce((sum, r) => sum + r.floor, 0);
  const byRemainder = [...raw].sort(
    (a, b) => b.remainder - a.remainder || a.key.localeCompare(b.key),
  );
  for (const r of byRemainder) {
    if (leftover <= 0) break;
    r.floor += 1;
    leftover -= 1;
  }

  const allocations: WorkerAllocationResult[] = raw.map((r) => {
    const identity = identityByKey.get(r.key)!;
    return {
      workerId: identity.workerId,
      provider: identity.provider,
      externalWorkerId: identity.externalWorkerId,
      score: r.score,
      pooledTipUsdCents: r.floor,
      netAllocatedUsdCents: r.floor, // tip-out rules (§10.3) adjust this when implemented
    };
  });

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
