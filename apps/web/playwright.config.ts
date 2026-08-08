import { defineConfig } from "@playwright/test";

/**
 * §26 demo scenario E2E. Requires the local stack to be running:
 *   docker compose up -d && (api) node dist/main.js && (worker) node dist/main.js
 *   && (web) next start  — or scripts/demo-start.sh
 * The USDC on-chain segment talks to Solana Devnet; set PW_SKIP_ONCHAIN=1 to
 * stub it out when the network is unavailable.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 420_000,
  workers: 1,
  retries: 0,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.PW_WEB_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
});
