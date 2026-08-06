import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
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
