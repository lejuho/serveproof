import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { AccessService, VENUE_MANAGE_ROLES, VENUE_READ_ROLES } from "../auth/access.service";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { parseBody } from "../common/zod";
import { PoliciesService } from "./policies.service";

const policySchema = z.object({
  allocationType: z.enum(["HOURS_WEIGHTED", "ROLE_WEIGHTED_HOURS", "EQUAL_SPLIT"]),
  roleWeights: z.record(z.string(), z.number().nonnegative()),
  poolInclusion: z.record(z.string(), z.boolean()),
  excludedRoles: z.array(z.string()),
  tipOutRules: z.array(z.unknown()).optional(),
  effectiveFrom: z.iso.datetime(),
});

const policyOverridesSchema = policySchema.partial();

@Controller()
export class PoliciesController {
  constructor(
    private readonly policies: PoliciesService,
    private readonly access: AccessService,
  ) {}

  @Get("venues/:venueId/allocation-policies")
  async list(@CurrentUser() user: AuthenticatedUser, @Param("venueId") venueId: string) {
    await this.access.assertVenueRole(user.id, venueId, VENUE_READ_ROLES);
    return this.policies.list(venueId);
  }

  @Post("venues/:venueId/allocation-policies")
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param("venueId") venueId: string,
    @Body() body: unknown,
  ) {
    const input = parseBody(policySchema, body);
    await this.access.assertVenueRole(user.id, venueId, VENUE_MANAGE_ROLES);
    return this.policies.createVersion(venueId, user.id, input);
  }

  @Post("allocation-policies/:id/new-version")
  async newVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const overrides = parseBody(policyOverridesSchema, body ?? {});
    const venueId = await this.policies.getVenueIdOf(id);
    await this.access.assertVenueRole(user.id, venueId, VENUE_MANAGE_ROLES);
    return this.policies.newVersionFrom(id, user.id, overrides);
  }
}
