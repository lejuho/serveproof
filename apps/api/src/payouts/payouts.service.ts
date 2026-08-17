import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from "@nestjs/common";
import { rebuildVenueIncome } from "@serveproof/db";
import { centsToUsdcBaseUnits, encodeBase58, isBlockhashExpired, QUEUES } from "@serveproof/shared";
import { buildSettlePayoutTx, fetchSettlementRecord, parsePubkey } from "@serveproof/solana";
import { Connection, Transaction } from "@solana/web3.js";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { PrismaService } from "../prisma/prisma.service";

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

@Injectable()
export class PayoutsService implements OnModuleDestroy {
  private readonly logger = new Logger(PayoutsService.name);
  private readonly connection = new Connection(
    process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    "confirmed",
  );
  private readonly redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });
  private readonly confirmationQueue = new Queue(QUEUES.solanaConfirmation, {
    connection: this.redis,
  });

  constructor(private readonly prisma: PrismaService) {}

  async onModuleDestroy() {
    await this.confirmationQueue.close().catch(() => undefined);
    await this.redis.quit().catch(() => undefined);
  }

  /**
   * Spec §16.1 — create the Payout row. paymentId = allocation id, so the DB
   * unique constraint makes one logical payment per allocation (idempotent).
   */
  async createUsdcPayout(allocationId: string, initiatedByUserId?: string) {
    const allocation = await this.prisma.workerAllocation.findUnique({
      where: { id: allocationId },
      include: {
        batch: true,
        worker: { include: { defaultWallet: true } },
      },
    });
    if (!allocation) throw new NotFoundException(`Allocation ${allocationId} not found`);
    if (!allocation.workerId || !allocation.worker) {
      throw new BadRequestException(
        "This share is held for a worker who has not connected their account yet",
      );
    }
    if (!["PAYABLE", "PARTIALLY_PAID"].includes(allocation.batch.status)) {
      throw new BadRequestException(
        `Batch is ${allocation.batch.status}; payouts require an approved (PAYABLE) batch`,
      );
    }
    if (allocation.payoutStatus === "PAID") {
      throw new ConflictException("Allocation is already paid");
    }
    if (allocation.netAllocatedUsdCents <= 0) {
      throw new BadRequestException("Allocation amount must be positive");
    }
    const wallet = allocation.worker.defaultWallet;
    if (!wallet || wallet.status !== "ACTIVE") {
      throw new BadRequestException("Worker has no active default wallet");
    }
    parsePubkey(wallet.address); // fail fast on non-Solana addresses

    const paymentId = allocation.id;
    const existing = await this.prisma.payout.findUnique({ where: { paymentId } });
    if (existing && !["FAILED"].includes(existing.status)) {
      // Idempotent retries must also heal the denormalized allocation status.
      // A dropped browser response or a CONFIRMED fork event can otherwise
      // leave the dashboard saying UNPAID while the payout is still in flight.
      const allocationStatus =
        existing.status === "FINALIZED"
          ? "PAID"
          : ["CREATED", "INITIATED", "SUBMITTED", "CONFIRMED"].includes(existing.status)
            ? "PENDING"
            : null;
      if (
        allocationStatus &&
        (allocation.payoutStatus !== allocationStatus || allocation.payoutRail !== "USDC")
      ) {
        await this.prisma.workerAllocation.update({
          where: { id: allocation.id },
          data: { payoutRail: "USDC", payoutStatus: allocationStatus },
        });
        if (allocationStatus === "PAID") {
          await this.refreshBatchPaymentStatus(allocation.batchId);
          await this.rebuildIncomeProjection(allocation.batch.venueId, initiatedByUserId);
        }
      }
      return existing; // idempotent create
    }

    // FAILED means retryable, but the previous signed transaction may still
    // be accepted until its blockhash expires. Never issue a new blockhash in
    // that window, even after a deterministic-looking RPC failure.
    if (existing?.lastValidBlockHeight !== null && existing?.lastValidBlockHeight !== undefined) {
      const currentBlockHeight = await this.connection.getBlockHeight("confirmed");
      if (!isBlockhashExpired(currentBlockHeight, existing.lastValidBlockHeight)) {
        throw new ConflictException(
          `Previous payout blockhash is still valid through height ${existing.lastValidBlockHeight.toString()}`,
        );
      }
    }

    const amountBaseUnits = centsToUsdcBaseUnits(allocation.netAllocatedUsdCents);
    const data = {
      paymentId,
      paymentIdHash: sha256Hex(paymentId),
      allocationId: allocation.id,
      workerId: allocation.workerId,
      venueId: allocation.batch.venueId,
      walletId: wallet.id,
      rail: "USDC" as const,
      asset: "tUSDC",
      amountBaseUnits,
      amountUsdCents: allocation.netAllocatedUsdCents,
      status: "CREATED" as const,
      txSignature: null,
      settlementPda: null,
      recentBlockhash: null,
      lastValidBlockHeight: null,
      signedTransactionBase64: null,
      lastBroadcastAt: null,
      broadcastAttempts: 0,
      initiatedAt: null,
      initiatedByUserId: initiatedByUserId ?? null,
      submittedByUserId: null,
      signerWallet: null,
      settledAt: null,
      failedReason: null,
    };
    const [payout] = await this.prisma.$transaction([
      existing
        ? this.prisma.payout.update({ where: { id: existing.id }, data })
        : this.prisma.payout.create({ data }),
      this.prisma.workerAllocation.update({
        where: { id: allocation.id },
        data: { payoutRail: "USDC", payoutStatus: "PENDING" },
      }),
    ]);
    return payout;
  }

  /**
   * Spec §29.4 — build the UNSIGNED settle_payout transaction for the venue
   * wallet to sign. Also records blockhash metadata for expiry handling.
   */
  async buildTransaction(payoutId: string, initiatedByUserId?: string) {
    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
      include: { wallet: true, allocation: { include: { batch: true } } },
    });
    if (!payout) throw new NotFoundException(`Payout ${payoutId} not found`);
    if (!["CREATED", "INITIATED", "FAILED"].includes(payout.status)) {
      throw new ConflictException(`Payout is ${payout.status}; cannot rebuild transaction`);
    }
    // §29.7 — never rebuild if the settlement already landed on-chain
    const onchain = await fetchSettlementRecord(this.connection, payout.paymentId);
    if (onchain) {
      throw new ConflictException("Settlement already exists on-chain; run reconciliation");
    }
    if (["INITIATED", "FAILED"].includes(payout.status) && payout.lastValidBlockHeight !== null) {
      const currentBlockHeight = await this.connection.getBlockHeight("confirmed");
      if (!isBlockhashExpired(currentBlockHeight, payout.lastValidBlockHeight)) {
        throw new ConflictException(
          `Previous payout blockhash is still valid through height ${payout.lastValidBlockHeight.toString()}`,
        );
      }
    }

    const venue = await this.prisma.venue.findUnique({ where: { id: payout.venueId } });
    if (!venue?.payoutSignerWallet) {
      throw new BadRequestException("Venue payout signer wallet is not configured");
    }
    if (!payout.wallet) throw new BadRequestException("Payout has no worker wallet");
    if (!payout.allocation.batch.allocationHash) {
      throw new BadRequestException("Batch is missing its allocation hash");
    }
    const usdcMint = process.env.USDC_MINT;
    if (!usdcMint) throw new BadRequestException("USDC_MINT is not configured");

    const built = await buildSettlePayoutTx({
      connection: this.connection,
      venueId: payout.venueId,
      paymentId: payout.paymentId,
      allocationHashHex: payout.allocation.batch.allocationHash,
      amountBaseUnits: BigInt(payout.amountBaseUnits.toString()),
      venueAuthority: parsePubkey(venue.payoutSignerWallet),
      workerWallet: parsePubkey(payout.wallet.address),
      usdcMint: parsePubkey(usdcMint),
    });

    const claimed = await this.prisma.payout.updateMany({
      where: { id: payoutId, status: { in: ["CREATED", "INITIATED", "FAILED"] } },
      data: {
        status: "INITIATED",
        settlementPda: built.settlementPda,
        recentBlockhash: built.blockhash,
        lastValidBlockHeight: BigInt(built.lastValidBlockHeight),
        signedTransactionBase64: null,
        txSignature: null,
        lastBroadcastAt: null,
        broadcastAttempts: 0,
        initiatedAt: new Date(),
        initiatedByUserId: initiatedByUserId ?? payout.initiatedByUserId,
        submittedByUserId: null,
        signerWallet: venue.payoutSignerWallet,
        failedReason: null,
      },
    });
    if (claimed.count === 0) {
      const current = await this.prisma.payout.findUnique({ where: { id: payoutId } });
      throw new ConflictException(
        `Payout is ${current?.status ?? "UNKNOWN"}; cannot rebuild transaction`,
      );
    }

    return {
      payoutId,
      transactionBase64: built.transactionBase64,
      blockhash: built.blockhash,
      lastValidBlockHeight: built.lastValidBlockHeight,
      settlementPda: built.settlementPda,
      signer: venue.payoutSignerWallet,
    };
  }

  /**
   * Spec §16.1 step 7–9 — submit the signed transaction and enqueue confirmation.
   *
   * The signature is derived locally and persisted BEFORE broadcasting, so even
   * if the RPC hangs or the HTTP response is lost, confirmation/reconcile jobs
   * can track the transaction (§29.7 — broadcast state must never be untracked).
   */
  async submitSigned(
    payoutId: string,
    signedTransactionBase64: string,
    submittedByUserId?: string,
  ) {
    const payout = await this.prisma.payout.findUnique({ where: { id: payoutId } });
    if (!payout) throw new NotFoundException(`Payout ${payoutId} not found`);
    // A browser retry or a second tab may submit after the first request has
    // already persisted/broadcast the transaction. Treat that as an
    // idempotent success and, critically, never broadcast the second payload.
    if (["SUBMITTED", "CONFIRMED", "FINALIZED"].includes(payout.status)) {
      return payout;
    }
    if (payout.status !== "INITIATED") {
      throw new ConflictException(`Payout is ${payout.status}; expected INITIATED`);
    }
    if (!payout.recentBlockhash || payout.lastValidBlockHeight === null) {
      throw new ConflictException("Payout is missing its blockhash validity metadata; rebuild it");
    }

    const tx = Transaction.from(Buffer.from(signedTransactionBase64, "base64"));
    if (tx.recentBlockhash !== payout.recentBlockhash) {
      throw new BadRequestException("Signed transaction blockhash does not match this payout");
    }
    const signatureBytes = tx.signatures[0]?.signature;
    if (!signatureBytes) throw new BadRequestException("Transaction is not signed");
    const signature = encodeBase58(Uint8Array.from(signatureBytes));
    const raw = tx.serialize();
    const currentBlockHeight = await this.connection.getBlockHeight("confirmed");
    if (isBlockhashExpired(currentBlockHeight, payout.lastValidBlockHeight)) {
      const expired = await this.prisma.payout.updateMany({
        where: { id: payoutId, status: "INITIATED" },
        data: { status: "FAILED", failedReason: "blockhash_expired_before_submit" },
      });
      if (expired.count > 0) {
        await this.prisma.workerAllocation.update({
          where: { id: payout.allocationId },
          data: { payoutStatus: "FAILED" },
        });
        throw new ConflictException(
          "Payout blockhash expired before submission; rebuild and sign again",
        );
      }
      const current = await this.prisma.payout.findUnique({ where: { id: payoutId } });
      if (current && ["SUBMITTED", "CONFIRMED", "FINALIZED"].includes(current.status)) {
        return current;
      }
      throw new ConflictException(`Payout is ${current?.status ?? "UNKNOWN"}; expected INITIATED`);
    }

    const claimed = await this.prisma.payout.updateMany({
      where: { id: payoutId, status: "INITIATED" },
      data: {
        status: "SUBMITTED",
        txSignature: signature,
        signedTransactionBase64: raw.toString("base64"),
        lastBroadcastAt: new Date(),
        broadcastAttempts: 1,
        submittedByUserId: submittedByUserId ?? payout.submittedByUserId,
      },
    });
    if (claimed.count === 0) {
      const current = await this.prisma.payout.findUnique({ where: { id: payoutId } });
      if (current && ["SUBMITTED", "CONFIRMED", "FINALIZED"].includes(current.status)) {
        return current;
      }
      throw new ConflictException(`Payout is ${current?.status ?? "UNKNOWN"}; expected INITIATED`);
    }
    const updated = await this.prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });

    // Broadcast with a hard timeout — a hanging public RPC must not hang the
    // HTTP request. On timeout the tx may still propagate; the confirmation
    // job / reconcile sweep resolves the true outcome either way.
    try {
      await Promise.race([
        this.connection.sendRawTransaction(raw, {
          skipPreflight: false,
          preflightCommitment: "confirmed",
          maxRetries: 0,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("rpc_send_timeout")), 15_000)),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Any send error is ambiguous: the RPC may have forwarded the bytes
      // before its response failed. Keep SUBMITTED and let the worker resend
      // the exact same transaction until blockhash expiry proves it cannot land.
      await this.prisma.payout.updateMany({
        where: { id: payoutId, status: "SUBMITTED" },
        data: { failedReason: `initial_broadcast:${message}`.slice(0, 500) },
      });
    }
    // Enqueue only after the initial send attempt. Enqueuing earlier lets the
    // worker rebroadcast concurrently and can turn the API's preflight result
    // into a misleading duplicate/already-processed failure.
    await this.confirmationQueue.add(
      "confirm",
      { payoutId, signature },
      { attempts: 100, backoff: { type: "fixed", delay: 2000 } },
    );
    return updated;
  }

  async getPayout(payoutId: string) {
    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
      include: {
        wallet: { select: { address: true } },
        worker: { include: { user: { select: { displayName: true } } } },
      },
    });
    if (!payout) throw new NotFoundException(`Payout ${payoutId} not found`);
    return { ...payout, amountBaseUnits: payout.amountBaseUnits.toString() };
  }

  /**
   * Spec §12.1 — legacy rails: cash/payroll/bank evidence registered manually.
   * The payout is venue-attested, so it finalizes immediately.
   */
  async registerLegacyEvidence(
    allocationId: string,
    input: {
      rail: "CASH_RETAINED" | "CASH_DRAWER" | "PAYROLL" | "PAYOUT_PROVIDER" | "BANK_REFERENCE";
      externalReference: string;
    },
    submittedByUserId?: string,
  ) {
    const allocation = await this.prisma.workerAllocation.findUnique({
      where: { id: allocationId },
      include: { batch: true },
    });
    if (!allocation) throw new NotFoundException(`Allocation ${allocationId} not found`);
    if (!allocation.workerId) {
      throw new BadRequestException(
        "This share is held for a worker who has not connected their account yet",
      );
    }
    if (allocation.payoutStatus === "PAID") {
      const finalized = await this.prisma.payout.findFirst({
        where: { allocationId: allocation.id, status: "FINALIZED" },
      });
      if (!finalized) throw new ConflictException("Allocation is already paid");
      await this.rebuildIncomeProjection(allocation.batch.venueId, submittedByUserId);
      return finalized;
    }
    if (!["PAYABLE", "PARTIALLY_PAID"].includes(allocation.batch.status)) {
      throw new BadRequestException(`Batch is ${allocation.batch.status}`);
    }

    const paymentId = allocation.id;
    const [payout] = await this.prisma.$transaction([
      this.prisma.payout.upsert({
        where: { paymentId },
        update: {
          rail: input.rail,
          externalReference: input.externalReference,
          status: "FINALIZED",
          settledAt: new Date(),
          submittedByUserId: submittedByUserId ?? null,
        },
        create: {
          paymentId,
          paymentIdHash: sha256Hex(paymentId),
          allocationId: allocation.id,
          workerId: allocation.workerId,
          venueId: allocation.batch.venueId,
          rail: input.rail,
          asset: "USD",
          amountUsdCents: allocation.netAllocatedUsdCents,
          externalReference: input.externalReference,
          status: "FINALIZED",
          settledAt: new Date(),
          initiatedByUserId: submittedByUserId ?? null,
          submittedByUserId: submittedByUserId ?? null,
        },
      }),
      this.prisma.workerAllocation.update({
        where: { id: allocation.id },
        data: { payoutRail: input.rail, payoutStatus: "PAID" },
      }),
    ]);
    await this.refreshBatchPaymentStatus(allocation.batchId);
    await this.rebuildIncomeProjection(allocation.batch.venueId, submittedByUserId);
    return payout;
  }

  private async rebuildIncomeProjection(venueId: string, actorUserId?: string) {
    const result = await rebuildVenueIncome(this.prisma, venueId, actorUserId, "SYSTEM");
    if (!result) {
      this.logger.warn(`income projection skipped; venue ${venueId} no longer exists`);
      return;
    }
    this.logger.log(
      `income projection refreshed after payout: venue=${venueId} entries=${result.entriesUpserted} alerts=${result.alerts}`,
    );
  }

  /** PARTIALLY_PAID / PAID rollup on the batch (spec §25). */
  async refreshBatchPaymentStatus(batchId: string) {
    const allocations = await this.prisma.workerAllocation.findMany({ where: { batchId } });
    const paid = allocations.filter((a) => a.payoutStatus === "PAID").length;
    const status = paid === 0 ? "PAYABLE" : paid === allocations.length ? "PAID" : "PARTIALLY_PAID";
    await this.prisma.allocationBatch.updateMany({
      where: { id: batchId, status: { in: ["PAYABLE", "PARTIALLY_PAID", "PAID"] } },
      data: { status },
    });
  }
}
