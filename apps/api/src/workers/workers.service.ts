import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@serveproof/db";
import { maskWallet } from "../common/privacy";
import { IncomeService } from "../income/income.service";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class WorkersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly income: IncomeService,
  ) {}

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

  /** Initial worker screen payload; secondary tabs load their own data on demand. */
  async overview(userId: string) {
    const worker = await this.prisma.worker.findUnique({
      where: { userId },
      select: {
        id: true,
        user: { select: { email: true, displayName: true } },
        wallets: {
          select: { id: true, address: true, isDefault: true, status: true, linkedAt: true },
          orderBy: { linkedAt: "asc" },
        },
      },
    });
    if (!worker) throw new NotFoundException("No worker profile for this user");

    const [summary, alerts, timeline] = await Promise.all([
      this.income.summaryForWorker(worker.id),
      this.income.discrepanciesForWorker(worker.id),
      this.income.timelineForWorker(worker.id, undefined, 25),
    ]);
    return { me: worker, summary, alerts, timeline };
  }

  /** Worker-facing cards for every venue identity connected to this account. */
  async venueConnections(userId: string) {
    const worker = await this.prisma.worker.findUnique({
      where: { userId },
      include: {
        defaultWallet: { select: { address: true, status: true } },
        externalAccounts: {
          where: { mappingStatus: { not: "REJECTED" } },
          include: { venue: { select: { id: true, name: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!worker) throw new NotFoundException("No worker profile for this user");

    const venueIds = [...new Set(worker.externalAccounts.map((account) => account.venueId))];
    if (venueIds.length === 0) return [];
    const venueList = Prisma.join(venueIds);
    const [allocations, payouts, incomeEntries] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          venueId: string;
          businessDate: string;
          amountUsdCents: number;
          payoutStatus: string;
          payoutRail: string | null;
        }>
      >(Prisma.sql`
        SELECT DISTINCT ON (b."venueId")
          b."venueId" AS "venueId",
          b."businessDate" AS "businessDate",
          a."netAllocatedUsdCents" AS "amountUsdCents",
          a."payoutStatus"::text AS "payoutStatus",
          a."payoutRail"::text AS "payoutRail"
        FROM "WorkerAllocation" a
        JOIN "AllocationBatch" b ON b.id = a."batchId"
        WHERE a."workerId" = ${worker.id}
          AND b."venueId" IN (${venueList})
        ORDER BY b."venueId", b."businessDate" DESC, b."createdAt" DESC, a.id DESC
      `),
      this.prisma.$queryRaw<
        Array<{
          venueId: string;
          rail: string;
          status: string;
          txSignature: string | null;
          settledAt: Date | null;
        }>
      >(Prisma.sql`
        SELECT DISTINCT ON (p."venueId")
          p."venueId" AS "venueId",
          p.rail::text AS rail,
          p.status::text AS status,
          p."txSignature" AS "txSignature",
          p."settledAt" AS "settledAt"
        FROM "Payout" p
        WHERE p."workerId" = ${worker.id}
          AND p."venueId" IN (${venueList})
        ORDER BY p."venueId", p."createdAt" DESC, p.id DESC
      `),
      this.prisma.incomeEntry.groupBy({
        by: ["venueId"],
        where: { workerId: worker.id, venueId: { in: venueIds }, effectiveStatus: "ACTIVE" },
        _count: { _all: true },
        _max: { updatedAt: true },
      }),
    ]);

    const allocationByVenue = new Map(
      allocations.map((allocation) => [allocation.venueId, allocation]),
    );
    const payoutByVenue = new Map(payouts.map((payout) => [payout.venueId, payout]));
    const incomeByVenue = new Map(incomeEntries.map((entry) => [entry.venueId, entry]));

    const accountsByVenue = new Map<string, typeof worker.externalAccounts>();
    for (const account of worker.externalAccounts) {
      accountsByVenue.set(account.venueId, [
        ...(accountsByVenue.get(account.venueId) ?? []),
        account,
      ]);
    }

    return [...accountsByVenue.entries()].map(([venueId, accounts]) => {
      const venue = accounts[0]!.venue;
      const latestAllocation = allocationByVenue.get(venueId);
      const latestPayout = payoutByVenue.get(venueId);
      const venueIncome = incomeByVenue.get(venueId);
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
          id: account.id,
          provider: account.provider,
          externalWorkerId: account.externalWorkerId,
          mappingStatus: account.mappingStatus,
          verifiedAt: account.verifiedAt,
        })),
        defaultWalletMasked: maskWallet(worker.defaultWallet?.address),
        latestAllocation: latestAllocation
          ? {
              businessDate: latestAllocation.businessDate,
              amountUsdCents: latestAllocation.amountUsdCents,
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
          count: venueIncome?._count._all ?? 0,
          lastUpdatedAt: venueIncome?._max.updatedAt ?? null,
        },
      };
    });
  }

  /** Planning signal only: amounts not yet matched to payroll/withholding evidence. */
  async taxReadiness(userId: string) {
    const worker = await this.getWorkerByUserId(userId);
    const year = new Date().getUTCFullYear();
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year + 1, 0, 1));
    const entries = await this.prisma.incomeEntry.findMany({
      where: {
        workerId: worker.id,
        effectiveStatus: "ACTIVE",
        OR: [
          { shift: { clockIn: { gte: yearStart, lt: yearEnd } } },
          { shiftId: null, createdAt: { gte: yearStart, lt: yearEnd } },
        ],
      },
      select: {
        paidUsdCents: true,
        payrollReportedUsdCents: true,
        payoutRail: true,
        withholdingStatus: true,
        payout: { select: { asset: true } },
      },
    });
    const byRail: Record<string, number> = {};
    let unmatchedUsdCents = 0;
    let devnetTestUsdCents = 0;
    let withholdingUnknownUsdCents = 0;
    for (const entry of entries) {
      const unmatched = Math.max(0, entry.paidUsdCents - entry.payrollReportedUsdCents);
      if (entry.payout?.asset === "tUSDC") {
        devnetTestUsdCents += unmatched;
        continue;
      }
      unmatchedUsdCents += unmatched;
      const rail = entry.payoutRail ?? "UNSPECIFIED";
      byRail[rail] = (byRail[rail] ?? 0) + unmatched;
      if (entry.withholdingStatus !== "CONFIRMED") {
        withholdingUnknownUsdCents += entry.paidUsdCents;
      }
    }
    return {
      year,
      unmatchedUsdCents,
      withholdingUnknownUsdCents,
      devnetTestUsdCents,
      byRail,
      guidance: {
        tipIncome: "https://www.irs.gov/newsroom/tip-income-is-taxable-and-must-be-reported",
        withholding: "https://www.irs.gov/individuals/employees/tax-withholding",
        estimatedTax: "https://www.irs.gov/publications/p505",
      },
      disclaimer:
        "Planning information only; this is not tax advice or a tax liability calculation.",
    };
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
