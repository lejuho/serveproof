import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Split an integer-cent total by weights so the slices sum exactly to the
 * total (largest-remainder rounding; equal split when all weights are zero).
 */
function splitProportionally(totalCents: number, weights: number[]): number[] {
  if (!weights.length) return [];
  const weightSum = weights.reduce((s, w) => s + w, 0);
  const effective = weightSum > 0 ? weights : weights.map(() => 1);
  const effectiveSum = weightSum > 0 ? weightSum : weights.length;
  const raw = effective.map((w) => (totalCents * w) / effectiveSum);
  const slices = raw.map(Math.floor);
  let remainder = totalCents - slices.reduce((s, v) => s + v, 0);
  const order = raw
    .map((v, i) => ({ frac: v - Math.floor(v), i }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0; k = (k + 1) % order.length, remainder--) {
    const idx = order[k]?.i ?? 0;
    slices[idx] = (slices[idx] ?? 0) + 1;
  }
  return slices;
}

/**
 * Spec §17 — income and tax observability.
 *
 * IncomeEntry is a per-(worker, shift) projection of the whole lifecycle:
 * earned → allocated → paid → payroll_reported → withheld. Each rebuild
 * recomputes base entries from evidence; entries that have been superseded by
 * corrections (spec §19) are never clobbered.
 */
@Injectable()
export class IncomeService {
  private readonly logger = new Logger(IncomeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Rebuild all base IncomeEntry rows and discrepancy alerts for a venue. */
  async rebuildVenue(venueId: string) {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException(`Venue ${venueId} not found`);

    const [shifts, tips, batches, payrollRecords] = await Promise.all([
      this.prisma.shiftEvidence.findMany({ where: { venueId } }),
      this.prisma.tipEvidence.findMany({ where: { venueId } }),
      this.prisma.allocationBatch.findMany({
        where: { venueId, status: { in: ["PAYABLE", "PARTIALLY_PAID", "PAID"] } },
        include: { allocations: { include: { payouts: true } } },
      }),
      this.prisma.payrollRecord.findMany({ where: { venueId } }),
    ]);

    // tips attributable to a shift (CSV convention: externalPaymentId = csv:<shiftId>)
    const tipsByShiftKey = new Map<string, number>();
    for (const tip of tips) {
      if (tip.refundStatus === "FULL" || tip.paymentStatus === "CANCELED") continue;
      const key = `${tip.provider}:${tip.externalPaymentId.replace(/^csv:/, "")}`;
      tipsByShiftKey.set(key, (tipsByShiftKey.get(key) ?? 0) + tip.grossAmountUsdCents);
    }

    // Day-level amounts (allocation, payout) and period-level amounts
    // (payroll) must be split across a worker's shifts, never copied to each —
    // copies inflate summaries and disclosed totals. Splits are proportional
    // to worked minutes (equal when unknown) and preserve the exact total.
    const mappedShifts = shifts.filter((s) => s.mappedWorkerId);
    const shiftsByWorkerDay = new Map<string, typeof shifts>();
    for (const s of mappedShifts) {
      const key = `${s.mappedWorkerId}:${s.businessDate}`;
      shiftsByWorkerDay.set(key, [...(shiftsByWorkerDay.get(key) ?? []), s]);
    }
    const allocShare = new Map<string, number>();
    const paidShare = new Map<string, number>();
    for (const dayShifts of shiftsByWorkerDay.values()) {
      const first = dayShifts[0];
      if (!first) continue;
      const workerId = first.mappedWorkerId as string;
      const batch = batches.find((b) => b.businessDate === first.businessDate);
      const allocation = batch?.allocations.find((a) => a.workerId === workerId);
      const finalizedPayout = allocation?.payouts.find((p) => p.status === "FINALIZED");
      const weights = dayShifts.map((s) => Math.max(s.workedMinutes, 0));
      const allocSlices = splitProportionally(allocation?.netAllocatedUsdCents ?? 0, weights);
      const paidSlices = splitProportionally(finalizedPayout?.amountUsdCents ?? 0, weights);
      dayShifts.forEach((s, i) => {
        allocShare.set(s.id, allocSlices[i] ?? 0);
        paidShare.set(s.id, paidSlices[i] ?? 0);
      });
    }
    const payrollShare = new Map<string, number>();
    for (const record of payrollRecords) {
      const periodShifts = mappedShifts.filter((s) => {
        const d = new Date(`${s.businessDate}T12:00:00Z`);
        return s.mappedWorkerId === record.workerId && record.periodStart <= d && record.periodEnd >= d;
      });
      if (!periodShifts.length) continue;
      // weight by attributed allocation so reported tips line up with the
      // shifts they cover; equal split when nothing was allocated
      const weights = periodShifts.map((s) => allocShare.get(s.id) ?? 0);
      const slices = splitProportionally(record.reportedTipUsdCents, weights);
      periodShifts.forEach((s, i) => payrollShare.set(s.id, slices[i] ?? 0));
    }

    let entriesUpserted = 0;
    const alerts: {
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
    }[] = [];

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

      // allocation for this worker on this business date (approved batches
      // only), attributed to this shift by its share of the day's minutes
      const batch = batches.find((b) => b.businessDate === shift.businessDate);
      const allocation = batch?.allocations.find((a) => a.workerId === workerId);
      const allocatedUsdCents = allocShare.get(shift.id) ?? 0;

      const finalizedPayout = allocation?.payouts.find((p) => p.status === "FINALIZED");
      const paidUsdCents = paidShare.get(shift.id) ?? 0;
      const payoutRail = finalizedPayout?.rail ?? allocation?.payoutRail ?? null;

      // payroll record covering this business date; its period total is
      // distributed across the covered shifts
      const businessDate = new Date(`${shift.businessDate}T12:00:00Z`);
      const payroll = payrollRecords.find(
        (r) =>
          r.workerId === workerId && r.periodStart <= businessDate && r.periodEnd >= businessDate,
      );
      const payrollReportedUsdCents = payroll ? (payrollShare.get(shift.id) ?? 0) : 0;
      const withholdingStatus = !payroll
        ? ("UNKNOWN" as const)
        : payroll.federalWithholdingUsdCents !== null && payroll.status === "PROVIDER_CONFIRMED"
          ? ("CONFIRMED" as const)
          : ("PENDING" as const);

      const evidenceGrade = this.computeGrade({
        hasTipEvidence: earnedUsdCents > 0 || (batch?.tipPoolAmountUsdCents ?? 0) > 0,
        hasShiftEvidence: true,
        hasApprovedAllocation: allocatedUsdCents > 0,
        usdcFinalized: finalizedPayout?.rail === "USDC",
        venueAttestedPayout: !!finalizedPayout && finalizedPayout.rail !== "USDC",
        payrollConfirmed: withholdingStatus === "CONFIRMED",
      });

      // never clobber corrected lineages (spec §19)
      const superseded = await this.prisma.incomeEntry.findFirst({
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
      const existing = await this.prisma.incomeEntry.findFirst({
        where: { workerId, shiftId: shift.id, correctionOfId: null },
      });
      if (existing) {
        await this.prisma.incomeEntry.update({ where: { id: existing.id }, data });
      } else {
        await this.prisma.incomeEntry.create({ data });
      }
      entriesUpserted++;

      // ── discrepancy rules (spec §17.1) ─────────────────────────
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

    // refund exists && paid amount unchanged (spec §17.1, venue-level)
    const refundedTips = tips.filter((t) => t.refundStatus !== "NONE");
    for (const tip of refundedTips) {
      const batch = batches.find((b) => b.businessDate === tip.businessDate);
      const anyPaid = batch?.allocations.some((a) => a.payoutStatus === "PAID");
      if (anyPaid) {
        alerts.push({
          workerId: null,
          shiftId: null,
          type: "REFUND_ADJUSTMENT_REQUIRED",
          detail: { tipEvidenceId: tip.id, refundStatus: tip.refundStatus },
        });
      }
    }

    // replace unresolved alerts for this venue (idempotent rebuild)
    await this.prisma.$transaction([
      this.prisma.discrepancyAlert.deleteMany({ where: { venueId, resolvedAt: null } }),
      this.prisma.discrepancyAlert.createMany({
        data: alerts.map((a) => ({
          venueId,
          workerId: a.workerId,
          shiftId: a.shiftId,
          type: a.type,
          detail: JSON.parse(JSON.stringify(a.detail)),
        })),
      }),
    ]);

    this.logger.log(
      `rebuilt income for venue ${venueId}: ${entriesUpserted} entries, ${alerts.length} alerts`,
    );
    return { entriesUpserted, alerts: alerts.length };
  }

  /** Spec §18 — evidence grade ladder. */
  private computeGrade(input: {
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

  private async workerOf(userId: string) {
    const worker = await this.prisma.worker.findUnique({ where: { userId } });
    if (!worker) throw new NotFoundException("No worker profile for this user");
    return worker;
  }

  /** Spec §22 — GET /workers/me/income-timeline */
  async timelineForUser(userId: string) {
    const worker = await this.workerOf(userId);
    const entries = await this.prisma.incomeEntry.findMany({
      where: { workerId: worker.id, effectiveStatus: "ACTIVE" },
      include: {
        shift: {
          select: {
            businessDate: true,
            role: true,
            clockIn: true,
            clockOut: true,
            provider: true,
            ingestSource: true,
          },
        },
        venue: { select: { id: true, name: true } },
        payout: { select: { txSignature: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    return entries.map((e) => ({
      id: e.id,
      venue: e.venue,
      businessDate: e.shift?.businessDate ?? null,
      role: e.shift?.role ?? null,
      evidenceProvider: e.shift?.provider ?? null,
      ingestSource: e.shift?.ingestSource ?? null,
      earnedUsdCents: e.earnedUsdCents,
      allocatedUsdCents: e.allocatedUsdCents,
      paidUsdCents: e.paidUsdCents,
      payrollReportedUsdCents: e.payrollReportedUsdCents,
      withholdingStatus: e.withholdingStatus,
      payoutRail: e.payoutRail,
      payoutTxSignature: e.payout?.txSignature ?? null,
      evidenceGrade: e.evidenceGrade,
      isCorrection: e.correctionOfId !== null,
      correctionReason: e.correctionReason,
    }));
  }

  /** Spec §22 — GET /workers/me/income-summary */
  async summaryForUser(userId: string) {
    const worker = await this.workerOf(userId);
    const entries = await this.prisma.incomeEntry.findMany({
      where: { workerId: worker.id, effectiveStatus: "ACTIVE" },
      include: { shift: { select: { businessDate: true, ingestSource: true } } },
    });
    const totals = entries.reduce(
      (acc, e) => ({
        earnedUsdCents: acc.earnedUsdCents + e.earnedUsdCents,
        allocatedUsdCents: acc.allocatedUsdCents + e.allocatedUsdCents,
        paidUsdCents: acc.paidUsdCents + e.paidUsdCents,
        payrollReportedUsdCents: acc.payrollReportedUsdCents + e.payrollReportedUsdCents,
      }),
      { earnedUsdCents: 0, allocatedUsdCents: 0, paidUsdCents: 0, payrollReportedUsdCents: 0 },
    );
    const months = new Set(entries.map((e) => e.shift?.businessDate?.slice(0, 7)).filter(Boolean));
    const payers = new Set(entries.map((e) => e.venueId));
    const gradeCounts: Record<string, number> = {};
    for (const e of entries) gradeCounts[e.evidenceGrade] = (gradeCounts[e.evidenceGrade] ?? 0) + 1;
    const providerVerifiedShiftCount = entries.filter(
      (e) => e.shift?.ingestSource === "PROVIDER_API",
    ).length;

    return {
      totals,
      shiftCount: entries.length,
      monthCount: months.size,
      avgMonthlyAllocatedUsdCents:
        months.size > 0 ? Math.round(totals.allocatedUsdCents / months.size) : 0,
      payerCount: payers.size,
      gradeCounts,
      // shifts whose evidence came from a third-party provider API (not self-reported)
      providerVerifiedShiftCount,
    };
  }

  /** Spec §22 — GET /workers/me/discrepancies */
  async discrepanciesForUser(userId: string) {
    const worker = await this.workerOf(userId);
    return this.prisma.discrepancyAlert.findMany({
      where: { workerId: worker.id, resolvedAt: null },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Spec §19 — correction: the original row is never mutated beyond its
   * effectiveStatus; a new entry carries the corrected values.
   */
  async correctEntry(
    entryId: string,
    actorUserId: string,
    input: {
      reason: string;
      earnedUsdCents?: number;
      allocatedUsdCents?: number;
      paidUsdCents?: number;
      payrollReportedUsdCents?: number;
    },
  ) {
    const original = await this.prisma.incomeEntry.findUnique({ where: { id: entryId } });
    if (!original) throw new NotFoundException(`Income entry ${entryId} not found`);
    if (original.effectiveStatus !== "ACTIVE") {
      throw new NotFoundException("Only the ACTIVE entry of a lineage can be corrected");
    }

    const [, correction] = await this.prisma.$transaction([
      this.prisma.incomeEntry.update({
        where: { id: entryId },
        data: { effectiveStatus: "SUPERSEDED" },
      }),
      this.prisma.incomeEntry.create({
        data: {
          workerId: original.workerId,
          venueId: original.venueId,
          shiftId: original.shiftId,
          payoutId: original.payoutId,
          earnedUsdCents: input.earnedUsdCents ?? original.earnedUsdCents,
          allocatedUsdCents: input.allocatedUsdCents ?? original.allocatedUsdCents,
          paidUsdCents: input.paidUsdCents ?? original.paidUsdCents,
          payrollReportedUsdCents:
            input.payrollReportedUsdCents ?? original.payrollReportedUsdCents,
          withholdingStatus: original.withholdingStatus,
          payoutRail: original.payoutRail,
          evidenceGrade: original.evidenceGrade,
          effectiveStatus: "ACTIVE",
          originalEntryId: original.originalEntryId ?? original.id,
          correctionOfId: original.id,
          correctionReason: input.reason,
        },
      }),
      this.prisma.auditLog.create({
        data: {
          venueId: original.venueId,
          actorUserId,
          action: "INCOME_ENTRY_CORRECTED",
          entityType: "IncomeEntry",
          entityId: entryId,
          detail: { reason: input.reason },
        },
      }),
      // Spec §26 step 24 — issued reports for this worker flip to CORRECTED
      this.prisma.verificationReport.updateMany({
        where: { workerId: original.workerId, status: "ISSUED" },
        data: { status: "CORRECTED" },
      }),
    ]);
    return correction;
  }
}
