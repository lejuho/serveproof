import { Injectable, NotFoundException } from "@nestjs/common";
import { IncomeService } from "../income/income.service";
import { PrismaService } from "../prisma/prisma.service";

export interface PayrollImportRecord {
  workerEmail: string;
  periodStart: string;
  periodEnd: string;
  reportedTipUsdCents: number;
  federalWithholdingUsdCents?: number;
  stateWithholdingUsdCents?: number;
  socialSecurityUsdCents?: number;
  medicareUsdCents?: number;
  status: "PENDING" | "PROVIDER_CONFIRMED";
  providerReference?: string;
}

/**
 * Spec §3.3/§7.4 — payroll observability with a mock provider. Records arrive
 * as if from MockGustoPayrollProvider; matching is by worker email.
 */
@Injectable()
export class PayrollService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly income: IncomeService,
  ) {}

  async importRecords(venueId: string, provider: string, records: PayrollImportRecord[]) {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException(`Venue ${venueId} not found`);

    let imported = 0;
    const skipped: { workerEmail: string; reason: string }[] = [];

    for (const record of records) {
      const user = await this.prisma.user.findUnique({
        where: { email: record.workerEmail.toLowerCase() },
        include: { worker: true },
      });
      if (!user?.worker) {
        skipped.push({ workerEmail: record.workerEmail, reason: "no worker profile" });
        continue;
      }
      const periodStart = new Date(record.periodStart);
      const periodEnd = new Date(record.periodEnd);

      const existing = await this.prisma.payrollRecord.findFirst({
        where: { workerId: user.worker.id, venueId, periodStart, periodEnd },
      });
      const data = {
        workerId: user.worker.id,
        venueId,
        periodStart,
        periodEnd,
        reportedTipUsdCents: record.reportedTipUsdCents,
        federalWithholdingUsdCents: record.federalWithholdingUsdCents ?? null,
        stateWithholdingUsdCents: record.stateWithholdingUsdCents ?? null,
        socialSecurityUsdCents: record.socialSecurityUsdCents ?? null,
        medicareUsdCents: record.medicareUsdCents ?? null,
        status: record.status,
        providerReference: record.providerReference ?? `${provider}:${record.periodStart}`,
      };
      if (existing) {
        await this.prisma.payrollRecord.update({ where: { id: existing.id }, data });
      } else {
        await this.prisma.payrollRecord.create({ data });
      }
      imported++;
    }

    // payroll changes shift the whole observability picture — rebuild now
    await this.income.rebuildVenue(venueId, undefined, "PAYROLL_IMPORT");
    return { imported, skipped };
  }

  async statusForWorker(workerId: string) {
    const worker = await this.prisma.worker.findUnique({ where: { id: workerId } });
    if (!worker) throw new NotFoundException(`Worker ${workerId} not found`);
    return this.prisma.payrollRecord.findMany({
      where: { workerId },
      orderBy: { periodStart: "desc" },
      include: { venue: { select: { id: true, name: true } } },
    });
  }
}
