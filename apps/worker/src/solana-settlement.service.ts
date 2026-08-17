import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import {
  canReplaceTransactionBlockhash,
  isBlockhashExpired,
  shouldRebroadcastSignedTransaction,
} from "@serveproof/shared";
import { rebuildVenueIncome } from "@serveproof/db";
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
    this.backfillFinalizedIncomeProjections().catch((error) =>
      this.logger.warn(`finalized income backfill failed: ${error.message}`),
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
    if (payout.status === "FINALIZED") {
      await this.rebuildIncomeProjection(payout.venueId);
      return;
    }
    if (payout.status === "FAILED") return;
    // Ignore delayed jobs from an older attempt after this payout has been
    // rebuilt with a new blockhash/signature.
    if (payout.txSignature !== data.signature) return;

    const status = (
      await this.connection.getSignatureStatuses([data.signature], {
        searchTransactionHistory: true,
      })
    ).value[0];

    if (status?.err) {
      // §29.7 Case C: on-chain error — but the duplicate-payment case means an
      // earlier attempt landed; reconcile before marking failure.
      const record = await fetchSettlementRecord(this.connection, payout.paymentId, "finalized");
      if (record) return this.finalizeFromChain(payout.id, payout.allocationId);
      await this.markFailed(payout.id, payout.allocationId, JSON.stringify(status.err));
      return;
    }

    if (status?.confirmationStatus === "finalized") {
      await this.finalizeFromChain(payout.id, payout.allocationId, status.slot);
      return;
    }

    // Once confirmed, do not create or broadcast a different transaction.
    // Keep polling this signature until it finalizes or disappears from a fork.
    if (status?.confirmationStatus === "confirmed") {
      if (payout.status === "SUBMITTED") {
        await this.prisma.payout.update({
          where: { id: payout.id },
          data: { status: "CONFIRMED" },
        });
      }
      const blockhashExpired =
        payout.lastValidBlockHeight !== null &&
        isBlockhashExpired(
          await this.connection.getBlockHeight("confirmed"),
          payout.lastValidBlockHeight,
        );
      if (
        await this.failIfObservedForkWasDropped(
          payout,
          data.signature,
          status.slot,
          blockhashExpired,
        )
      ) {
        return;
      }
      throw new Error("awaiting finalization");
    }

    if (payout.lastValidBlockHeight !== null) {
      const currentBlockHeight = await this.connection.getBlockHeight("confirmed");
      const blockhashExpired = isBlockhashExpired(currentBlockHeight, payout.lastValidBlockHeight);
      if (!status && canReplaceTransactionBlockhash(null, blockhashExpired)) {
        // The signature is absent and can no longer land under this blockhash.
        // A finalized PDA remains the final authority.
        const record = await fetchSettlementRecord(this.connection, payout.paymentId, "finalized");
        if (record) return this.finalizeFromChain(payout.id, payout.allocationId);
        await this.markFailed(payout.id, payout.allocationId, "transaction_dropped");
        return;
      }
      if (blockhashExpired) {
        if (
          status &&
          (await this.failIfObservedForkWasDropped(
            payout,
            data.signature,
            status.slot,
            blockhashExpired,
          ))
        ) {
          return;
        }
        // It landed before expiry and may still become rooted. A new
        // signature is unsafe until this observation disappears or finalizes.
        throw new Error("expired blockhash has an observed signature; awaiting fork outcome");
      }
    }

    // Not visible/processed but still valid: rebroadcast the exact signed bytes.
    if (shouldRebroadcastSignedTransaction(status?.confirmationStatus ?? null, false)) {
      await this.rebroadcastSameTransaction(payout);
    }
    if (payout.status === "SUBMITTED" && status?.confirmationStatus === "processed") {
      await this.prisma.payout.update({
        where: { id: payout.id },
        data: { status: "SUBMITTED" },
      });
    }
    throw new Error(`awaiting confirmation for ${data.signature.slice(0, 12)}…`);
  }

  /** BullMQ `payout-reconcile` processor — durable fallback after restarts. */
  async reconcileStalePayouts() {
    const stale = await this.prisma.payout.findMany({
      where: {
        rail: "USDC",
        status: { in: ["INITIATED", "SUBMITTED", "CONFIRMED"] },
      },
      orderBy: { initiatedAt: "asc" },
      take: 50,
    });
    if (stale.length === 0) return;

    const currentBlockHeight = await this.connection.getBlockHeight("confirmed");
    const abandonedBefore = new Date(Date.now() - 10 * 60 * 1000);
    for (const payout of stale) {
      const record = await fetchSettlementRecord(this.connection, payout.paymentId, "finalized");
      if (record) {
        await this.finalizeFromChain(payout.id, payout.allocationId);
        continue;
      }

      const status = payout.txSignature
        ? (
            await this.connection.getSignatureStatuses([payout.txSignature], {
              searchTransactionHistory: true,
            })
          ).value[0]
        : null;
      const blockhashExpired =
        payout.lastValidBlockHeight !== null &&
        isBlockhashExpired(currentBlockHeight, payout.lastValidBlockHeight);

      if (status?.err) {
        await this.markFailed(payout.id, payout.allocationId, JSON.stringify(status.err));
      } else if (status?.confirmationStatus === "finalized") {
        await this.markFailed(payout.id, payout.allocationId, "finalized_without_settlement");
      } else if (status?.confirmationStatus === "confirmed") {
        if (payout.status === "SUBMITTED") {
          await this.prisma.payout.update({
            where: { id: payout.id },
            data: { status: "CONFIRMED" },
          });
        }
        if (
          payout.txSignature &&
          (await this.failIfObservedForkWasDropped(
            payout,
            payout.txSignature,
            status.slot,
            blockhashExpired,
          ))
        ) {
          continue;
        }
      } else if (status?.confirmationStatus === "processed") {
        if (
          payout.txSignature &&
          (await this.failIfObservedForkWasDropped(
            payout,
            payout.txSignature,
            status.slot,
            blockhashExpired,
          ))
        ) {
          continue;
        } else if (shouldRebroadcastSignedTransaction("processed", blockhashExpired)) {
          await this.rebroadcastSameTransaction(payout);
        }
      } else if (
        !status &&
        payout.lastValidBlockHeight !== null &&
        canReplaceTransactionBlockhash(null, blockhashExpired)
      ) {
        await this.markFailed(
          payout.id,
          payout.allocationId,
          payout.txSignature ? "transaction_dropped" : "blockhash_expired_before_submit",
        );
      } else if (
        payout.lastValidBlockHeight !== null &&
        shouldRebroadcastSignedTransaction(null, blockhashExpired)
      ) {
        await this.rebroadcastSameTransaction(payout);
      } else if (
        payout.lastValidBlockHeight === null &&
        payout.initiatedAt &&
        payout.initiatedAt < abandonedBefore
      ) {
        // Compatibility for attempts created before blockhash metadata existed.
        await this.markFailed(payout.id, payout.allocationId, "legacy_attempt_timeout");
      }
    }
    if (stale.length > 0) {
      this.logger.log(`reconciled ${stale.length} stale payout(s)`);
    }
  }

  private async rebroadcastSameTransaction(payout: {
    id: string;
    txSignature: string | null;
    signedTransactionBase64: string | null;
  }) {
    if (!payout.txSignature || !payout.signedTransactionBase64) return;

    await this.prisma.payout.updateMany({
      where: { id: payout.id, status: { in: ["SUBMITTED", "CONFIRMED"] } },
      data: { broadcastAttempts: { increment: 1 }, lastBroadcastAt: new Date() },
    });
    const raw = Buffer.from(payout.signedTransactionBase64, "base64");
    try {
      const returnedSignature = await Promise.race([
        this.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("rpc_rebroadcast_timeout")), 10_000),
        ),
      ]);
      if (returnedSignature !== payout.txSignature) {
        this.logger.error(`rebroadcast signature mismatch for payout ${payout.id}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`rebroadcast ${payout.id} failed: ${message}`);
    }
  }

  /**
   * A provider can keep returning a stale processed/confirmed observation from
   * a discarded fork. Once the finalized root has passed that slot, absence
   * from finalized transaction history proves that observation cannot land.
   */
  private async failIfObservedForkWasDropped(
    payout: { id: string; allocationId: string; paymentId: string },
    signature: string,
    observedSlot: number,
    blockhashExpired: boolean,
  ): Promise<boolean> {
    if (!blockhashExpired) return false;
    const finalizedRoot = await this.connection.getSlot("finalized");
    if (finalizedRoot <= observedSlot) return false;

    const finalizedTransaction = await this.connection.getTransaction(signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    if (finalizedTransaction) return false;

    const record = await fetchSettlementRecord(this.connection, payout.paymentId, "finalized");
    if (record) {
      await this.finalizeFromChain(payout.id, payout.allocationId);
    } else {
      await this.markFailed(payout.id, payout.allocationId, "fork_dropped_after_blockhash_expiry");
    }
    return true;
  }

  private async finalizeFromChain(payoutId: string, allocationId: string, slot?: number) {
    const payout = await this.prisma.payout.findUnique({ where: { id: payoutId } });
    if (!payout) return;
    if (payout.status === "FINALIZED") {
      await this.rebuildIncomeProjection(payout.venueId);
      return;
    }

    const record = await fetchSettlementRecord(this.connection, payout.paymentId, "finalized");
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
    await this.rebuildIncomeProjection(payout.venueId);
    this.logger.log(`payout ${payoutId} FINALIZED (settlement on-chain verified)`);
  }

  private async rebuildIncomeProjection(venueId: string) {
    const result = await rebuildVenueIncome(this.prisma, venueId, undefined, "SYSTEM");
    if (!result) {
      this.logger.warn(`income projection skipped; venue ${venueId} no longer exists`);
      return;
    }
    this.logger.log(
      `income projection refreshed after USDC finalization: venue=${venueId} entries=${result.entriesUpserted} alerts=${result.alerts}`,
    );
  }

  private async backfillFinalizedIncomeProjections() {
    const venues = await this.prisma.payout.findMany({
      where: { status: "FINALIZED" },
      distinct: ["venueId"],
      select: { venueId: true },
    });
    for (const { venueId } of venues) {
      await this.rebuildIncomeProjection(venueId);
    }
    if (venues.length > 0) {
      this.logger.log(`backfilled finalized income projections for ${venues.length} venue(s)`);
    }
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
