import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { maskWallet } from "../common/privacy";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class WorkersService {
  constructor(private readonly prisma: PrismaService) {}

  private async getWorkerByUserId(userId: string) {
    const worker = await this.prisma.worker.findUnique({ where: { userId } });
    if (!worker) throw new NotFoundException("No worker profile for this user");
    return worker;
  }

  /** Worker self view (spec §3.1): profile, external accounts, wallets. */
  async getMe(userId: string) {
    const worker = await this.prisma.worker.findUnique({
      where: { userId },
      include: {
        user: { select: { email: true, displayName: true } },
        wallets: { orderBy: { linkedAt: "asc" } },
        externalAccounts: {
          include: { venue: { select: { id: true, name: true } } },
        },
      },
    });
    if (!worker) throw new NotFoundException("No worker profile for this user");
    return worker;
  }

  /** Worker-facing cards for every venue identity connected to this account. */
  async venueConnections(userId: string) {
    const worker = await this.prisma.worker.findUnique({
      where: { userId },
      include: {
        defaultWallet: { select: { address: true, status: true } },
        externalAccounts: {
          include: { venue: { select: { id: true, name: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!worker) throw new NotFoundException("No worker profile for this user");

    const venueIds = [...new Set(worker.externalAccounts.map((account) => account.venueId))];
    if (venueIds.length === 0) return [];
    const [allocations, payouts, incomeEntries] = await Promise.all([
      this.prisma.workerAllocation.findMany({
        where: { workerId: worker.id, batch: { venueId: { in: venueIds } } },
        include: { batch: { select: { venueId: true, businessDate: true } } },
      }),
      this.prisma.payout.findMany({
        where: { workerId: worker.id, venueId: { in: venueIds } },
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.incomeEntry.findMany({
        where: { workerId: worker.id, venueId: { in: venueIds }, effectiveStatus: "ACTIVE" },
        select: { venueId: true, updatedAt: true },
      }),
    ]);

    const accountsByVenue = new Map<string, typeof worker.externalAccounts>();
    for (const account of worker.externalAccounts) {
      accountsByVenue.set(account.venueId, [
        ...(accountsByVenue.get(account.venueId) ?? []),
        account,
      ]);
    }

    return [...accountsByVenue.entries()].map(([venueId, accounts]) => {
      const venue = accounts[0]!.venue;
      const latestAllocation = allocations
        .filter((allocation) => allocation.batch.venueId === venueId)
        .sort((a, b) => b.batch.businessDate.localeCompare(a.batch.businessDate))[0];
      const latestPayout = payouts.find((payout) => payout.venueId === venueId);
      const venueIncome = incomeEntries.filter((entry) => entry.venueId === venueId);
      const confirmed = accounts.some((account) => account.mappingStatus === "CONFIRMED");
      const walletReady = worker.defaultWallet?.status === "ACTIVE";
      return {
        venue,
        connectionStage: confirmed
          ? walletReady
            ? "PAYOUT_READY"
            : "CONNECTED"
          : "MAPPING_PENDING",
        externalAccounts: accounts.map((account) => ({
          provider: account.provider,
          externalWorkerId: account.externalWorkerId,
          mappingStatus: account.mappingStatus,
          verifiedAt: account.verifiedAt,
        })),
        defaultWalletMasked: maskWallet(worker.defaultWallet?.address),
        latestAllocation: latestAllocation
          ? {
              businessDate: latestAllocation.batch.businessDate,
              amountUsdCents: latestAllocation.netAllocatedUsdCents,
              payoutStatus: latestAllocation.payoutStatus,
              payoutRail: latestAllocation.payoutRail,
            }
          : null,
        latestPayout: latestPayout
          ? {
              rail: latestPayout.rail,
              status: latestPayout.status,
              txSignature: latestPayout.txSignature,
              settledAt: latestPayout.settledAt,
            }
          : null,
        incomeEntries: {
          count: venueIncome.length,
          lastUpdatedAt:
            venueIncome.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]
              ?.updatedAt ?? null,
        },
      };
    });
  }

  /**
   * Spec §4.4 — wallets are replaceable payout accounts; multiple allowed,
   * exactly one active default.
   */
  async addWallet(
    userId: string,
    input: { address: string; walletType?: "EXTERNAL" | "EMBEDDED" },
  ) {
    const worker = await this.getWorkerByUserId(userId);
    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.workerWallet.upsert({
        where: {
          workerId_chain_address: {
            workerId: worker.id,
            chain: "solana",
            address: input.address,
          },
        },
        update: { status: "ACTIVE" },
        create: {
          workerId: worker.id,
          address: input.address,
          walletType: input.walletType ?? "EXTERNAL",
        },
      });
      // First wallet becomes the default automatically
      if (!worker.defaultWalletId) {
        await tx.worker.update({ where: { id: worker.id }, data: { defaultWalletId: wallet.id } });
        return tx.workerWallet.update({ where: { id: wallet.id }, data: { isDefault: true } });
      }
      return wallet;
    });
  }

  async setDefaultWallet(userId: string, walletId: string) {
    const worker = await this.getWorkerByUserId(userId);
    const wallet = await this.prisma.workerWallet.findUnique({ where: { id: walletId } });
    if (!wallet || wallet.workerId !== worker.id) {
      throw new NotFoundException("Wallet not found");
    }
    if (wallet.status !== "ACTIVE") {
      throw new BadRequestException("Disabled wallet cannot be the default");
    }
    await this.prisma.$transaction([
      this.prisma.workerWallet.updateMany({
        where: { workerId: worker.id },
        data: { isDefault: false },
      }),
      this.prisma.workerWallet.update({ where: { id: walletId }, data: { isDefault: true } }),
      this.prisma.worker.update({
        where: { id: worker.id },
        data: { defaultWalletId: walletId },
      }),
    ]);
    return this.getMe(userId);
  }
}
