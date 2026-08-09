import { Controller, Get } from "@nestjs/common";
import { Connection } from "@solana/web3.js";
import IORedis from "ioredis";
import { Public } from "../auth/public.decorator";
import { PrismaService } from "../prisma/prisma.service";

const timeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)),
  ]);

/** Flatten an error's cause/AggregateError chain into diagnosable codes. */
function describeError(error: unknown): { message: string; causes: string[] } {
  const causes: string[] = [];
  const visit = (e: unknown, depth: number) => {
    if (!e || depth > 4) return;
    if (e instanceof AggregateError) {
      for (const inner of e.errors.slice(0, 4)) visit(inner, depth + 1);
      return;
    }
    if (e instanceof Error) {
      const code = (e as NodeJS.ErrnoException).code;
      const address = (e as NodeJS.ErrnoException & { address?: string }).address;
      causes.push([code, e.message, address].filter(Boolean).join(" "));
      visit(e.cause, depth + 1);
    }
  };
  if (error instanceof Error) visit(error.cause ?? error, 0);
  return { message: error instanceof Error ? error.message : String(error), causes };
}

/** Host+port of a URL with credentials stripped (safe to expose). */
function sanitizedTarget(raw: string | undefined): string {
  if (!raw) return "(unset)";
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.hostname}:${url.port || "(default)"}`;
  } catch {
    return `(unparseable: ${raw.slice(0, 12)}…)`;
  }
}

/**
 * Spec §29.11 — liveness plus per-dependency probes so a deployment can tell
 * WHICH dependency is broken (DB vs Redis vs RPC) instead of a blanket 500.
 */
@Public()
@Controller("health")
export class HealthController {
  // lazyConnect so a broken Redis never blocks app boot; each probe connects on demand
  private readonly redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  // "Connection is closed." masks the socket-level failure — keep the real one
  private lastRedisError: unknown = null;

  constructor(private readonly prisma: PrismaService) {
    this.redis.on("error", (error) => {
      this.lastRedisError = error;
    });
  }

  @Get()
  liveness() {
    return {
      status: "ok",
      service: "serveproof-api",
      appEnv: process.env.APP_ENV ?? "local",
      time: new Date().toISOString(),
    };
  }

  @Get("database")
  async database() {
    const started = Date.now();
    try {
      await timeout(this.prisma.$queryRaw`SELECT 1`, 5000);
      return { ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  @Get("redis")
  async redisHealth() {
    const started = Date.now();
    try {
      if (this.redis.status === "end" || this.redis.status === "close") {
        await this.redis.connect();
      }
      await timeout(this.redis.ping(), 5000);
      return {
        ok: true,
        latencyMs: Date.now() - started,
        target: sanitizedTarget(process.env.REDIS_URL),
      };
    } catch (error) {
      const described = describeError(error);
      if (this.lastRedisError) {
        described.causes.push(
          ...describeError(this.lastRedisError).causes.map((c) => `socket: ${c}`),
        );
      }
      return { ok: false, target: sanitizedTarget(process.env.REDIS_URL), ...described };
    }
  }

  @Get("solana")
  async solana() {
    const started = Date.now();
    try {
      const connection = new Connection(
        process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
        "confirmed",
      );
      const slot = await timeout(connection.getSlot(), 8000);
      return { ok: true, latencyMs: Date.now() - started, slot };
    } catch (error) {
      return {
        ok: false,
        target: sanitizedTarget(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com"),
        ...describeError(error),
      };
    }
  }
}
