import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { AccessService, VENUE_MANAGE_ROLES, VENUE_READ_ROLES } from "../auth/access.service";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { Public } from "../auth/public.decorator";
import { parseBody } from "../common/zod";
import { ProvidersService } from "./providers.service";

const connectSchema = z.object({ venueId: z.uuid(), locationId: z.string().min(1).optional() });
const syncSchema = z
  .object({
    venueId: z.uuid(),
    provider: z.literal("square").default("square"),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
  })
  .refine((value) => value.startDate <= value.endDate, {
    message: "startDate must be on or before endDate",
  });
const healthQuerySchema = z.object({ venueId: z.uuid() });

@Controller()
export class ProvidersController {
  constructor(
    private readonly providers: ProvidersService,
    private readonly access: AccessService,
  ) {}

  @Post("providers/square/connect")
  async connect(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = parseBody(connectSchema, body);
    await this.access.assertVenueRole(user.id, input.venueId, VENUE_MANAGE_ROLES);
    return this.providers.createSquareAuthorization(input.venueId, input.locationId);
  }

  @Public()
  @Get("providers/square/callback")
  callback(
    @Query("state") state?: string,
    @Query("code") code?: string,
    @Query("error") error?: string,
    @Query("error_description") errorDescription?: string,
  ) {
    return this.providers.completeSquareAuthorization({ state, code, error, errorDescription });
  }

  @Get("providers/:provider/health")
  async health(
    @CurrentUser() user: AuthenticatedUser,
    @Param("provider") provider: string,
    @Query("venueId") rawVenueId: string,
  ) {
    const { venueId } = parseBody(healthQuerySchema, { venueId: rawVenueId });
    await this.access.assertVenueRole(user.id, venueId, VENUE_READ_ROLES);
    return this.providers.health(provider, venueId);
  }

  @Post("evidence/sync")
  async sync(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = parseBody(syncSchema, body);
    await this.access.assertVenueRole(user.id, input.venueId, VENUE_MANAGE_ROLES);
    return this.providers.enqueueSync(input);
  }
}
