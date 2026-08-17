import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { AccessService, VENUE_MANAGE_ROLES, VENUE_READ_ROLES } from "../auth/access.service";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { parseBody } from "../common/zod";
import { MappingsService } from "./mappings.service";

const createMappingSchema = z
  .object({
    workerId: z.uuid().optional(),
    workerEmail: z.email().optional(),
    venueId: z.uuid(),
    provider: z.string().min(1),
    externalWorkerId: z.string().min(1),
  })
  .refine((v) => v.workerId || v.workerEmail, {
    message: "workerId or workerEmail is required",
  });
const respondMappingSchema = z.object({ decision: z.enum(["ACCEPT", "REJECT"]) });

@Controller()
export class MappingsController {
  constructor(
    private readonly mappings: MappingsService,
    private readonly access: AccessService,
  ) {}

  @Get("venues/:venueId/unmapped-workers")
  async listUnmapped(@CurrentUser() user: AuthenticatedUser, @Param("venueId") venueId: string) {
    await this.access.assertVenueRole(user.id, venueId, VENUE_READ_ROLES);
    return this.mappings.listUnmapped(venueId);
  }

  @Post("worker-mappings")
  async create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = parseBody(createMappingSchema, body);
    await this.access.assertVenueRole(user.id, input.venueId, VENUE_MANAGE_ROLES);
    return this.mappings.createMapping(input);
  }

  @Patch("worker-mappings/:id/respond")
  respond(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() body: unknown) {
    const { decision } = parseBody(respondMappingSchema, body);
    return this.mappings.respondToMapping(id, user.id, decision);
  }
}
