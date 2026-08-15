import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { normalizeCsv } from "./csv-normalizer";

export interface CsvImportSummary {
  tipsUpserted: number;
  shiftsUpserted: number;
  mappedShifts: number;
  unmappedShifts: number;
  businessDates: string[];
  errors: { line: number; message: string }[];
}

@Injectable()
export class EvidenceService {
  constructor(private readonly prisma: PrismaService) {}

  async importCsv(venueId: string, csvText: string): Promise<CsvImportSummary> {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException(`Venue ${venueId} not found`);

    const normalized = normalizeCsv(csvText, venue.timezone);

    // Resolve confirmed external worker mappings for this venue (spec §1.4/§7)
    const mappings = await this.prisma.externalWorkerAccount.findMany({
      where: { venueId, mappingStatus: "CONFIRMED" },
    });
    const workerByExternalId = new Map(
      mappings.map((m) => [`${m.provider}:${m.externalWorkerId}`, m.workerId]),
    );

    let tipsUpserted = 0;
    let shiftsUpserted = 0;
    let mappedShifts = 0;
    let unmappedShifts = 0;

    for (const tip of normalized.tips) {
      await this.prisma.tipEvidence.upsert({
        where: {
          venueId_provider_externalPaymentId_tipType: {
            venueId,
            provider: tip.provider,
            externalPaymentId: tip.externalPaymentId,
            tipType: tip.tipType,
          },
        },
        update: {
          grossAmountUsdCents: tip.grossAmountUsdCents,
          businessDate: tip.businessDate,
          sourceHash: tip.sourceHash,
        },
        create: {
          venueId,
          provider: tip.provider,
          externalPaymentId: tip.externalPaymentId,
          tipType: tip.tipType,
          grossAmountUsdCents: tip.grossAmountUsdCents,
          businessDate: tip.businessDate,
          sourceHash: tip.sourceHash,
        },
      });
      tipsUpserted++;
    }

    for (const shift of normalized.shifts) {
      const mappedWorkerId =
        workerByExternalId.get(`${shift.provider}:${shift.externalWorkerId}`) ?? null;
      if (mappedWorkerId) mappedShifts++;
      else unmappedShifts++;

      await this.prisma.shiftEvidence.upsert({
        where: {
          venueId_provider_externalShiftId: {
            venueId,
            provider: shift.provider,
            externalShiftId: shift.externalShiftId,
          },
        },
        update: {
          externalWorkerId: shift.externalWorkerId,
          mappedWorkerId,
          role: shift.role,
          clockIn: shift.clockIn,
          clockOut: shift.clockOut,
          workedMinutes: shift.workedMinutes,
          businessDate: shift.businessDate,
          sourceHash: shift.sourceHash,
        },
        create: {
          venueId,
          provider: shift.provider,
          externalShiftId: shift.externalShiftId,
          externalWorkerId: shift.externalWorkerId,
          mappedWorkerId,
          role: shift.role,
          clockIn: shift.clockIn,
          clockOut: shift.clockOut,
          workedMinutes: shift.workedMinutes,
          businessDate: shift.businessDate,
          sourceHash: shift.sourceHash,
        },
      });
      shiftsUpserted++;
    }

    // distinct business dates seen in this import, so the UI can preselect
    // the calculation date instead of asking the manager to retype it
    const businessDates = [
      ...new Set([
        ...normalized.shifts.map((s) => s.businessDate),
        ...normalized.tips.map((t) => t.businessDate),
      ]),
    ].sort();

    return {
      tipsUpserted,
      shiftsUpserted,
      mappedShifts,
      unmappedShifts,
      businessDates,
      errors: normalized.errors,
    };
  }

  listTipEvidence(venueId: string, businessDate?: string) {
    return this.prisma.tipEvidence.findMany({
      where: { venueId, ...(businessDate ? { businessDate } : {}) },
      orderBy: { businessDate: "desc" },
    });
  }

  listShiftEvidence(venueId: string, businessDate?: string) {
    return this.prisma.shiftEvidence.findMany({
      where: { venueId, ...(businessDate ? { businessDate } : {}) },
      orderBy: { clockIn: "asc" },
    });
  }
}
