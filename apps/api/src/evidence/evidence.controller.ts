import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { AccessService, VENUE_MANAGE_ROLES, VENUE_READ_ROLES } from "../auth/access.service";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { parseBody } from "../common/zod";
import { EvidenceService } from "./evidence.service";

const csvImportSchema = z.object({
  venueId: z.uuid(),
  csvText: z.string().min(1),
});

@Controller()
export class EvidenceController {
  constructor(
    private readonly evidence: EvidenceService,
    private readonly access: AccessService,
  ) {}

  // Spec §22 — POST /providers/csv/import
  @Post("providers/csv/import")
  async importCsv(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const { venueId, csvText } = parseBody(csvImportSchema, body);
    await this.access.assertVenueRole(user.id, venueId, VENUE_MANAGE_ROLES);
    return this.evidence.importCsv(venueId, csvText);
  }

  // Spec §22 — GET /venues/:venueId/tip-evidence
  @Get("venues/:venueId/tip-evidence")
  async listTips(
    @CurrentUser() user: AuthenticatedUser,
    @Param("venueId") venueId: string,
    @Query("businessDate") businessDate?: string,
  ) {
    await this.access.assertVenueRole(user.id, venueId, VENUE_READ_ROLES);
    return this.evidence.listTipEvidence(venueId, businessDate);
  }

  // Spec §22 — GET /venues/:venueId/shift-evidence
  @Get("venues/:venueId/shift-evidence")
  async listShifts(
    @CurrentUser() user: AuthenticatedUser,
    @Param("venueId") venueId: string,
    @Query("businessDate") businessDate?: string,
  ) {
    await this.access.assertVenueRole(user.id, venueId, VENUE_READ_ROLES);
    return this.evidence.listShiftEvidence(venueId, businessDate);
  }
}
