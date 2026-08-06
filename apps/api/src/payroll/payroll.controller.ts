import { Body, Controller, ForbiddenException, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { AccessService, VENUE_READ_ROLES } from "../auth/access.service";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { parseBody } from "../common/zod";
import { PrismaService } from "../prisma/prisma.service";
import { PayrollService } from "./payroll.service";

// Spec §11.3 — PAYROLL_ADMIN can modify payroll state (plus OWNER/MANAGER)
const PAYROLL_WRITE_ROLES = ["OWNER", "MANAGER", "PAYROLL_ADMIN"] as const;

const importSchema = z.object({
  venueId: z.uuid(),
  provider: z.string().min(1).default("gusto_mock"),
  records: z
    .array(
      z.object({
        workerEmail: z.email(),
        periodStart: z.iso.datetime(),
        periodEnd: z.iso.datetime(),
        reportedTipUsdCents: z.number().int().nonnegative(),
        federalWithholdingUsdCents: z.number().int().nonnegative().optional(),
        stateWithholdingUsdCents: z.number().int().nonnegative().optional(),
        socialSecurityUsdCents: z.number().int().nonnegative().optional(),
        medicareUsdCents: z.number().int().nonnegative().optional(),
        status: z.enum(["PENDING", "PROVIDER_CONFIRMED"]),
        providerReference: z.string().optional(),
      }),
    )
    .min(1),
});

@Controller()
export class PayrollController {
  constructor(
    private readonly payroll: PayrollService,
    private readonly access: AccessService,
    private readonly prisma: PrismaService,
  ) {}

  // Spec §22 — POST /payroll/import
  @Post("payroll/import")
  async import(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = parseBody(importSchema, body);
    await this.access.assertVenueRole(user.id, input.venueId, [...PAYROLL_WRITE_ROLES]);
    return this.payroll.importRecords(input.venueId, input.provider, input.records);
  }

  // Spec §22 — GET /workers/:workerId/payroll-status (self or venue staff)
  @Get("workers/:workerId/payroll-status")
  async status(@CurrentUser() user: AuthenticatedUser, @Param("workerId") workerId: string) {
    const worker = await this.prisma.worker.findUnique({ where: { id: workerId } });
    if (worker?.userId !== user.id) {
      // not the worker themself — require venue-staff membership in any venue
      // where this worker has income entries
      const entry = await this.prisma.incomeEntry.findFirst({
        where: { workerId },
        select: { venueId: true },
      });
      if (!entry) throw new ForbiddenException("Not authorized for this worker");
      await this.access.assertVenueRole(user.id, entry.venueId, VENUE_READ_ROLES);
    }
    return this.payroll.statusForWorker(workerId);
  }
}
