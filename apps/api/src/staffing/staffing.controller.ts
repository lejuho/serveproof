import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { AccessService, VENUE_MANAGE_ROLES, VENUE_READ_ROLES } from "../auth/access.service";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { parseBody } from "../common/zod";
import { StaffingService } from "./staffing.service";

const createShiftSchema = z
  .object({
    role: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).optional(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    hourlyRateUsdCents: z.number().int().nonnegative().max(1_000_000),
    expectedTipUsdCents: z.number().int().nonnegative().max(1_000_000).optional(),
    headcount: z.number().int().min(1).max(100).optional(),
  })
  .refine((input) => input.endsAt > input.startsAt, {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  });
const inviteSchema = z.object({ workerId: z.uuid() });
const respondSchema = z.object({ response: z.enum(["ACCEPT", "DECLINE"]) });
const cancelSchema = z.object({ reason: z.string().trim().max(300).optional() });

@Controller("staffing")
export class StaffingController {
  constructor(
    private readonly staffing: StaffingService,
    private readonly access: AccessService,
  ) {}

  @Post("venues/:venueId/shifts")
  async createShift(
    @CurrentUser() user: AuthenticatedUser,
    @Param("venueId") venueId: string,
    @Body() body: unknown,
  ) {
    await this.access.assertVenueRole(user.id, venueId, VENUE_MANAGE_ROLES);
    return this.staffing.createShift(venueId, user.id, parseBody(createShiftSchema, body));
  }

  @Get("venues/:venueId/shifts")
  async venueShifts(@CurrentUser() user: AuthenticatedUser, @Param("venueId") venueId: string) {
    await this.access.assertVenueRole(user.id, venueId, VENUE_READ_ROLES);
    return this.staffing.listVenueShifts(venueId);
  }

  @Post("shifts/:shiftId/publish")
  async publish(@CurrentUser() user: AuthenticatedUser, @Param("shiftId") shiftId: string) {
    const shift = await this.staffing.getShift(shiftId);
    await this.access.assertVenueRole(user.id, shift.venueId, VENUE_MANAGE_ROLES);
    return this.staffing.publishShift(shiftId, user.id);
  }

  @Post("shifts/:shiftId/cancel")
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param("shiftId") shiftId: string,
    @Body() body: unknown,
  ) {
    const shift = await this.staffing.getShift(shiftId);
    await this.access.assertVenueRole(user.id, shift.venueId, VENUE_MANAGE_ROLES);
    return this.staffing.cancelShift(shiftId, user.id, parseBody(cancelSchema, body).reason);
  }

  @Post("shifts/:shiftId/invitations")
  async invite(
    @CurrentUser() user: AuthenticatedUser,
    @Param("shiftId") shiftId: string,
    @Body() body: unknown,
  ) {
    const shift = await this.staffing.getShift(shiftId);
    await this.access.assertVenueRole(user.id, shift.venueId, VENUE_MANAGE_ROLES);
    return this.staffing.invite(shiftId, parseBody(inviteSchema, body).workerId, user.id);
  }

  @Get("workers/me/shifts")
  workerShifts(@CurrentUser() user: AuthenticatedUser) {
    return this.staffing.listWorkerShifts(user.id);
  }

  @Post("shifts/:shiftId/respond")
  respond(
    @CurrentUser() user: AuthenticatedUser,
    @Param("shiftId") shiftId: string,
    @Body() body: unknown,
  ) {
    return this.staffing.respond(shiftId, user.id, parseBody(respondSchema, body).response);
  }

  @Post("assignments/:assignmentId/clock-in")
  clockIn(@CurrentUser() user: AuthenticatedUser, @Param("assignmentId") assignmentId: string) {
    return this.staffing.clockIn(assignmentId, user.id);
  }

  @Post("assignments/:assignmentId/clock-out")
  clockOut(@CurrentUser() user: AuthenticatedUser, @Param("assignmentId") assignmentId: string) {
    return this.staffing.clockOut(assignmentId, user.id);
  }

  @Post("assignments/:assignmentId/cancel")
  cancelAssignment(
    @CurrentUser() user: AuthenticatedUser,
    @Param("assignmentId") assignmentId: string,
    @Body() body: unknown,
  ) {
    return this.staffing.cancelAssignment(
      assignmentId,
      user.id,
      parseBody(cancelSchema, body).reason,
    );
  }

  @Post("assignments/:assignmentId/approve")
  async approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param("assignmentId") assignmentId: string,
  ) {
    const assignment = await this.staffing.getAssignment(assignmentId);
    await this.access.assertVenueRole(user.id, assignment.openShift.venueId, VENUE_MANAGE_ROLES);
    return this.staffing.approveAssignment(assignmentId, user.id);
  }

  @Post("assignments/:assignmentId/no-show")
  async noShow(
    @CurrentUser() user: AuthenticatedUser,
    @Param("assignmentId") assignmentId: string,
  ) {
    const assignment = await this.staffing.getAssignment(assignmentId);
    await this.access.assertVenueRole(user.id, assignment.openShift.venueId, VENUE_MANAGE_ROLES);
    return this.staffing.markNoShow(assignmentId, user.id);
  }
}
