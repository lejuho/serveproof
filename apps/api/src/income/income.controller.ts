import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { AccessService, VENUE_MANAGE_ROLES } from "../auth/access.service";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { parseBody } from "../common/zod";
import { PrismaService } from "../prisma/prisma.service";
import { IncomeService } from "./income.service";

const correctionSchema = z.object({
  reason: z.string().min(1),
  earnedUsdCents: z.number().int().nonnegative().optional(),
  allocatedUsdCents: z.number().int().nonnegative().optional(),
  paidUsdCents: z.number().int().nonnegative().optional(),
  payrollReportedUsdCents: z.number().int().nonnegative().optional(),
});

@Controller()
export class IncomeController {
  constructor(
    private readonly income: IncomeService,
    private readonly access: AccessService,
    private readonly prisma: PrismaService,
  ) {}

  // Venue-side: recompute projections + discrepancy alerts
  @Post("venues/:venueId/income/rebuild")
  async rebuild(@CurrentUser() user: AuthenticatedUser, @Param("venueId") venueId: string) {
    await this.access.assertVenueRole(user.id, venueId, VENUE_MANAGE_ROLES);
    return this.income.rebuildVenue(venueId);
  }

  // Spec §22 — worker self-service income endpoints
  @Get("workers/me/income-timeline")
  timeline(@CurrentUser() user: AuthenticatedUser) {
    return this.income.timelineForUser(user.id);
  }

  @Get("workers/me/income-summary")
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.income.summaryForUser(user.id);
  }

  @Get("workers/me/discrepancies")
  discrepancies(@CurrentUser() user: AuthenticatedUser) {
    return this.income.discrepanciesForUser(user.id);
  }

  // Spec §19 — corrections (venue managers only)
  @Post("income-entries/:id/correct")
  async correct(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = parseBody(correctionSchema, body);
    const entry = await this.prisma.incomeEntry.findUnique({
      where: { id },
      select: { venueId: true },
    });
    if (entry) await this.access.assertVenueRole(user.id, entry.venueId, VENUE_MANAGE_ROLES);
    return this.income.correctEntry(id, user.id, input);
  }
}
