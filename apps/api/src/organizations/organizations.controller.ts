import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { AccessService, VENUE_MANAGE_ROLES, VENUE_READ_ROLES } from "../auth/access.service";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { parseBody } from "../common/zod";
import { OrganizationsService } from "./organizations.service";

const createOrgSchema = z.object({
  legalName: z.string().min(1),
  displayName: z.string().min(1),
  country: z.string().length(2),
  timezone: z.string().min(1),
});

const addMemberSchema = z.object({
  email: z.email(),
  role: z.enum(["OWNER", "MANAGER", "PAYROLL_ADMIN", "VIEWER"]),
});

const createVenueSchema = z.object({
  organizationId: z.uuid(),
  name: z.string().min(1),
  timezone: z.string().min(1),
  externalIds: z.record(z.string(), z.string()).optional(),
});

// Base58, 32–44 chars — shape check only; on-chain validity is Phase 2's concern.
const solanaAddress = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const venueWalletSchema = z.object({ payoutSignerWallet: solanaAddress });

@Controller()
export class OrganizationsController {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly access: AccessService,
  ) {}

  @Post("organizations")
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.organizations.createOrganization(user.id, parseBody(createOrgSchema, body));
  }

  @Get("organizations/mine")
  listMine(@CurrentUser() user: AuthenticatedUser) {
    return this.organizations.listMine(user.id);
  }

  @Post("organizations/:id/members")
  async addMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") organizationId: string,
    @Body() body: unknown,
  ) {
    await this.access.assertOrgRole(user.id, organizationId, ["OWNER"]);
    return this.organizations.addMember(organizationId, parseBody(addMemberSchema, body));
  }

  @Post("venues")
  async createVenue(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = parseBody(createVenueSchema, body);
    await this.access.assertOrgRole(user.id, input.organizationId, VENUE_MANAGE_ROLES);
    return this.organizations.createVenue(input);
  }

  @Get("venues/:id")
  async getVenue(@CurrentUser() user: AuthenticatedUser, @Param("id") venueId: string) {
    await this.access.assertVenueRole(user.id, venueId, VENUE_READ_ROLES);
    return this.organizations.getVenue(venueId);
  }

  // Operational inbox: what still needs a manager's attention today
  @Get("venues/:id/action-items")
  async actionItems(@CurrentUser() user: AuthenticatedUser, @Param("id") venueId: string) {
    await this.access.assertVenueRole(user.id, venueId, VENUE_READ_ROLES);
    return this.organizations.actionItems(venueId);
  }

  @Get("venues/:id/worker-connections")
  async workerConnections(@CurrentUser() user: AuthenticatedUser, @Param("id") venueId: string) {
    await this.access.assertVenueRole(user.id, venueId, VENUE_READ_ROLES);
    return this.organizations.workerConnections(venueId);
  }

  @Post("venues/:id/wallet")
  async setWallet(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") venueId: string,
    @Body() body: unknown,
  ) {
    const { payoutSignerWallet } = parseBody(venueWalletSchema, body);
    await this.access.assertVenueRole(user.id, venueId, VENUE_MANAGE_ROLES);
    return this.organizations.setVenueWallet(venueId, payoutSignerWallet);
  }
}
