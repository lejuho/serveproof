import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { rebuildVenueIncome } from "@serveproof/db";
import { PrismaService } from "../prisma/prisma.service";

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
  async rebuildVenue(
    venueId: string,
    actorUserId?: string,
    source: "MANUAL" | "PAYROLL_IMPORT" | "SYSTEM" = "SYSTEM",
  ) {
    const result = await rebuildVenueIncome(this.prisma, venueId, actorUserId, source);
    if (!result) throw new NotFoundException(`Venue ${venueId} not found`);
    this.logger.log(
      `rebuilt income for venue ${venueId}: ${result.entriesUpserted} entries, ${result.alerts} alerts`,
    );
    return result;
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
    const alerts = await this.prisma.discrepancyAlert.findMany({
      where: { workerId: worker.id, resolvedAt: null },
      orderBy: { createdAt: "desc" },
    });
    const [venues, shifts] = await Promise.all([
      this.prisma.venue.findMany({
        where: { id: { in: [...new Set(alerts.map((alert) => alert.venueId))] } },
        select: { id: true, name: true },
      }),
      this.prisma.shiftEvidence.findMany({
        where: {
          id: { in: alerts.flatMap((alert) => (alert.shiftId ? [alert.shiftId] : [])) },
        },
        select: { id: true, businessDate: true, role: true },
      }),
    ]);
    const venueById = new Map(venues.map((venue) => [venue.id, venue]));
    const shiftById = new Map(shifts.map((shift) => [shift.id, shift]));
    return alerts.map((alert) => ({
      ...alert,
      venue: venueById.get(alert.venueId) ?? null,
      shift: alert.shiftId ? (shiftById.get(alert.shiftId) ?? null) : null,
    }));
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
