import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { getAccount } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { deriveVenuePdas, getProgram } from "@serveproof/solana";
import { DEMO_CONFIG } from "../../../scripts/demo-config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

export function loadRootEnv() {
  const envPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const publicKey = (value) => new PublicKey(value);

export async function runDemoDoctor({ prisma: suppliedPrisma, strictWallets = true } = {}) {
  loadRootEnv();
  const ownPrisma = suppliedPrisma ? null : new PrismaClient();
  const prisma = suppliedPrisma ?? ownPrisma;
  const checks = [];
  const pass = (name, detail) => checks.push({ status: "PASS", name, detail });
  const fail = (name, detail) => checks.push({ status: "FAIL", name, detail });
  const warn = (name, detail) => checks.push({ status: "WARN", name, detail });

  try {
    const appEnv = process.env.APP_ENV ?? "local";
    if (!["local", "staging"].includes(appEnv)) {
      fail("environment", `APP_ENV=${appEnv} is not allowed for demo operations`);
    } else {
      pass("environment", appEnv);
    }

    const organization = await prisma.organization.findFirst({
      where: { legalName: DEMO_CONFIG.organizationLegalName },
    });
    if (!organization) {
      fail("organization", `${DEMO_CONFIG.organizationLegalName} is missing`);
    } else {
      pass("organization", `${organization.displayName} (${organization.id})`);
    }

    const venue = await prisma.venue.findUnique({
      where: { id: DEMO_CONFIG.venueId },
    });
    const conflictingVenue = organization
      ? await prisma.venue.findFirst({
          where: {
            organizationId: organization.id,
            name: DEMO_CONFIG.venueName,
            id: { not: DEMO_CONFIG.venueId },
          },
        })
      : null;
    if (conflictingVenue) {
      fail(
        "venue identity",
        `${DEMO_CONFIG.venueName} also exists as ${conflictingVenue.id}; expected only ${DEMO_CONFIG.venueId}`,
      );
    }
    if (!venue) {
      fail("venue identity", `${DEMO_CONFIG.venueId} is missing`);
    } else if (!organization || venue.organizationId !== organization.id) {
      fail("venue identity", "canonical venue belongs to the wrong organization");
    } else {
      pass("venue identity", `${venue.name} (${venue.id})`);
    }

    const manager = await prisma.user.findUnique({
      where: { email: DEMO_CONFIG.managerEmail },
      include: { memberships: true },
    });
    const owner = manager?.memberships.some(
      (membership) => membership.organizationId === organization?.id && membership.role === "OWNER",
    );
    if (!manager || !owner) fail("manager authority", `${DEMO_CONFIG.managerEmail} is not OWNER`);
    else pass("manager authority", `${manager.email} is OWNER`);

    const mappings = venue
      ? await prisma.externalWorkerAccount.findMany({
          where: {
            venueId: venue.id,
            externalWorkerId: { in: ["worker_001", "worker_002", "worker_003"] },
          },
          include: { worker: { include: { user: true, defaultWallet: true } } },
        })
      : [];
    if (mappings.length !== 3) fail("worker mappings", `expected 3, found ${mappings.length}`);
    else pass("worker mappings", "Alice, Bob, and Carol are mapped");

    for (const externalWorkerId of ["worker_001", "worker_002"]) {
      const mapping = mappings.find((item) => item.externalWorkerId === externalWorkerId);
      const wallet = mapping?.worker.defaultWallet;
      if (!wallet || wallet.status !== "ACTIVE") {
        const message = `${mapping?.worker.user.displayName ?? externalWorkerId} has no active default wallet`;
        if (strictWallets) fail("recipient wallet", message);
        else warn("recipient wallet", message);
      } else {
        try {
          publicKey(wallet.address);
          pass("recipient wallet", `${mapping.worker.user.displayName}: ${wallet.address}`);
        } catch {
          fail(
            "recipient wallet",
            `${mapping.worker.user.displayName} has an invalid Solana address`,
          );
        }
      }
    }

    if (venue) {
      const rpcUrl =
        process.env.DEMO_SOLANA_RPC_URL ??
        (appEnv === "staging"
          ? DEMO_CONFIG.devnet.rpcUrl
          : (process.env.SOLANA_RPC_URL ?? DEMO_CONFIG.devnet.rpcUrl));
      const connection = new Connection(rpcUrl, "confirmed");
      const programId = publicKey(DEMO_CONFIG.devnet.programId);
      const mint = publicKey(DEMO_CONFIG.devnet.usdcMint);
      const pdas = deriveVenuePdas(programId, venue.id, mint);
      const derived = {
        venue: pdas.venue.toBase58(),
        vaultAuthority: pdas.vaultAuthority.toBase58(),
        vault: pdas.venueVault.toBase58(),
      };
      if (
        derived.venue !== DEMO_CONFIG.devnet.venuePda ||
        derived.vaultAuthority !== DEMO_CONFIG.devnet.vaultAuthorityPda ||
        derived.vault !== DEMO_CONFIG.devnet.venueVault
      ) {
        fail("PDA derivation", JSON.stringify(derived));
      } else {
        pass("PDA derivation", `${derived.venue} → ${derived.vault}`);
      }

      const storedPdaMismatch =
        venue.solanaVenuePda !== null && venue.solanaVenuePda !== derived.venue;
      const storedVaultMismatch =
        venue.vaultTokenAccount !== null && venue.vaultTokenAccount !== derived.vault;
      if (
        storedPdaMismatch ||
        storedVaultMismatch ||
        venue.payoutSignerWallet !== DEMO_CONFIG.devnet.venueAuthority
      ) {
        fail(
          "database on-chain references",
          "stored venue PDA, vault, or signer conflicts with canonical demo config",
        );
      } else if (venue.solanaVenuePda === null || venue.vaultTokenAccount === null) {
        warn(
          "database on-chain references",
          "PDA/vault fields are empty; runtime derivation is valid and the next staging seed will persist them",
        );
      } else {
        pass("database on-chain references", "PDA, vault, and signer match");
      }

      try {
        const [venueInfo, signerLamports, vaultAccount] = await Promise.all([
          connection.getAccountInfo(pdas.venue, "confirmed"),
          connection.getBalance(publicKey(DEMO_CONFIG.devnet.venueAuthority), "confirmed"),
          getAccount(connection, pdas.venueVault, "confirmed"),
        ]);
        if (!venueInfo) fail("on-chain venue", `${derived.venue} does not exist`);
        else if (!venueInfo.owner.equals(programId))
          fail("on-chain venue", "account owner is not ServeProof");
        else {
          const program = getProgram(connection);
          const onchainVenue = await program.account.venue.fetch(pdas.venue);
          const authority = onchainVenue.venueAuthority.toBase58();
          if (authority !== DEMO_CONFIG.devnet.venueAuthority) {
            fail("on-chain venue", `authority mismatch: ${authority}`);
          } else {
            pass("on-chain venue", `${derived.venue} owned by ServeProof`);
          }
        }
        if (!vaultAccount.mint.equals(mint) || !vaultAccount.owner.equals(pdas.vaultAuthority)) {
          fail("vault account", "mint or owner does not match canonical PDA derivation");
        } else if (vaultAccount.amount < DEMO_CONFIG.devnet.minimumVaultBaseUnits) {
          fail("vault account", `${Number(vaultAccount.amount) / 1e6} tUSDC is below 60 tUSDC`);
        } else {
          pass("vault account", `${Number(vaultAccount.amount) / 1e6} tUSDC`);
        }
        if (signerLamports < DEMO_CONFIG.devnet.minimumSignerLamports) {
          fail("signer SOL", `${signerLamports / 1e9} SOL is below 0.05 SOL`);
        } else {
          pass("signer SOL", `${signerLamports / 1e9} SOL`);
        }
      } catch (error) {
        fail("Solana RPC", error instanceof Error ? error.message : String(error));
      }
    }

    for (const check of checks) {
      console.log(`${check.status.padEnd(4)} ${check.name}: ${check.detail}`);
    }
    const failures = checks.filter((check) => check.status === "FAIL");
    console.log(
      `Demo readiness: ${failures.length === 0 ? "READY" : `BLOCKED (${failures.length})`}`,
    );
    if (failures.length) throw new Error("Demo readiness checks failed");
    return checks;
  } finally {
    if (ownPrisma) await ownPrisma.$disconnect();
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  runDemoDoctor().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
