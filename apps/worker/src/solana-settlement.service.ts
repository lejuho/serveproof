import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { fetchSettlementRecord, getProgram } from "@serveproof/solana";
import { Connection } from "@solana/web3.js";
import { PrismaService } from "./prisma.service";

/**
 * Spec §16.2–§16.3, §29.7 — confirmation, reconciliation, event indexing.
 *
 * Golden rule (§29.7): an HTTP retry is never an excuse to resend USDC.
 * Before declaring failure we always check the SettlementRecord PDA.
 */
@Injectable()
export class SolanaSettlementService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SolanaSettlementService.name);
  private readonly connection = new Connection(
    process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    "confirmed",
  );
  private eventListenerId: number | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.startEventIndexer().catch((e) =>
      this.logger.warn(`event indexer not started: ${e.message}`),
    );
  }

  async onModuleDestroy() {
    if (this.eventListenerId !== null) {
      await getProgram(this.connection)
        .removeEventListener(this.eventListenerId)
        .catch(() => undefined);
    }
  }

  /** Spec §15 — PayoutSettled websocket indexer (fast CONFIRMED signal). */
  private async startEventIndexer() {
    const program = getProgram(this.connection);
    this.eventListenerId = await program.addEventListener(
      "payoutSettled" as never,
      async (event: { paymentIdHash: number[]; amount: { toString(): string } }) => {
        const hashHex = Buffer.from(event.paymentIdHash).toString("hex");
        const payout = await this.prisma.payout.findUnique({
          where: { paymentIdHash: hashHex },
        });
        if (!payout) {
          this.logger.warn(`PayoutSettled for unknown paymentIdHash ${hashHex.slice(0, 16)}…`);
          return;
        }
        if (["SUBMITTED", "INITIATED"].includes(payout.status)) {
          await this.prisma.payout.update({
            where: { id: payout.id },
            data: { status: "CONFIRMED" },
          });
          this.logger.log(`payout ${payout.id} CONFIRMED via PayoutSettled event`);
        }
      },
    );
    this.logger.log("PayoutSettled event indexer subscribed");
  }

  /** BullMQ `solana-confirmation` processor. Throws to trigger retry/backoff. */
  async processConfirmation(data: { payoutId: string; signature: string }) {
    const payout = await this.prisma.payout.findUnique({ where: { id: data.payoutId } });
    if (!payout) return;
    if (["FINALIZED", "FAILED"].includes(payout.status)) return;

    const status = (
      await this.connection.getSignatureStatuses([data.signature], {
        searchTransactionHistory: true,
      })
    ).value[0];

    if (!status) {
      // Not visible yet — maybe still propagating, maybe blockhash expired.
      // §29.7 Case B: only fail after the PDA check says nothing landed.
      const record = await fetchSettlementRecord(this.connection, payout.paymentId);
      if (record) return this.finalizeFromChain(payout.id, payout.allocationId);
      throw new Error(`signature ${data.signature.slice(0, 12)}… not found yet`);
    }

    if (status.err) {
      // §29.7 Case C: on-chain error — but the duplicate-payment case means an
      // earlier attempt landed; reconcile before marking failure.
      const record = await fetchSettlementRecord(this.connection, payout.paymentId);
      if (record) return this.finalizeFromChain(payout.id, payout.allocationId);
      await this.markFailed(payout.id, payout.allocationId, JSON.stringify(status.err));
      return;
    }

    if (status.confirmationStatus === "finalized") {
      await this.finalizeFromChain(payout.id, payout.allocationId, status.slot);
      return;
    }

    // processed/confirmed → show progress, retry until finalized (§29.7 기준)
    if (payout.status === "SUBMITTED") {
      await this.prisma.payout.update({
        where: { id: payout.id },
        data: { status: "CONFIRMED" },
      });
    }
    throw new Error("awaiting finalization");
  }

  /** BullMQ `payout-reconcile` processor — sweeps stale in-flight payouts. */
  async reconcileStalePayouts() {
    const staleBefore = new Date(Date.now() - 2 * 60 * 1000);
    const stale = await this.prisma.payout.findMany({
      where: {
        rail: "USDC",
        status: { in: ["INITIATED", "SUBMITTED", "CONFIRMED"] },
        initiatedAt: { lt: staleBefore },
      },
      take: 20,
    });
    const abandonedBefore = new Date(Date.now() - 10 * 60 * 1000);
    for (const payout of stale) {
      const record = await fetchSettlementRecord(this.connection, payout.paymentId);
      if (record) {
        await this.finalizeFromChain(payout.id, payout.allocationId);
        continue;
      }
      if (!payout.initiatedAt || payout.initiatedAt >= abandonedBefore) continue;

      // No settlement PDA after 10+ minutes. Deciding failure is safe as long
      // as nothing can still land: the blockhash is long expired, and even if
      // a ghost tx did land later, buildTransaction rechecks the PDA before a
      // retry (settle is also idempotent on-chain, so it cannot double-pay).
      if (!payout.txSignature) {
        // INITIATED (never submitted) or event-indexer CONFIRMED whose tx was
        // dropped from a fork before the signature was ever persisted
        await this.markFailed(payout.id, payout.allocationId, "blockhash_expired");
        continue;
      }
      const status = (
        await this.connection.getSignatureStatuses([payout.txSignature], {
          searchTransactionHistory: true,
        })
      ).value[0];
      if (!status) {
        await this.markFailed(payout.id, payout.allocationId, "transaction_dropped");
        continue;
      }
      if (status.err) {
        await this.markFailed(
          payout.id,
          payout.allocationId,
          `transaction_failed:${JSON.stringify(status.err)}`,
        );
        continue;
      }
      if (status.confirmationStatus === "finalized") {
        // A finalized successful signature is immutable. If the expected PDA
        // is still absent after the grace period, this signature did not
        // produce the settlement and retrying the logical payment is safe.
        await this.markFailed(payout.id, payout.allocationId, "finalized_without_settlement");
      }
    }
    if (stale.length > 0) {
      this.logger.log(`reconciled ${stale.length} stale payout(s)`);
    }
  }

  private async finalizeFromChain(payoutId: string, allocationId: string, slot?: number) {
    const payout = await this.prisma.payout.findUnique({ where: { id: payoutId } });
    if (!payout || payout.status === "FINALIZED") return;

    const record = await fetchSettlementRecord(this.connection, payout.paymentId);
    if (!record) throw new Error("finalize requested but SettlementRecord not found");
    if (BigInt(payout.amountBaseUnits.toString()) !== record.amount) {
      this.logger.error(`amount mismatch for payout ${payoutId}: db≠chain`);
    }

    const blockTime = slot ? await this.connection.getBlockTime(slot).catch(() => null) : null;
    await this.prisma.$transaction([
      this.prisma.payout.update({
        where: { id: payoutId },
        data: {
          status: "FINALIZED",
          slot: slot ? BigInt(slot) : undefined,
          blockTime: blockTime ? new Date(blockTime * 1000) : undefined,
          settledAt: new Date(record.settledAt * 1000),
          failedReason: null,
        },
      }),
      this.prisma.workerAllocation.update({
        where: { id: allocationId },
        data: { payoutStatus: "PAID" },
      }),
    ]);
    await this.refreshBatchPaymentStatus(allocationId);
    this.logger.log(`payout ${payoutId} FINALIZED (settlement on-chain verified)`);
  }

  private async markFailed(payoutId: string, allocationId: string, reason: string) {
    await this.prisma.$transaction([
      this.prisma.payout.update({
        where: { id: payoutId },
        data: { status: "FAILED", failedReason: reason },
      }),
      this.prisma.workerAllocation.update({
        where: { id: allocationId },
        data: { payoutStatus: "FAILED" },
      }),
    ]);
    this.logger.warn(`payout ${payoutId} FAILED: ${reason}`);
  }

  private async refreshBatchPaymentStatus(allocationId: string) {
    const allocation = await this.prisma.workerAllocation.findUnique({
      where: { id: allocationId },
      select: { batchId: true },
    });
    if (!allocation) return;
    const allocations = await this.prisma.workerAllocation.findMany({
      where: { batchId: allocation.batchId },
    });
    const paid = allocations.filter((a) => a.payoutStatus === "PAID").length;
    const status = paid === 0 ? "PAYABLE" : paid === allocations.length ? "PAID" : "PARTIALLY_PAID";
    await this.prisma.allocationBatch.updateMany({
      where: { id: allocation.batchId, status: { in: ["PAYABLE", "PARTIALLY_PAID", "PAID"] } },
      data: { status },
    });
  }
}
