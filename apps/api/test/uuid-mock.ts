import { randomUUID } from "node:crypto";

// rpc-websockets still requires uuid through CommonJS while uuid@14 is ESM-only.
// The Solana client only needs a unique request id in API integration tests.
export const v1 = () => randomUUID();
