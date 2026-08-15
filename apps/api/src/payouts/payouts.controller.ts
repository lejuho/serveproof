import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { AccessService, VENUE_MANAGE_ROLES, VENUE_READ_ROLES } from "../auth/access.service";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { parseBody } from "../common/zod";
import { PrismaService } from "../prisma/prisma.service";
import { PayoutsService } from "./payouts.service";

const createSchema = z.object({ allocationId: z.uuid() });
const submitSchema = z.object({ signedTransactionBase64: z.string().min(1) });
const legacySchema = z.object({
  allocationId: z.uuid(),
  rail: z.enum(["CASH_RETAINED", "CASH_DRAWER", "PAYROLL", "PAYOUT_PROVIDER", "BANK_REFERENCE"]),
  externalReference: z.string().min(1),
});

@Controller("payouts")
export class PayoutsController {
  constructor(
    private readonly payouts: PayoutsService,
    private readonly access: AccessService,
    private readonly prisma: PrismaService,
  ) {}

  private async venueIdOfAllocation(allocationId: string): Promise<string | null> {
    const allocation = await this.prisma.workerAllocation.findUnique({
      where: { id: allocationId },
      select: { batch: { select: { venueId: true } } },
    });
    return allocation?.batch.venueId ?? null;
  }

  @Post()
  async create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const { allocationId } = parseBody(createSchema, body);
    const venueId = await this.venueIdOfAllocation(allocationId);
    if (venueId) await this.access.assertVenueRole(user.id, venueId, VENUE_MANAGE_ROLES);
    return this.payouts.createUsdcPayout(allocationId, user.id);
  }

  @Get(":id/transaction")
  async buildTransaction(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const payout = await this.payouts.getPayout(id);
    await this.access.assertVenueRole(user.id, payout.venueId, VENUE_MANAGE_ROLES);
    return this.payouts.buildTransaction(id, user.id);
  }

  @Post(":id/submit")
  async submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { signedTransactionBase64 } = parseBody(submitSchema, body);
    const payout = await this.payouts.getPayout(id);
    await this.access.assertVenueRole(user.id, payout.venueId, VENUE_MANAGE_ROLES);
    return this.payouts.submitSigned(id, signedTransactionBase64, user.id);
  }

  @Get(":id")
  async get(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const payout = await this.payouts.getPayout(id);
    await this.access.assertVenueRole(user.id, payout.venueId, VENUE_READ_ROLES);
    return payout;
  }

  @Post("legacy-evidence")
  async legacyEvidence(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = parseBody(legacySchema, body);
    const venueId = await this.venueIdOfAllocation(input.allocationId);
    if (venueId) await this.access.assertVenueRole(user.id, venueId, VENUE_MANAGE_ROLES);
    return this.payouts.registerLegacyEvidence(input.allocationId, input, user.id);
  }
}
