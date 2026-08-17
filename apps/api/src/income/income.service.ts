import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma, rebuildVenueIncome } from "@serveproof/db";
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
  async timelineForUser(userId: string, cursor?: string, limit = 25) {
    const worker = await this.workerOf(userId);
    return this.timelineForWorker(worker.id, cursor, limit);
  }

  async timelineForWorker(workerId: string, cursor?: string, limit = 25) {
    const entries = await this.prisma.incomeEntry.findMany({
      where: { workerId, effectiveStatus: "ACTIVE" },
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
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: limit + 1,
    });
    const hasMore = entries.length > limit;
    const page = hasMore ? entries.slice(0, limit) : entries;
    const items = page.map((e) => ({
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
    return {
      items,
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** Spec §22 — GET /workers/me/income-summary */
  async summaryForUser(userId: string) {
    const worker = await this.workerOf(userId);
    return this.summaryForWorker(worker.id);
  }

  async summaryForWorker(workerId: string) {
    const [summaryRows, grades] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          earnedUsdCents: bigint;
          allocatedUsdCents: bigint;
          paidUsdCents: bigint;
          payrollReportedUsdCents: bigint;
          shiftCount: bigint;
          monthCount: bigint;
          payerCount: bigint;
          providerVerifiedShiftCount: bigint;
        }>
      >(Prisma.sql`
        SELECT
          COALESCE(SUM(i."earnedUsdCents"), 0) AS "earnedUsdCents",
          COALESCE(SUM(i."allocatedUsdCents"), 0) AS "allocatedUsdCents",
          COALESCE(SUM(i."paidUsdCents"), 0) AS "paidUsdCents",
          COALESCE(SUM(i."payrollReportedUsdCents"), 0) AS "payrollReportedUsdCents",
          COUNT(*) AS "shiftCount",
          COUNT(DISTINCT LEFT(s."businessDate", 7)) AS "monthCount",
          COUNT(DISTINCT i."venueId") AS "payerCount",
          COUNT(*) FILTER (WHERE s."ingestSource" = 'PROVIDER_API') AS "providerVerifiedShiftCount"
        FROM "IncomeEntry" i
        LEFT JOIN "ShiftEvidence" s ON s.id = i."shiftId"
        WHERE i."workerId" = ${workerId}
          AND i."effectiveStatus" = 'ACTIVE'
      `),
      this.prisma.incomeEntry.groupBy({
        by: ["evidenceGrade"],
        where: { workerId, effectiveStatus: "ACTIVE" },
        _count: { _all: true },
      }),
    ]);
    const row = summaryRows[0]!;
    const totals = {
      earnedUsdCents: Number(row.earnedUsdCents),
      allocatedUsdCents: Number(row.allocatedUsdCents),
      paidUsdCents: Number(row.paidUsdCents),
      payrollReportedUsdCents: Number(row.payrollReportedUsdCents),
    };
    const monthCount = Number(row.monthCount);
    const gradeCounts = Object.fromEntries(
      grades.map((grade) => [grade.evidenceGrade, grade._count._all]),
    );

    return {
      totals,
      shiftCount: Number(row.shiftCount),
      monthCount,
      avgMonthlyAllocatedUsdCents:
        monthCount > 0 ? Math.round(totals.allocatedUsdCents / monthCount) : 0,
      payerCount: Number(row.payerCount),
      gradeCounts,
      // shifts whose evidence came from a third-party provider API (not self-reported)
      providerVerifiedShiftCount: Number(row.providerVerifiedShiftCount),
    };
  }

  /** Spec §22 — GET /workers/me/discrepancies */
  async discrepanciesForUser(userId: string) {
    const worker = await this.workerOf(userId);
    return this.discrepanciesForWorker(worker.id);
  }

  async discrepanciesForWorker(workerId: string) {
    const alerts = await this.prisma.discrepancyAlert.findMany({
      where: { workerId, resolvedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (alerts.length === 0) return [];
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
