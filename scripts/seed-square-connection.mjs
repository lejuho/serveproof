// Seeds a CONNECTED Square ProviderConnection for the demo venue using the
// sandbox personal access token — the non-interactive stand-in for the OAuth
// browser flow (which stores the same shape via /providers/square/callback).
import { PrismaClient } from "../packages/db/dist/index.js";
import { encryptProviderToken } from "../packages/providers/dist/index.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const env = Object.fromEntries(
  readFileSync(join(import.meta.dirname, "..", ".env"), "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
);
process.env.DATABASE_URL = env.DATABASE_URL;

const secret = env.PROVIDER_ENCRYPTION_KEY ?? env.AUTH_SECRET;
const prisma = new PrismaClient();

const venue = await prisma.venue.findFirst({ where: { name: "Demo Diner" } });
if (!venue) throw new Error("Demo Diner not found — run seed first");

const LOCATION_ID = process.argv[2] ?? "LFX4B5NKDR9NT";

const connection = await prisma.providerConnection.upsert({
  where: { venueId_provider: { venueId: venue.id, provider: "square" } },
  update: {
    status: "CONNECTED",
    environment: env.SQUARE_ENVIRONMENT ?? "sandbox",
    locationId: LOCATION_ID,
    encryptedAccessToken: encryptProviderToken(env.SQUARE_ACCESS_TOKEN, secret),
    lastError: null,
    consecutiveFailures: 0,
  },
  create: {
    venueId: venue.id,
    provider: "square",
    environment: env.SQUARE_ENVIRONMENT ?? "sandbox",
    status: "CONNECTED",
    locationId: LOCATION_ID,
    encryptedAccessToken: encryptProviderToken(env.SQUARE_ACCESS_TOKEN, secret),
  },
});
await prisma.venue.update({
  where: { id: venue.id },
  data: { externalIds: { ...(venue.externalIds ?? {}), square: LOCATION_ID } },
});
console.log(`connection ${connection.id} → CONNECTED (venue ${venue.id}, location ${LOCATION_ID})`);
await prisma.$disconnect();
