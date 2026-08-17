import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient, type Prisma } from "@serveproof/db";
import { requestPerformance } from "../common/performance-context";

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function queryIdentity(query: string): { operation: string; table: string } {
  const operation = query.trimStart().split(/\s+/, 1)[0]?.toUpperCase() ?? "UNKNOWN";
  const tableMatch = query.match(
    /(?:FROM|UPDATE|INTO|JOIN)\s+(?:"[^"]+"\.)?"?([A-Za-z][A-Za-z0-9_]*)"?/i,
  );
  return { operation, table: tableMatch?.[1] ?? "unknown" };
}

type ObservedPrismaClientOptions = Prisma.PrismaClientOptions & {
  log: [{ emit: "event"; level: "query" }];
};

@Injectable()
export class PrismaService
  extends PrismaClient<ObservedPrismaClientOptions>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger("DatabasePerformance");
  private readonly slowQueryMs = positiveNumber(process.env.PRISMA_SLOW_QUERY_MS, 200);
  private readonly queryTimingEnabled: boolean;

  constructor() {
    const queryTimingEnabled = process.env.PERFORMANCE_LOGGING_ENABLED !== "false";
    super({
      log: queryTimingEnabled ? [{ emit: "event", level: "query" }] : [],
    } as ObservedPrismaClientOptions);
    this.queryTimingEnabled = queryTimingEnabled;
    if (!queryTimingEnabled) return;
    this.$on("query", (event: Prisma.QueryEvent) => {
      requestPerformance.recordQuery(event.duration, this.slowQueryMs);
      if (event.duration < this.slowQueryMs) return;
      const identity = queryIdentity(event.query);
      this.logger.warn(
        JSON.stringify({
          event: "slow_db_query",
          durationMs: event.duration,
          operation: identity.operation,
          table: identity.table,
        }),
      );
    });
  }

  async onModuleInit() {
    await this.$connect();
    let connectionLimit = "driver-default";
    let poolTimeout = "driver-default";
    try {
      const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
      connectionLimit = databaseUrl.searchParams.get("connection_limit") ?? connectionLimit;
      poolTimeout = databaseUrl.searchParams.get("pool_timeout") ?? poolTimeout;
    } catch {
      // Never log the database URL itself; malformed/missing URLs fail in Prisma.
    }
    this.logger.log(
      JSON.stringify({
        event: "db_observability_ready",
        queryTimingEnabled: this.queryTimingEnabled,
        slowQueryMs: this.slowQueryMs,
        connectionLimit,
        poolTimeout,
      }),
    );
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
