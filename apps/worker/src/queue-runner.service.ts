import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { QUEUES, type QueueName } from "@serveproof/shared";
import { PrismaService } from "./prisma.service";
import { SolanaSettlementService } from "./solana-settlement.service";
import { SquareSyncService, type ProviderSyncJob } from "./square-sync.service";

/**
 * Registers a BullMQ worker per queue (spec §29.5). Queues without a real
 * processor yet fall back to a logging stub.
 */
@Injectable()
export class QueueRunnerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(QueueRunnerService.name);
  private workers: Worker[] = [];
  private reconcileQueue: Queue | null = null;
  private expireQueue: Queue | null = null;
  private providerSyncQueue: Queue | null = null;

  constructor(
    private readonly solana: SolanaSettlementService,
    private readonly prisma: PrismaService,
    private readonly square: SquareSyncService,
  ) {}

  /** Spec §29.5 disclosure-expire — mark overdue ISSUED reports EXPIRED. */
  private async expireOverdueReports() {
    const result = await this.prisma.verificationReport.updateMany({
      where: { status: "ISSUED", expiresAt: { lt: new Date() } },
      data: { status: "EXPIRED" },
    });
    if (result.count > 0) this.logger.log(`expired ${result.count} report(s)`);
  }

  async onModuleInit() {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      this.logger.warn("REDIS_URL not set — queue consumers disabled");
      return;
    }
    const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

    const processors: Partial<Record<QueueName, (data: never) => Promise<unknown>>> = {
      [QUEUES.providerSync]: (data: (ProviderSyncJob & { staleCheck?: boolean }) | undefined) =>
        data?.staleCheck
          ? this.square.flagStaleConnections()
          : data?.venueId
            ? this.square.sync(data)
            : this.square.syncConnectedVenues(),
      [QUEUES.solanaConfirmation]: (data: { payoutId: string; signature: string }) =>
        this.solana.processConfirmation(data),
      [QUEUES.payoutReconcile]: () => this.solana.reconcileStalePayouts(),
      [QUEUES.disclosureExpire]: () => this.expireOverdueReports(),
    };

    for (const queueName of Object.values(QUEUES) as QueueName[]) {
      const processor = processors[queueName];
      const worker = new Worker(
        queueName,
        async (job) => {
          if (processor) return processor(job.data as never);
          this.logger.log(`[${queueName}] received job ${job.id} (no processor yet)`);
        },
        { connection },
      );
      worker.on("failed", (job, err) => {
        this.logger.warn(`[${queueName}] job ${job?.id} attempt failed: ${err.message}`);
      });
      this.workers.push(worker);
    }

    // §29.5 — periodic sweeps
    this.reconcileQueue = new Queue(QUEUES.payoutReconcile, { connection });
    await this.reconcileQueue.upsertJobScheduler("reconcile-every-60s", { every: 60_000 });
    this.expireQueue = new Queue(QUEUES.disclosureExpire, { connection });
    await this.expireQueue.upsertJobScheduler("disclosure-expire-every-5m", { every: 300_000 });
    this.providerSyncQueue = new Queue(QUEUES.providerSync, { connection });
    await this.providerSyncQueue.upsertJobScheduler(
      "square-sync-every-15m",
      { every: 900_000 },
      {
        name: "scheduled-sync",
        data: {},
        opts: { attempts: 6, backoff: { type: "exponential", delay: 5_000 } },
      },
    );
    await this.providerSyncQueue.upsertJobScheduler(
      "square-stale-check-hourly",
      { every: 3_600_000 },
      {
        name: "stale-check",
        data: { staleCheck: true },
      },
    );

    this.logger.log(`Listening on ${this.workers.length} queues`);
  }

  async onApplicationShutdown() {
    await Promise.allSettled([
      ...this.workers.map((w) => w.close()),
      this.reconcileQueue?.close(),
      this.expireQueue?.close(),
      this.providerSyncQueue?.close(),
    ]);
  }
}
