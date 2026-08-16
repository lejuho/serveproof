import { Injectable, NotFoundException } from "@nestjs/common";
import type { OrgRole } from "@serveproof/db";
import { maskEmail, maskWallet } from "../common/privacy";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Spec §22 — POST /organizations. Creator becomes OWNER. */
  createOrganization(
    creatorUserId: string,
    input: { legalName: string; displayName: string; country: string; timezone: string },
  ) {
    return this.prisma.organization.create({
      data: {
        ...input,
        members: { create: { userId: creatorUserId, role: "OWNER" } },
      },
      include: { members: true },
    });
  }

  /** Spec §22 — POST /organizations/:id/members. Invite by email (user must exist). */
  async addMember(organizationId: string, input: { email: string; role: OrgRole }) {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email.toLowerCase() },
    });
    if (!user) {
      throw new NotFoundException(`No user with email ${input.email}; they must log in once first`);
    }
    // Staff access is organization-scoped. Do not replace the person's worker
    // identity with a global venue role when a membership is added.
    return this.prisma.organizationMember.upsert({
      where: { organizationId_userId: { organizationId, userId: user.id } },
      update: { role: input.role },
      create: { organizationId, userId: user.id, role: input.role },
    });
  }

  listMine(userId: string) {
    return this.prisma.organization.findMany({
      where: { members: { some: { userId } } },
      include: { venues: true, members: { include: { user: { select: { email: true } } } } },
    });
  }

  /** Spec §22 — POST /venues */
  createVenue(input: {
    organizationId: string;
    name: string;
    timezone: string;
    externalIds?: Record<string, string>;
  }) {
    return this.prisma.venue.create({
      data: {
        organizationId: input.organizationId,
        name: input.name,
        timezone: input.timezone,
        externalIds: input.externalIds ?? {},
      },
    });
  }

  async getVenue(venueId: string) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      include: { allocationPolicies: { orderBy: { version: "desc" } } },
    });
    if (!venue) throw new NotFoundException(`Venue ${venueId} not found`);
    return venue;
  }

  /** Manager-facing identity, connection, payout readiness, and actor overview. */
  async workerConnections(venueId: string) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true, name: true, payoutSignerWallet: true },
    });
    if (!venue) throw new NotFoundException(`Venue ${venueId} not found`);

    const [accounts, unmappedShifts, latestRebuild] = await Promise.all([
      this.prisma.externalWorkerAccount.findMany({
        where: { venueId },
        include: {
          worker: {
            include: {
              user: { select: { displayName: true, email: true } },
              defaultWallet: { select: { address: true, status: true } },
            },
          },
        },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.shiftEvidence.findMany({
        where: { venueId, mappedWorkerId: null },
        distinct: ["provider", "externalWorkerId"],
        select: { provider: true, externalWorkerId: true },
      }),
      this.prisma.auditLog.findFirst({
        where: { venueId, action: "INCOME_ENTRIES_REBUILT" },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const workerIds = [...new Set(accounts.map((account) => account.workerId))];
    const [allocations, payouts, incomeEntries] = await Promise.all([
      workerIds.length
        ? this.prisma.workerAllocation.findMany({
            where: { workerId: { in: workerIds }, batch: { venueId } },
            include: { batch: true },
          })
        : [],
      workerIds.length
        ? this.prisma.payout.findMany({
            where: { workerId: { in: workerIds }, venueId },
            orderBy: { createdAt: "desc" },
          })
        : [],
      workerIds.length
        ? this.prisma.incomeEntry.findMany({
            where: { workerId: { in: workerIds }, venueId, effectiveStatus: "ACTIVE" },
            select: { workerId: true, updatedAt: true },
          })
        : [],
    ]);

    const actorIds = new Set<string>();
    for (const allocation of allocations) {
      if (allocation.batch.calculatedBy) actorIds.add(allocation.batch.calculatedBy);
      if (allocation.batch.approvedBy) actorIds.add(allocation.batch.approvedBy);
    }
    for (const payout of payouts) {
      if (payout.initiatedByUserId) actorIds.add(payout.initiatedByUserId);
      if (payout.submittedByUserId) actorIds.add(payout.submittedByUserId);
    }
    for (const account of accounts) {
      if (account.verifiedBy) actorIds.add(account.verifiedBy);
    }
    if (latestRebuild?.actorUserId) actorIds.add(latestRebuild.actorUserId);
    const actors = actorIds.size
      ? await this.prisma.user.findMany({
          where: { id: { in: [...actorIds] } },
          select: { id: true, displayName: true, email: true },
        })
      : [];
    const actorById = new Map(
      actors.map((actor) => [
        actor.id,
        { displayName: actor.displayName, emailMasked: maskEmail(actor.email) },
      ]),
    );
    const actor = (id: string | null | undefined) =>
      id ? (actorById.get(id) ?? { displayName: "Unknown user", emailMasked: null }) : null;

    const accountsByWorker = new Map<string, typeof accounts>();
    for (const account of accounts) {
      accountsByWorker.set(account.workerId, [
        ...(accountsByWorker.get(account.workerId) ?? []),
        account,
      ]);
    }

    const linkedMembers = [...accountsByWorker.entries()].map(([workerId, workerAccounts]) => {
      const profile = workerAccounts[0]!.worker;
      const workerAllocations = allocations
        .filter((allocation) => allocation.workerId === workerId)
        .sort(
          (a, b) =>
            b.batch.businessDate.localeCompare(a.batch.businessDate) ||
            (b.batch.calculatedAt?.getTime() ?? 0) - (a.batch.calculatedAt?.getTime() ?? 0),
        );
      const latestAllocation = workerAllocations[0] ?? null;
      const latestPayout = payouts.find((payout) => payout.workerId === workerId) ?? null;
      const workerIncome = incomeEntries.filter((entry) => entry.workerId === workerId);
      const confirmed = workerAccounts.some((account) => account.mappingStatus === "CONFIRMED");
      const walletReady = profile.defaultWallet?.status === "ACTIVE";

      return {
        key: workerId,
        workerId,
        displayName: profile.user.displayName,
        emailMasked: maskEmail(profile.user.email),
        connectionStage: confirmed
          ? walletReady
            ? "PAYOUT_READY"
            : "CONNECTED"
          : "MAPPING_PENDING",
        externalAccounts: workerAccounts.map((account) => ({
          provider: account.provider,
          externalWorkerId: account.externalWorkerId,
          mappingStatus: account.mappingStatus,
          verifiedAt: account.verifiedAt,
          verifiedBy: actor(account.verifiedBy),
        })),
        defaultWalletMasked: maskWallet(profile.defaultWallet?.address),
        latestAllocation: latestAllocation
          ? {
              businessDate: latestAllocation.batch.businessDate,
              amountUsdCents: latestAllocation.netAllocatedUsdCents,
              payoutStatus: latestAllocation.payoutStatus,
              calculatedAt: latestAllocation.batch.calculatedAt,
              calculatedBy: actor(latestAllocation.batch.calculatedBy),
              approvedAt: latestAllocation.batch.approvedAt,
              approvedBy: actor(latestAllocation.batch.approvedBy),
            }
          : null,
        latestPayout: latestPayout
          ? {
              rail: latestPayout.rail,
              status: latestPayout.status,
              signerWalletMasked: maskWallet(latestPayout.signerWallet),
              submittedBy: actor(latestPayout.submittedByUserId),
              txSignature: latestPayout.txSignature,
              settledAt: latestPayout.settledAt,
            }
          : null,
        incomeEntries: {
          count: workerIncome.length,
          lastUpdatedAt:
            workerIncome.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]
              ?.updatedAt ?? null,
        },
      };
    });

    const mappedKeys = new Set(accounts.map((a) => `${a.provider}:${a.externalWorkerId}`));
    const externalMembers = unmappedShifts
      .filter((shift) => !mappedKeys.has(`${shift.provider}:${shift.externalWorkerId}`))
      .map((shift) => ({
        key: `external:${shift.provider}:${shift.externalWorkerId}`,
        workerId: null,
        displayName: shift.externalWorkerId,
        emailMasked: null,
        connectionStage: "EXTERNAL_ONLY",
        externalAccounts: [
          { ...shift, mappingStatus: "UNMAPPED", verifiedAt: null, verifiedBy: null },
        ],
        defaultWalletMasked: null,
        latestAllocation: null,
        latestPayout: null,
        incomeEntries: { count: 0, lastUpdatedAt: null },
      }));

    return {
      venue: {
        id: venue.id,
        name: venue.name,
        payoutSignerWalletMasked: maskWallet(venue.payoutSignerWallet),
      },
      latestIncomeRebuild: latestRebuild
        ? {
            at: latestRebuild.createdAt,
            actor: actor(latestRebuild.actorUserId),
            source:
              typeof latestRebuild.detail === "object" && latestRebuild.detail
                ? ((latestRebuild.detail as { source?: string }).source ?? "SYSTEM")
                : "SYSTEM",
          }
        : null,
      members: [...linkedMembers, ...externalMembers],
    };
  }

  /** GET /venues/:id/action-items — the manager's "what needs me today" inbox. */
  async actionItems(venueId: string) {
    const [unmappedShiftWorkers, batches, evidenceDates, unpaidAllocations] = await Promise.all([
      this.prisma.shiftEvidence.findMany({
        where: { venueId, mappedWorkerId: null },
        distinct: ["provider", "externalWorkerId"],
        select: { externalWorkerId: true },
      }),
      this.prisma.allocationBatch.findMany({
        where: { venueId },
        select: { id: true, businessDate: true, status: true },
      }),
      this.prisma.shiftEvidence.findMany({
        where: { venueId },
        distinct: ["businessDate"],
        select: { businessDate: true },
      }),
      this.prisma.workerAllocation.findMany({
        where: {
          payoutStatus: "UNPAID",
          batch: { venueId, status: { in: ["PAYABLE", "PARTIALLY_PAID"] } },
        },
        select: {
          netAllocatedUsdCents: true,
          batch: { select: { id: true, businessDate: true, status: true } },
        },
      }),
    ]);
    const batchDates = new Set(batches.map((b) => b.businessDate));
    const uncalculatedDates = evidenceDates
      .map((e) => e.businessDate)
      .filter((d) => !batchDates.has(d))
      .sort()
      .reverse();
    const awaitingApproval = batches
      .filter((b) => ["CALCULATED", "REVIEW_REQUIRED"].includes(b.status))
      .sort((a, b) => b.businessDate.localeCompare(a.businessDate));
    const unpaidBatchMap = new Map<
      string,
      { id: string; businessDate: string; status: string; unpaidCount: number }
    >();
    for (const a of unpaidAllocations) {
      const entry = unpaidBatchMap.get(a.batch.id) ?? { ...a.batch, unpaidCount: 0 };
      entry.unpaidCount += 1;
      unpaidBatchMap.set(a.batch.id, entry);
    }
    return {
      unmappedWorkerCount: unmappedShiftWorkers.length,
      uncalculatedDates,
      awaitingApprovalCount: awaitingApproval.length,
      awaitingApproval,
      unpaidAllocationCount: unpaidAllocations.length,
      unpaidTotalUsdCents: unpaidAllocations.reduce((s, a) => s + a.netAllocatedUsdCents, 0),
      unpaidBatches: [...unpaidBatchMap.values()].sort((a, b) =>
        b.businessDate.localeCompare(a.businessDate),
      ),
    };
  }

  /** Spec §22 — POST /venues/:id/wallet (payout signer wallet, §9.3) */
  setVenueWallet(venueId: string, payoutSignerWallet: string) {
    return this.prisma.venue.update({
      where: { id: venueId },
      data: { payoutSignerWallet },
    });
  }
}
