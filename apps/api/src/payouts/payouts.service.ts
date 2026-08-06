import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
} from "@nestjs/common";
import { centsToUsdcBaseUnits, QUEUES } from "@serveproof/shared";
import { buildSettlePayoutTx, fetchSettlementRecord, parsePubkey } from "@serveproof/solana";
import { Connection, Transaction } from "@solana/web3.js";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { PrismaService } from "../prisma/prisma.service";

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

@Injectable()
export class PayoutsService implements OnModuleDestroy {
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
  async createUsdcPayout(allocationId: string) {
    const allocation = await this.prisma.workerAllocation.findUnique({
      where: { id: allocationId },
      include: {
        batch: true,
        worker: { include: { defaultWallet: true } },
      },
    });
    if (!allocation) throw new NotFoundException(`Allocation ${allocationId} not found`);
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
      return existing; // idempotent create
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
  async buildTransaction(payoutId: string) {
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

    await this.prisma.payout.update({
      where: { id: payoutId },
      data: {
        status: "INITIATED",
        settlementPda: built.settlementPda,
        initiatedAt: new Date(),
        failedReason: null,
      },
    });

    return {
      payoutId,
      transactionBase64: built.transactionBase64,
      blockhash: built.blockhash,
      lastValidBlockHeight: built.lastValidBlockHeight,
      settlementPda: built.settlementPda,
      signer: venue.payoutSignerWallet,
    };
  }

  /** Spec §16.1 step 7–9 — submit the signed transaction and enqueue confirmation. */
  async submitSigned(payoutId: string, signedTransactionBase64: string) {
    const payout = await this.prisma.payout.findUnique({ where: { id: payoutId } });
    if (!payout) throw new NotFoundException(`Payout ${payoutId} not found`);
    if (payout.status !== "INITIATED") {
      throw new ConflictException(`Payout is ${payout.status}; expected INITIATED`);
    }

    const tx = Transaction.from(Buffer.from(signedTransactionBase64, "base64"));
    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 5,
    });

    const updated = await this.prisma.payout.update({
      where: { id: payoutId },
      data: { status: "SUBMITTED", txSignature: signature },
    });
    await this.confirmationQueue.add(
      "confirm",
      { payoutId, signature },
      { attempts: 10, backoff: { type: "exponential", delay: 3000 } },
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
  ) {
    const allocation = await this.prisma.workerAllocation.findUnique({
      where: { id: allocationId },
      include: { batch: true },
    });
    if (!allocation) throw new NotFoundException(`Allocation ${allocationId} not found`);
    if (!["PAYABLE", "PARTIALLY_PAID"].includes(allocation.batch.status)) {
      throw new BadRequestException(`Batch is ${allocation.batch.status}`);
    }
    if (allocation.payoutStatus === "PAID") {
      throw new ConflictException("Allocation is already paid");
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
        },
      }),
      this.prisma.workerAllocation.update({
        where: { id: allocation.id },
        data: { payoutRail: input.rail, payoutStatus: "PAID" },
      }),
    ]);
    await this.refreshBatchPaymentStatus(allocation.batchId);
    return payout;
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
