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

  constructor(private readonly prisma: PrismaService) {}

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
        // scheme only — never the credentialed URL
        scheme: (process.env.REDIS_URL ?? "redis://localhost:6379").split("://")[0],
      };
    } catch (error) {
      return {
        ok: false,
        scheme: (process.env.REDIS_URL ?? "(unset)").split("://")[0],
        error: error instanceof Error ? error.message : String(error),
      };
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
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
