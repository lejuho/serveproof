import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export interface PolicyInput {
  allocationType: "HOURS_WEIGHTED" | "ROLE_WEIGHTED_HOURS" | "EQUAL_SPLIT";
  roleWeights: Record<string, number>;
  poolInclusion: Record<string, boolean>;
  excludedRoles: string[];
  tipOutRules?: unknown[];
  effectiveFrom: string;
}

@Injectable()
export class PoliciesService {
  constructor(private readonly prisma: PrismaService) {}

  list(venueId: string) {
    return this.prisma.allocationPolicy.findMany({
      where: { venueId },
      orderBy: { version: "desc" },
    });
  }

  /**
   * Spec §10.4 — versions are immutable. Creating a policy (or a new version)
   * always appends version = max + 1, activates it, and archives the previous
   * ACTIVE version. Past batches keep the policyVersion they were computed with.
   */
  async createVersion(venueId: string, createdBy: string, input: PolicyInput) {
    return this.prisma.$transaction(async (tx) => {
      const latest = await tx.allocationPolicy.findFirst({
        where: { venueId },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      await tx.allocationPolicy.updateMany({
        where: { venueId, status: "ACTIVE" },
        data: { status: "ARCHIVED", effectiveTo: new Date() },
      });
      return tx.allocationPolicy.create({
        data: {
          venueId,
          version: (latest?.version ?? 0) + 1,
          status: "ACTIVE",
          allocationType: input.allocationType,
          roleWeights: input.roleWeights,
          poolInclusion: input.poolInclusion,
          excludedRoles: input.excludedRoles,
          tipOutRules: JSON.parse(JSON.stringify(input.tipOutRules ?? [])),
          effectiveFrom: new Date(input.effectiveFrom),
          createdBy,
        },
      });
    });
  }

  /** Spec §22 — POST /allocation-policies/:id/new-version (clone + overrides) */
  async newVersionFrom(policyId: string, createdBy: string, overrides: Partial<PolicyInput>) {
    const base = await this.prisma.allocationPolicy.findUnique({ where: { id: policyId } });
    if (!base) throw new NotFoundException(`Policy ${policyId} not found`);

    return this.createVersion(base.venueId, createdBy, {
      allocationType: overrides.allocationType ?? base.allocationType,
      roleWeights: overrides.roleWeights ?? (base.roleWeights as Record<string, number>),
      poolInclusion: overrides.poolInclusion ?? (base.poolInclusion as Record<string, boolean>),
      excludedRoles: overrides.excludedRoles ?? (base.excludedRoles as string[]),
      tipOutRules: overrides.tipOutRules ?? (base.tipOutRules as unknown[]),
      effectiveFrom: overrides.effectiveFrom ?? new Date().toISOString(),
    });
  }

  async getVenueIdOf(policyId: string): Promise<string> {
    const policy = await this.prisma.allocationPolicy.findUnique({
      where: { id: policyId },
      select: { venueId: true },
    });
    if (!policy) throw new NotFoundException(`Policy ${policyId} not found`);
    return policy.venueId;
  }
}
