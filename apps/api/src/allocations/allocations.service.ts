import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  computeAllocationBatch,
  type AllocationPolicyInput,
  type AllocationShiftInput,
  type AllocationTipInput,
  type TipType,
} from "@serveproof/shared";
import { PrismaService } from "../prisma/prisma.service";

const SETTLEMENT_RAILS = [
  "CASH_RETAINED",
  "CASH_DRAWER",
  "PAYROLL",
  "PAYOUT_PROVIDER",
  "BANK_REFERENCE",
  "USDC",
] as const;
type SettlementRail = (typeof SETTLEMENT_RAILS)[number];

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

@Injectable()
export class AllocationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Spec §10 + §22 — POST /allocation-batches/calculate
   * Loads evidence for the business date, runs the pure engine, and stores the
   * batch as CALCULATED or REVIEW_REQUIRED (blocking issues, spec §11.1).
   */
  async calculate(
    input: { venueId: string; businessDate: string; policyVersion?: number },
    calculatedBy?: string,
  ) {
    const venue = await this.prisma.venue.findUnique({ where: { id: input.venueId } });
    if (!venue) throw new NotFoundException(`Venue ${input.venueId} not found`);

    const policy = input.policyVersion
      ? await this.prisma.allocationPolicy.findUnique({
          where: { venueId_version: { venueId: input.venueId, version: input.policyVersion } },
        })
      : await this.prisma.allocationPolicy.findFirst({
          where: { venueId: input.venueId, status: "ACTIVE" },
          orderBy: { version: "desc" },
        });
    if (!policy) throw new NotFoundException("No allocation policy found for venue");

    const [tips, shifts] = await Promise.all([
      this.prisma.tipEvidence.findMany({
        where: { venueId: input.venueId, businessDate: input.businessDate },
      }),
      this.prisma.shiftEvidence.findMany({
        where: { venueId: input.venueId, businessDate: input.businessDate },
      }),
    ]);
    if (tips.length === 0 && shifts.length === 0) {
      throw new BadRequestException(`No evidence for venue on business date ${input.businessDate}`);
    }

    // Spec §10.4 — recalculation must not mutate an approved batch.
    const existing = await this.prisma.allocationBatch.findUnique({
      where: {
        venueId_businessDate_policyVersion: {
          venueId: input.venueId,
          businessDate: input.businessDate,
          policyVersion: policy.version,
        },
      },
    });
    if (existing && !["DRAFT", "CALCULATED", "REVIEW_REQUIRED"].includes(existing.status)) {
      throw new ConflictException(
        `Batch ${existing.id} is ${existing.status}; corrections must go through the correction ledger`,
      );
    }

    const engineTips: AllocationTipInput[] = tips.map((t) => ({
      tipType: t.tipType as TipType,
      grossAmountUsdCents: t.grossAmountUsdCents,
      paymentStatus: t.paymentStatus,
      refundStatus: t.refundStatus,
    }));
    const engineShifts: AllocationShiftInput[] = shifts.map((s) => ({
      workerId: s.mappedWorkerId,
      externalWorkerId: s.externalWorkerId,
      provider: s.provider,
      role: s.role,
      workedMinutes: s.workedMinutes,
      shiftStatus: s.shiftStatus,
    }));
    const enginePolicy: AllocationPolicyInput = {
      roleWeights: policy.roleWeights as Record<string, number>,
      excludedRoles: policy.excludedRoles as string[],
      poolInclusion: policy.poolInclusion as Partial<Record<TipType, boolean>>,
    };

    const result = computeAllocationBatch(engineTips, engineShifts, enginePolicy);
    const plannedRailByWorker = new Map<string, SettlementRail>();
    const conflictingRailWorkers = new Set<string>();
    for (const shift of shifts) {
      if (!shift.mappedWorkerId || !shift.sourcePayoutRail) continue;
      const previous = plannedRailByWorker.get(shift.mappedWorkerId);
      if (previous && previous !== shift.sourcePayoutRail) {
        conflictingRailWorkers.add(shift.mappedWorkerId);
        plannedRailByWorker.delete(shift.mappedWorkerId);
      } else if (!conflictingRailWorkers.has(shift.mappedWorkerId)) {
        plannedRailByWorker.set(shift.mappedWorkerId, shift.sourcePayoutRail);
      }
    }
    const hasBlockingIssue = result.issues.some((i) => i.blocking);
    const status = hasBlockingIssue ? "REVIEW_REQUIRED" : "CALCULATED";

    // Deterministic hashes over the evidence set and the computed result (§9.10)
    const evidenceHash = sha256(
      JSON.stringify({
        tips: tips.map((t) => t.sourceHash).sort(),
        shifts: shifts.map((s) => s.sourceHash).sort(),
      }),
    );
    const allocationHash = sha256(
      JSON.stringify({
        policyVersion: policy.version,
        poolUsdCents: result.poolUsdCents,
        allocations: result.allocations,
      }),
    );

    const batch = await this.prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.workerAllocation.deleteMany({ where: { batchId: existing.id } });
      }
      const saved = await tx.allocationBatch.upsert({
        where: {
          venueId_businessDate_policyVersion: {
            venueId: input.venueId,
            businessDate: input.businessDate,
            policyVersion: policy.version,
          },
        },
        update: {
          status,
          tipPoolAmountUsdCents: result.poolUsdCents,
          evidenceHash,
          allocationHash,
          reviewIssues: JSON.parse(JSON.stringify(result.issues)),
          calculatedAt: new Date(),
          calculatedBy: calculatedBy ?? null,
          approvedAt: null,
          approvedBy: null,
        },
        create: {
          venueId: input.venueId,
          businessDate: input.businessDate,
          policyId: policy.id,
          policyVersion: policy.version,
          status,
          tipPoolAmountUsdCents: result.poolUsdCents,
          evidenceHash,
          allocationHash,
          reviewIssues: JSON.parse(JSON.stringify(result.issues)),
          calculatedAt: new Date(),
          calculatedBy: calculatedBy ?? null,
        },
      });
      if (result.allocations.length > 0) {
        await tx.workerAllocation.createMany({
          data: result.allocations.map((a) => ({
            batchId: saved.id,
            workerId: a.workerId,
            provider: a.provider,
            externalWorkerId: a.externalWorkerId,
            pooledTipUsdCents: a.pooledTipUsdCents,
            netAllocatedUsdCents: a.netAllocatedUsdCents,
            plannedPayoutRail: a.workerId ? (plannedRailByWorker.get(a.workerId) ?? null) : null,
          })),
        });
      }
      return saved;
    });

    return this.getBatch(batch.id);
  }

  async getBatch(id: string) {
    const batch = await this.prisma.allocationBatch.findUnique({
      where: { id },
      include: {
        allocations: {
          include: { worker: { include: { user: { select: { displayName: true } } } } },
        },
      },
    });
    if (!batch) throw new NotFoundException(`Batch ${id} not found`);
    return batch;
  }

  async getAllocation(id: string) {
    const allocation = await this.prisma.workerAllocation.findUnique({
      where: { id },
      include: { batch: { select: { venueId: true } } },
    });
    if (!allocation) throw new NotFoundException(`Allocation ${id} not found`);
    return allocation;
  }

  /**
   * Spec §11 — approval. CALCULATED → APPROVED → PAYABLE in one step
   * (§11.2: batch status = APPROVED → PAYABLE).
   */
  async approve(id: string, approvedBy: string) {
    const batch = await this.prisma.allocationBatch.findUnique({ where: { id } });
    if (!batch) throw new NotFoundException(`Batch ${id} not found`);
    if (batch.status === "REVIEW_REQUIRED") {
      throw new BadRequestException("Batch has blocking review issues; resolve them first");
    }
    if (batch.status !== "CALCULATED") {
      throw new ConflictException(`Batch is ${batch.status}; only CALCULATED can be approved`);
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.allocationBatch.update({
        where: { id },
        data: { status: "PAYABLE", approvedBy, approvedAt: new Date() },
      }),
      this.prisma.auditLog.create({
        data: {
          venueId: batch.venueId,
          actorUserId: approvedBy,
          action: "ALLOCATION_BATCH_APPROVED",
          entityType: "AllocationBatch",
          entityId: id,
          detail: {
            allocationHash: batch.allocationHash,
            evidenceHash: batch.evidenceHash,
            tipPoolAmountUsdCents: batch.tipPoolAmountUsdCents,
          },
        },
      }),
    ]);
    return updated;
  }

  async reject(id: string, rejectedBy: string, reason: string) {
    const batch = await this.prisma.allocationBatch.findUnique({ where: { id } });
    if (!batch) throw new NotFoundException(`Batch ${id} not found`);
    if (!["CALCULATED", "REVIEW_REQUIRED"].includes(batch.status)) {
      throw new ConflictException(`Batch is ${batch.status}; cannot reject`);
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.allocationBatch.update({ where: { id }, data: { status: "DRAFT" } }),
      this.prisma.auditLog.create({
        data: {
          venueId: batch.venueId,
          actorUserId: rejectedBy,
          action: "ALLOCATION_BATCH_REJECTED",
          entityType: "AllocationBatch",
          entityId: id,
          detail: { reason },
        },
      }),
    ]);
    return updated;
  }

  async setPlannedRail(allocationId: string, rail: SettlementRail, actorUserId: string) {
    const allocation = await this.prisma.workerAllocation.findUnique({
      where: { id: allocationId },
      include: { batch: { select: { venueId: true, status: true } } },
    });
    if (!allocation) throw new NotFoundException(`Allocation ${allocationId} not found`);
    if (allocation.payoutStatus === "PAID") {
      throw new ConflictException("A paid allocation's settlement route cannot be changed");
    }
    const [updated] = await this.prisma.$transaction([
      this.prisma.workerAllocation.update({
        where: { id: allocationId },
        data: { plannedPayoutRail: rail },
      }),
      this.prisma.auditLog.create({
        data: {
          venueId: allocation.batch.venueId,
          actorUserId,
          action: "ALLOCATION_PLANNED_RAIL_CHANGED",
          entityType: "WorkerAllocation",
          entityId: allocationId,
          detail: { previous: allocation.plannedPayoutRail, next: rail },
        },
      }),
    ]);
    return updated;
  }
}
