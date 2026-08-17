import { Prisma, type PrismaClient } from "@prisma/client";

export type IncomeProjectionSource = "MANUAL" | "PAYROLL_IMPORT" | "SYSTEM";

export interface IncomeProjectionResult {
  entriesUpserted: number;
  alerts: number;
}

function splitProportionally(totalCents: number, weights: number[]): number[] {
  if (!weights.length) return [];
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const effective = weightSum > 0 ? weights : weights.map(() => 1);
  const effectiveSum = weightSum > 0 ? weightSum : weights.length;
  const raw = effective.map((weight) => (totalCents * weight) / effectiveSum);
  const slices = raw.map(Math.floor);
  let remainder = totalCents - slices.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ fraction: value - Math.floor(value), index }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let cursor = 0; remainder > 0; cursor = (cursor + 1) % order.length, remainder--) {
    const index = order[cursor]?.index ?? 0;
    slices[index] = (slices[index] ?? 0) + 1;
  }
  return slices;
}

function computeGrade(input: {
  hasTipEvidence: boolean;
  hasShiftEvidence: boolean;
  hasApprovedAllocation: boolean;
  usdcFinalized: boolean;
  venueAttestedPayout: boolean;
  payrollConfirmed: boolean;
}): "A" | "B" | "C" | "D" | "E" {
  const base = input.hasTipEvidence && input.hasShiftEvidence;
  if (base && input.hasApprovedAllocation) {
    if ((input.usdcFinalized || input.venueAttestedPayout) && input.payrollConfirmed) return "A";
    if (input.usdcFinalized) return "B";
    if (input.venueAttestedPayout) return "C";
  }
  if (base) return "D";
  return "E";
}

/**
 * Rebuilds the materialized income view and unresolved discrepancy alerts for
 * one venue. API and Worker both call this function so payout finalization and
 * manual rebuilds cannot drift into different projection rules.
 */
async function rebuildVenueIncomeLocked(
  prisma: Prisma.TransactionClient,
  venueId: string,
  actorUserId?: string,
  source: IncomeProjectionSource = "SYSTEM",
): Promise<IncomeProjectionResult> {
  const [shifts, tips, batches, payrollRecords] = await Promise.all([
    prisma.shiftEvidence.findMany({ where: { venueId } }),
    prisma.tipEvidence.findMany({ where: { venueId } }),
    prisma.allocationBatch.findMany({
      where: { venueId, status: { in: ["PAYABLE", "PARTIALLY_PAID", "PAID"] } },
      include: { allocations: { include: { payouts: true } } },
    }),
    prisma.payrollRecord.findMany({ where: { venueId } }),
  ]);

  const tipsByShiftKey = new Map<string, number>();
  for (const tip of tips) {
    if (tip.refundStatus === "FULL" || tip.paymentStatus === "CANCELED") continue;
    const key = `${tip.provider}:${tip.externalPaymentId.replace(/^csv:/, "")}`;
    tipsByShiftKey.set(key, (tipsByShiftKey.get(key) ?? 0) + tip.grossAmountUsdCents);
  }

  const mappedShifts = shifts.filter((shift) => shift.mappedWorkerId);
  const shiftsByWorkerDay = new Map<string, typeof shifts>();
  for (const shift of mappedShifts) {
    const key = `${shift.mappedWorkerId}:${shift.businessDate}`;
    shiftsByWorkerDay.set(key, [...(shiftsByWorkerDay.get(key) ?? []), shift]);
  }

  const allocationShare = new Map<string, number>();
  const paidShare = new Map<string, number>();
  for (const dayShifts of shiftsByWorkerDay.values()) {
    const first = dayShifts[0];
    if (!first) continue;
    const workerId = first.mappedWorkerId as string;
    const batch = batches.find((candidate) => candidate.businessDate === first.businessDate);
    const allocation = batch?.allocations.find((candidate) => candidate.workerId === workerId);
    const finalizedPayout = allocation?.payouts.find((payout) => payout.status === "FINALIZED");
    const weights = dayShifts.map((shift) => Math.max(shift.workedMinutes, 0));
    const allocationSlices = splitProportionally(allocation?.netAllocatedUsdCents ?? 0, weights);
    const paidSlices = splitProportionally(finalizedPayout?.amountUsdCents ?? 0, weights);
    dayShifts.forEach((shift, index) => {
      allocationShare.set(shift.id, allocationSlices[index] ?? 0);
      paidShare.set(shift.id, paidSlices[index] ?? 0);
    });
  }

  const payrollShare = new Map<string, number>();
  for (const record of payrollRecords) {
    const periodShifts = mappedShifts.filter((shift) => {
      const date = new Date(`${shift.businessDate}T12:00:00Z`);
      return (
        shift.mappedWorkerId === record.workerId &&
        record.periodStart <= date &&
        record.periodEnd >= date
      );
    });
    if (!periodShifts.length) continue;
    const weights = periodShifts.map((shift) => allocationShare.get(shift.id) ?? 0);
    const slices = splitProportionally(record.reportedTipUsdCents, weights);
    periodShifts.forEach((shift, index) => payrollShare.set(shift.id, slices[index] ?? 0));
  }

  let entriesUpserted = 0;
  const alerts: Array<{
    workerId: string | null;
    shiftId: string | null;
    type:
      | "ALLOCATION_GAP"
      | "PAYOUT_GAP"
      | "PAYROLL_GAP"
      | "WITHHOLDING_UNKNOWN"
      | "REFUND_ADJUSTMENT_REQUIRED"
      | "UNMAPPED_WORKER";
    detail: Record<string, unknown>;
  }> = [];

  for (const shift of shifts) {
    if (!shift.mappedWorkerId) {
      alerts.push({
        workerId: null,
        shiftId: shift.id,
        type: "UNMAPPED_WORKER",
        detail: { externalWorkerId: shift.externalWorkerId, provider: shift.provider },
      });
      continue;
    }

    const workerId = shift.mappedWorkerId;
    const earnedUsdCents = tipsByShiftKey.get(`${shift.provider}:${shift.externalShiftId}`) ?? 0;
    const batch = batches.find((candidate) => candidate.businessDate === shift.businessDate);
    const allocation = batch?.allocations.find((candidate) => candidate.workerId === workerId);
    const allocatedUsdCents = allocationShare.get(shift.id) ?? 0;
    const finalizedPayout = allocation?.payouts.find((payout) => payout.status === "FINALIZED");
    const paidUsdCents = paidShare.get(shift.id) ?? 0;
    const payoutRail = finalizedPayout?.rail ?? allocation?.payoutRail ?? null;

    const businessDate = new Date(`${shift.businessDate}T12:00:00Z`);
    const payroll = payrollRecords.find(
      (record) =>
        record.workerId === workerId &&
        record.periodStart <= businessDate &&
        record.periodEnd >= businessDate,
    );
    const payrollReportedUsdCents = payroll ? (payrollShare.get(shift.id) ?? 0) : 0;
    const withholdingStatus = !payroll
      ? ("UNKNOWN" as const)
      : payroll.federalWithholdingUsdCents !== null && payroll.status === "PROVIDER_CONFIRMED"
        ? ("CONFIRMED" as const)
        : ("PENDING" as const);

    const evidenceGrade = computeGrade({
      hasTipEvidence: earnedUsdCents > 0 || (batch?.tipPoolAmountUsdCents ?? 0) > 0,
      hasShiftEvidence: true,
      hasApprovedAllocation: allocatedUsdCents > 0,
      usdcFinalized: finalizedPayout?.rail === "USDC",
      venueAttestedPayout: Boolean(finalizedPayout && finalizedPayout.rail !== "USDC"),
      payrollConfirmed: withholdingStatus === "CONFIRMED",
    });

    const superseded = await prisma.incomeEntry.findFirst({
      where: { workerId, shiftId: shift.id, effectiveStatus: "SUPERSEDED" },
      select: { id: true },
    });
    if (superseded) continue;

    const data = {
      workerId,
      venueId,
      shiftId: shift.id,
      payoutId: finalizedPayout?.id ?? null,
      earnedUsdCents,
      allocatedUsdCents,
      paidUsdCents,
      payrollReportedUsdCents,
      withholdingStatus,
      payoutRail,
      evidenceGrade,
      effectiveStatus: "ACTIVE" as const,
    };
    const existing = await prisma.incomeEntry.findFirst({
      where: { workerId, shiftId: shift.id, correctionOfId: null },
    });
    if (existing) {
      await prisma.incomeEntry.update({ where: { id: existing.id }, data });
    } else {
      await prisma.incomeEntry.create({ data });
    }
    entriesUpserted++;

    if (earnedUsdCents > 0 && allocatedUsdCents === 0) {
      alerts.push({
        workerId,
        shiftId: shift.id,
        type: "ALLOCATION_GAP",
        detail: { earnedUsdCents, allocatedUsdCents },
      });
    }
    if (allocatedUsdCents > 0 && paidUsdCents === 0) {
      alerts.push({
        workerId,
        shiftId: shift.id,
        type: "PAYOUT_GAP",
        detail: { allocatedUsdCents, paidUsdCents },
      });
    }
    if (paidUsdCents > 0 && payrollReportedUsdCents === 0) {
      alerts.push({
        workerId,
        shiftId: shift.id,
        type: "PAYROLL_GAP",
        detail: { paidUsdCents, payrollReportedUsdCents, payoutRail },
      });
    }
    if (payrollReportedUsdCents > 0 && withholdingStatus !== "CONFIRMED") {
      alerts.push({
        workerId,
        shiftId: shift.id,
        type: "WITHHOLDING_UNKNOWN",
        detail: { payrollReportedUsdCents },
      });
    }
  }

  for (const tip of tips.filter((candidate) => candidate.refundStatus !== "NONE")) {
    const batch = batches.find((candidate) => candidate.businessDate === tip.businessDate);
    if (batch?.allocations.some((allocation) => allocation.payoutStatus === "PAID")) {
      alerts.push({
        workerId: null,
        shiftId: null,
        type: "REFUND_ADJUSTMENT_REQUIRED",
        detail: { tipEvidenceId: tip.id, refundStatus: tip.refundStatus },
      });
    }
  }

  await prisma.discrepancyAlert.deleteMany({ where: { venueId, resolvedAt: null } });
  await prisma.discrepancyAlert.createMany({
    data: alerts.map((alert) => ({
      venueId,
      workerId: alert.workerId,
      shiftId: alert.shiftId,
      type: alert.type,
      detail: JSON.parse(JSON.stringify(alert.detail)),
    })),
  });
  await prisma.auditLog.create({
    data: {
      venueId,
      actorUserId: actorUserId ?? null,
      action: "INCOME_ENTRIES_REBUILT",
      entityType: "Venue",
      entityId: venueId,
      detail: { source, entriesUpserted, alerts: alerts.length },
    },
  });

  return { entriesUpserted, alerts: alerts.length };
}

export async function rebuildVenueIncome(
  prisma: PrismaClient,
  venueId: string,
  actorUserId?: string,
  source: IncomeProjectionSource = "SYSTEM",
): Promise<IncomeProjectionResult | null> {
  return prisma.$transaction(
    async (transaction) => {
      // One projection per venue at a time across API and Worker processes.
      // The row lock prevents concurrent payout finalizations from replacing
      // a newer discrepancy set with a snapshot read just before another
      // payout committed.
      const locked = await transaction.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT "id" FROM "Venue" WHERE "id" = ${venueId} FOR UPDATE`,
      );
      if (locked.length === 0) return null;
      return rebuildVenueIncomeLocked(transaction, venueId, actorUserId, source);
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
}
