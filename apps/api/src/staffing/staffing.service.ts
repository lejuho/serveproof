import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { businessDateInTimezone } from "@serveproof/shared";
import { PrismaService } from "../prisma/prisma.service";

const ACTIVE_ASSIGNMENTS = ["ACCEPTED", "CLOCKED_IN", "CLOCKED_OUT", "APPROVED"] as const;

@Injectable()
export class StaffingService {
  constructor(private readonly prisma: PrismaService) {}

  async createShift(
    venueId: string,
    actorUserId: string,
    input: {
      role: string;
      description?: string;
      startsAt: Date;
      endsAt: Date;
      hourlyRateUsdCents: number;
      expectedTipUsdCents?: number;
      headcount?: number;
    },
  ) {
    if (input.endsAt <= input.startsAt) {
      throw new BadRequestException("Shift end must be after its start");
    }
    if (input.endsAt.getTime() - input.startsAt.getTime() > 24 * 60 * 60 * 1000) {
      throw new BadRequestException("A staffing shift cannot exceed 24 hours");
    }
    const shift = await this.prisma.openShift.create({
      data: {
        venueId,
        createdByUserId: actorUserId,
        role: input.role,
        description: input.description?.trim() || null,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        hourlyRateUsdCents: input.hourlyRateUsdCents,
        expectedTipUsdCents: input.expectedTipUsdCents ?? 0,
        headcount: input.headcount ?? 1,
      },
    });
    await this.audit(venueId, actorUserId, "OPEN_SHIFT_CREATED", "OpenShift", shift.id, {
      role: shift.role,
      startsAt: shift.startsAt,
      headcount: shift.headcount,
    });
    return shift;
  }

  listVenueShifts(venueId: string) {
    return this.prisma.openShift.findMany({
      where: { venueId },
      include: {
        assignments: {
          include: {
            worker: { include: { user: { select: { displayName: true, email: true } } } },
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { startsAt: "desc" },
      take: 100,
    });
  }

  async publishShift(shiftId: string, actorUserId: string) {
    const shift = await this.getShift(shiftId);
    if (shift.status !== "DRAFT") {
      throw new ConflictException(`Shift is ${shift.status}; only DRAFT can be published`);
    }
    const updated = await this.prisma.openShift.update({
      where: { id: shiftId },
      data: { status: "OPEN", publishedAt: new Date() },
    });
    await this.audit(shift.venueId, actorUserId, "OPEN_SHIFT_PUBLISHED", "OpenShift", shiftId);
    return updated;
  }

  async cancelShift(shiftId: string, actorUserId: string, reason?: string) {
    const shift = await this.prisma.openShift.findUnique({
      where: { id: shiftId },
      include: { assignments: true },
    });
    if (!shift) throw new NotFoundException(`Open shift ${shiftId} not found`);
    if (["CANCELLED", "COMPLETED"].includes(shift.status)) {
      throw new ConflictException(`Shift is already ${shift.status}`);
    }
    if (
      shift.assignments.some((assignment) =>
        ["CLOCKED_IN", "CLOCKED_OUT"].includes(assignment.status),
      )
    ) {
      throw new ConflictException(
        "A shift with recorded work must be resolved before cancellation",
      );
    }
    const [updated] = await this.prisma.$transaction([
      this.prisma.openShift.update({
        where: { id: shiftId },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      }),
      this.prisma.shiftAssignment.updateMany({
        where: { openShiftId: shiftId, status: { in: ["INVITED", "ACCEPTED"] } },
        data: { status: "CANCELLED", cancellationReason: reason?.trim() || "Shift cancelled" },
      }),
    ]);
    await this.audit(shift.venueId, actorUserId, "OPEN_SHIFT_CANCELLED", "OpenShift", shiftId, {
      reason: reason?.trim() || null,
    });
    return updated;
  }

  async invite(shiftId: string, workerId: string, actorUserId: string) {
    const shift = await this.getShift(shiftId);
    if (shift.status !== "OPEN") {
      throw new ConflictException(
        `Shift is ${shift.status}; invitations require a published shift`,
      );
    }
    const connection = await this.prisma.externalWorkerAccount.findFirst({
      where: { venueId: shift.venueId, workerId, mappingStatus: "CONFIRMED" },
    });
    if (!connection) throw new BadRequestException("Worker is not connected to this venue");
    const existing = await this.prisma.shiftAssignment.findUnique({
      where: { openShiftId_workerId: { openShiftId: shiftId, workerId } },
    });
    if (existing && ACTIVE_ASSIGNMENTS.includes(existing.status as never)) {
      throw new ConflictException(`Worker assignment is already ${existing.status}`);
    }
    const assignment = await this.prisma.shiftAssignment.upsert({
      where: { openShiftId_workerId: { openShiftId: shiftId, workerId } },
      update: { status: "INVITED", invitedByUserId: actorUserId, cancellationReason: null },
      create: { openShiftId: shiftId, workerId, status: "INVITED", invitedByUserId: actorUserId },
    });
    await this.audit(
      shift.venueId,
      actorUserId,
      "SHIFT_INVITATION_SENT",
      "ShiftAssignment",
      assignment.id,
      {
        workerId,
      },
    );
    return assignment;
  }

  async listWorkerShifts(userId: string) {
    const worker = await this.getWorker(userId);
    const venueIds = (
      await this.prisma.externalWorkerAccount.findMany({
        where: { workerId: worker.id, mappingStatus: "CONFIRMED" },
        select: { venueId: true },
      })
    ).map((connection) => connection.venueId);
    if (venueIds.length === 0) return [];
    const historyStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    return this.prisma.openShift.findMany({
      where: {
        venueId: { in: venueIds },
        startsAt: { gte: historyStart },
        OR: [
          { status: "OPEN", endsAt: { gte: new Date() } },
          { assignments: { some: { workerId: worker.id } } },
        ],
      },
      include: {
        venue: { select: { id: true, name: true, timezone: true } },
        assignments: { where: { workerId: worker.id } },
      },
      orderBy: { startsAt: "asc" },
      take: 100,
    });
  }

  async respond(shiftId: string, userId: string, response: "ACCEPT" | "DECLINE") {
    const worker = await this.getWorker(userId);
    const shift = await this.getShift(shiftId);
    const connection = await this.prisma.externalWorkerAccount.findFirst({
      where: { venueId: shift.venueId, workerId: worker.id, mappingStatus: "CONFIRMED" },
    });
    if (!connection) throw new BadRequestException("Worker is not connected to this venue");
    if (response === "ACCEPT" && shift.status !== "OPEN") {
      throw new ConflictException(`Shift is ${shift.status}; it is not accepting workers`);
    }

    const assignment = await this.prisma.$transaction(
      async (tx) => {
        if (response === "ACCEPT") {
          const acceptedCount = await tx.shiftAssignment.count({
            where: { openShiftId: shiftId, status: { in: [...ACTIVE_ASSIGNMENTS] } },
          });
          const existing = await tx.shiftAssignment.findUnique({
            where: { openShiftId_workerId: { openShiftId: shiftId, workerId: worker.id } },
          });
          const alreadyAccepted = existing && ACTIVE_ASSIGNMENTS.includes(existing.status as never);
          if (!alreadyAccepted && acceptedCount >= shift.headcount) {
            throw new ConflictException("Shift has already reached its headcount");
          }
        }
        const saved = await tx.shiftAssignment.upsert({
          where: { openShiftId_workerId: { openShiftId: shiftId, workerId: worker.id } },
          update: {
            status: response === "ACCEPT" ? "ACCEPTED" : "DECLINED",
            respondedAt: new Date(),
            cancellationReason: null,
          },
          create: {
            openShiftId: shiftId,
            workerId: worker.id,
            status: response === "ACCEPT" ? "ACCEPTED" : "DECLINED",
            respondedAt: new Date(),
          },
        });
        const acceptedCount = await tx.shiftAssignment.count({
          where: { openShiftId: shiftId, status: { in: [...ACTIVE_ASSIGNMENTS] } },
        });
        await tx.openShift.update({
          where: { id: shiftId },
          data: { status: acceptedCount >= shift.headcount ? "FILLED" : "OPEN" },
        });
        return saved;
      },
      { isolationLevel: "Serializable" },
    );
    await this.audit(
      shift.venueId,
      userId,
      `SHIFT_${response}ED`,
      "ShiftAssignment",
      assignment.id,
    );
    return assignment;
  }

  async clockIn(assignmentId: string, userId: string) {
    const { assignment, worker } = await this.workerAssignment(assignmentId, userId);
    if (assignment.status !== "ACCEPTED") {
      throw new ConflictException(`Assignment is ${assignment.status}; cannot clock in`);
    }
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.shiftAssignment.update({
        where: { id: assignmentId },
        data: { status: "CLOCKED_IN", checkInAt: now },
      });
      await tx.openShift.update({
        where: { id: assignment.openShiftId },
        data: { status: "IN_PROGRESS" },
      });
      return saved;
    });
    await this.audit(
      assignment.openShift.venueId,
      worker.userId,
      "SHIFT_CLOCKED_IN",
      "ShiftAssignment",
      assignmentId,
      { at: now },
    );
    return updated;
  }

  async clockOut(assignmentId: string, userId: string) {
    const { assignment, worker } = await this.workerAssignment(assignmentId, userId);
    if (assignment.status !== "CLOCKED_IN") {
      throw new ConflictException(`Assignment is ${assignment.status}; cannot clock out`);
    }
    const now = new Date();
    const updated = await this.prisma.shiftAssignment.update({
      where: { id: assignmentId },
      data: { status: "CLOCKED_OUT", checkOutAt: now },
    });
    await this.audit(
      assignment.openShift.venueId,
      worker.userId,
      "SHIFT_CLOCKED_OUT",
      "ShiftAssignment",
      assignmentId,
      { at: now },
    );
    return updated;
  }

  async cancelAssignment(assignmentId: string, userId: string, reason?: string) {
    const { assignment, worker } = await this.workerAssignment(assignmentId, userId);
    if (!["INVITED", "ACCEPTED"].includes(assignment.status)) {
      throw new ConflictException(`Assignment is ${assignment.status}; cannot cancel`);
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.shiftAssignment.update({
        where: { id: assignmentId },
        data: {
          status: "CANCELLED",
          cancellationReason: reason?.trim() || "Cancelled by worker",
          respondedAt: new Date(),
        },
      });
      if (assignment.openShift.status === "FILLED" && assignment.openShift.startsAt > new Date()) {
        await tx.openShift.update({
          where: { id: assignment.openShiftId },
          data: { status: "OPEN" },
        });
      }
      return saved;
    });
    await this.audit(
      assignment.openShift.venueId,
      worker.userId,
      "SHIFT_ASSIGNMENT_CANCELLED",
      "ShiftAssignment",
      assignmentId,
      { reason: reason?.trim() || null },
    );
    return updated;
  }

  async approveAssignment(assignmentId: string, actorUserId: string) {
    const assignment = await this.prisma.shiftAssignment.findUnique({
      where: { id: assignmentId },
      include: { openShift: { include: { venue: true } }, worker: true },
    });
    if (!assignment) throw new NotFoundException(`Shift assignment ${assignmentId} not found`);
    if (assignment.status === "APPROVED" && assignment.shiftEvidenceId) return assignment;
    if (assignment.status !== "CLOCKED_OUT" || !assignment.checkInAt || !assignment.checkOutAt) {
      throw new ConflictException("Only a clocked-out assignment can be approved");
    }
    const workedMinutes = Math.max(
      1,
      Math.round((assignment.checkOutAt.getTime() - assignment.checkInAt.getTime()) / 60_000),
    );
    if (workedMinutes <= 0)
      throw new BadRequestException("Recorded shift duration must be positive");
    const businessDate = businessDateInTimezone(
      assignment.checkInAt,
      assignment.openShift.venue.timezone,
    );
    const sourceHash = createHash("sha256")
      .update(
        JSON.stringify({
          assignmentId,
          workerId: assignment.workerId,
          checkInAt: assignment.checkInAt.toISOString(),
          checkOutAt: assignment.checkOutAt.toISOString(),
          role: assignment.openShift.role,
        }),
      )
      .digest("hex");
    const updated = await this.prisma.$transaction(async (tx) => {
      const evidence = await tx.shiftEvidence.upsert({
        where: {
          venueId_provider_externalShiftId: {
            venueId: assignment.openShift.venueId,
            provider: "serveproof_staffing",
            externalShiftId: assignment.id,
          },
        },
        update: {
          ingestSource: "PLATFORM_ATTESTED",
          mappedWorkerId: assignment.workerId,
          role: assignment.openShift.role,
          clockIn: assignment.checkInAt!,
          clockOut: assignment.checkOutAt!,
          workedMinutes,
          shiftStatus: "APPROVED",
          businessDate,
          sourceHash,
          sourcePayoutRail: "PAYROLL",
          sourcePayrollStatus: "PENDING",
        },
        create: {
          venueId: assignment.openShift.venueId,
          provider: "serveproof_staffing",
          ingestSource: "PLATFORM_ATTESTED",
          externalShiftId: assignment.id,
          externalWorkerId: assignment.workerId,
          mappedWorkerId: assignment.workerId,
          role: assignment.openShift.role,
          clockIn: assignment.checkInAt!,
          clockOut: assignment.checkOutAt!,
          workedMinutes,
          shiftStatus: "APPROVED",
          businessDate,
          sourceHash,
          sourcePayoutRail: "PAYROLL",
          sourcePayrollStatus: "PENDING",
        },
      });
      const saved = await tx.shiftAssignment.update({
        where: { id: assignmentId },
        data: {
          status: "APPROVED",
          approvedAt: new Date(),
          approvedByUserId: actorUserId,
          shiftEvidenceId: evidence.id,
        },
      });
      const unresolved = await tx.shiftAssignment.count({
        where: {
          openShiftId: assignment.openShiftId,
          status: { in: ["ACCEPTED", "CLOCKED_IN", "CLOCKED_OUT"] },
        },
      });
      if (unresolved === 0) {
        await tx.openShift.update({
          where: { id: assignment.openShiftId },
          data: { status: "COMPLETED" },
        });
      }
      return saved;
    });
    await this.audit(
      assignment.openShift.venueId,
      actorUserId,
      "SHIFT_ASSIGNMENT_APPROVED",
      "ShiftAssignment",
      assignmentId,
      {
        workedMinutes,
        businessDate,
        shiftEvidenceId: updated.shiftEvidenceId,
      },
    );
    return updated;
  }

  async markNoShow(assignmentId: string, actorUserId: string) {
    const assignment = await this.getAssignment(assignmentId);
    if (!["INVITED", "ACCEPTED"].includes(assignment.status)) {
      throw new ConflictException(`Assignment is ${assignment.status}; cannot mark no-show`);
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.shiftAssignment.update({
        where: { id: assignmentId },
        data: { status: "NO_SHOW" },
      });
      if (assignment.openShift.status === "FILLED" && assignment.openShift.startsAt > new Date()) {
        await tx.openShift.update({
          where: { id: assignment.openShiftId },
          data: { status: "OPEN" },
        });
      }
      return saved;
    });
    await this.audit(
      assignment.openShift.venueId,
      actorUserId,
      "SHIFT_MARKED_NO_SHOW",
      "ShiftAssignment",
      assignmentId,
    );
    return updated;
  }

  async getShift(id: string) {
    const shift = await this.prisma.openShift.findUnique({ where: { id } });
    if (!shift) throw new NotFoundException(`Open shift ${id} not found`);
    return shift;
  }

  async getAssignment(id: string) {
    const assignment = await this.prisma.shiftAssignment.findUnique({
      where: { id },
      include: { openShift: true },
    });
    if (!assignment) throw new NotFoundException(`Shift assignment ${id} not found`);
    return assignment;
  }

  private async getWorker(userId: string) {
    const worker = await this.prisma.worker.findUnique({ where: { userId } });
    if (!worker) throw new NotFoundException("No worker profile for this user");
    return worker;
  }

  private async workerAssignment(assignmentId: string, userId: string) {
    const worker = await this.getWorker(userId);
    const assignment = await this.prisma.shiftAssignment.findUnique({
      where: { id: assignmentId },
      include: { openShift: true },
    });
    if (!assignment || assignment.workerId !== worker.id) {
      throw new NotFoundException("Shift assignment not found");
    }
    return { assignment, worker };
  }

  private audit(
    venueId: string,
    actorUserId: string,
    action: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {},
  ) {
    return this.prisma.auditLog.create({
      data: {
        venueId,
        actorUserId,
        action,
        entityType,
        entityId,
        detail: JSON.parse(JSON.stringify(detail)),
      },
    });
  }
}
