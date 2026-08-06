import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/public.decorator";

/**
 * Spec §29.11 — health endpoints. Phase 0 provides the liveness route;
 * database/redis/solana/provider probes are wired in as each dependency lands.
 */
@Public()
@Controller("health")
export class HealthController {
  @Get()
  liveness() {
    return {
      status: "ok",
      service: "serveproof-api",
      appEnv: process.env.APP_ENV ?? "local",
      time: new Date().toISOString(),
    };
  }
}
