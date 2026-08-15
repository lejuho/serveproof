import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { AccessService, VENUE_MANAGE_ROLES, VENUE_READ_ROLES } from "../auth/access.service";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { parseBody } from "../common/zod";
import { AllocationsService } from "./allocations.service";

const calculateSchema = z.object({
  venueId: z.uuid(),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  policyVersion: z.number().int().positive().optional(),
});

const rejectSchema = z.object({ reason: z.string().min(1) });

@Controller("allocation-batches")
export class AllocationsController {
  constructor(
    private readonly allocations: AllocationsService,
    private readonly access: AccessService,
  ) {}

  @Post("calculate")
  async calculate(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = parseBody(calculateSchema, body);
    await this.access.assertVenueRole(user.id, input.venueId, VENUE_MANAGE_ROLES);
    return this.allocations.calculate(input, user.id);
  }

  @Get(":id")
  async get(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const batch = await this.allocations.getBatch(id);
    await this.access.assertVenueRole(user.id, batch.venueId, VENUE_READ_ROLES);
    return batch;
  }

  // Spec §11.3 — approval restricted to OWNER/MANAGER
  @Post(":id/approve")
  async approve(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const batch = await this.allocations.getBatch(id);
    await this.access.assertVenueRole(user.id, batch.venueId, VENUE_MANAGE_ROLES);
    return this.allocations.approve(id, user.id);
  }

  @Post(":id/reject")
  async reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { reason } = parseBody(rejectSchema, body);
    const batch = await this.allocations.getBatch(id);
    await this.access.assertVenueRole(user.id, batch.venueId, VENUE_MANAGE_ROLES);
    return this.allocations.reject(id, user.id, reason);
  }
}
