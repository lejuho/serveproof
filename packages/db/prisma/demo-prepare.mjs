import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { rebuildVenueIncome } from "../dist/income-projector.js";
import { generateDemoCsv } from "../../../scripts/generate-demo-csv.mjs";
import { DEMO_CONFIG } from "../../../scripts/demo-config.mjs";
import { loadRootEnv, runDemoDoctor } from "./demo-doctor.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const artifactDir = path.join(repoRoot, "demo-artifacts");

loadRootEnv();
const prisma = new PrismaClient();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const ymd = (date) => date.toISOString().slice(0, 10);

function parseCsv(csv) {
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  const keys = header.split(",");
  return lines.map((line) =>
    Object.fromEntries(keys.map((key, index) => [key, line.split(",")[index]])),
  );
}

function allocate(pool, recipients) {
  const weights = { SERVER: 1, BUSSER: 0.7, BARTENDER: 1 };
  const scored = recipients.map((recipient) => ({
    ...recipient,
    score: recipient.workedMinutes * (weights[recipient.role] ?? 1),
  }));
  const totalScore = scored.reduce((sum, recipient) => sum + recipient.score, 0);
  const raw = scored.map((recipient) => {
    const exact = (pool * recipient.score) / totalScore;
    return { ...recipient, amount: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let left = pool - raw.reduce((sum, recipient) => sum + recipient.amount, 0);
  for (const recipient of [...raw].sort(
    (a, b) => b.remainder - a.remainder || a.workerId.localeCompare(b.workerId),
  )) {
    if (left-- <= 0) break;
    recipient.amount += 1;
  }
  return raw;
}

async function context() {
  const organization = await prisma.organization.findFirst({
    where: { legalName: DEMO_CONFIG.organizationLegalName },
  });
  if (!organization)
    throw new Error("Demo organization missing. Run pnpm --filter @serveproof/db seed first.");
  const venue = await prisma.venue.findUnique({ where: { id: DEMO_CONFIG.venueId } });
  if (!venue) throw new Error("Demo Diner missing. Run the demo seed first.");
  if (venue.organizationId !== organization.id || venue.name !== DEMO_CONFIG.venueName) {
    throw new Error("Canonical Demo Diner identity does not match the demo organization.");
  }
  const manager = await prisma.user.findUnique({ where: { authUserId: "demo-manager" } });
  if (!manager) throw new Error("Demo manager missing. Run the demo seed first.");
  const policy = await prisma.allocationPolicy.findFirst({
    where: { venueId: venue.id, status: "ACTIVE" },
    orderBy: { version: "desc" },
  });
  if (!policy) throw new Error("Active demo allocation policy missing.");
  const mappings = await prisma.externalWorkerAccount.findMany({
    where: {
      venueId: venue.id,
      externalWorkerId: { in: ["worker_001", "worker_002", "worker_003"] },
    },
    include: { worker: { include: { user: true } } },
  });
  if (mappings.length !== 3)
    throw new Error("Expected worker_001, worker_002, and worker_003 mappings.");
  return { organization, venue, manager, policy, mappings };
}

async function counts(venueId, workerIds) {
  const grants = await prisma.disclosureGrant.findMany({
    where: { workerId: { in: workerIds } },
    select: { id: true },
  });
  return {
    tips: await prisma.tipEvidence.count({ where: { venueId } }),
    shifts: await prisma.shiftEvidence.count({ where: { venueId } }),
    batches: await prisma.allocationBatch.count({ where: { venueId } }),
    payouts: await prisma.payout.count({ where: { venueId } }),
    payrollRecords: await prisma.payrollRecord.count({ where: { venueId } }),
    incomeEntries: await prisma.incomeEntry.count({ where: { venueId } }),
    proofs: await prisma.verificationReport.count({
      where: { disclosureGrantId: { in: grants.map((grant) => grant.id) } },
    }),
  };
}

async function archiveOnchain(venueId) {
  const payouts = await prisma.payout.findMany({
    where: { venueId, rail: "USDC", txSignature: { not: null } },
    orderBy: { createdAt: "desc" },
    select: {
      txSignature: true,
      status: true,
      amountUsdCents: true,
      settledAt: true,
      createdAt: true,
    },
  });
  fs.mkdirSync(artifactDir, { recursive: true });
  const archivePath = path.join(
    artifactDir,
    `previous-onchain-${new Date().toISOString().replaceAll(":", "-")}.json`,
  );
  fs.writeFileSync(
    archivePath,
    JSON.stringify(
      payouts.map((payout) => ({
        ...payout,
        solscanUrl: `https://solscan.io/tx/${payout.txSignature}?cluster=devnet`,
      })),
      null,
      2,
    ) + "\n",
  );
  return { archivePath, count: payouts.length };
}

async function resetDemoData({ organization, venue, mappings }) {
  const workerIds = mappings.map((mapping) => mapping.workerId);
  const grants = await prisma.disclosureGrant.findMany({
    where: { workerId: { in: workerIds } },
    select: { id: true },
  });
  const grantIds = grants.map((grant) => grant.id);
  const openShifts = await prisma.openShift.findMany({
    where: { venueId: venue.id },
    select: { id: true },
  });
  const openShiftIds = openShifts.map((shift) => shift.id);

  await prisma.$transaction(
    async (tx) => {
      if (grantIds.length) {
        await tx.verificationReport.updateMany({
          where: { disclosureGrantId: { in: grantIds } },
          data: { previousReportId: null },
        });
        await tx.verificationReport.deleteMany({ where: { disclosureGrantId: { in: grantIds } } });
        await tx.disclosureAccessLog.deleteMany({ where: { grantId: { in: grantIds } } });
        await tx.disclosureGrant.deleteMany({ where: { id: { in: grantIds } } });
      }
      await tx.discrepancyAlert.deleteMany({ where: { venueId: venue.id } });
      await tx.incomeEntry.updateMany({
        where: { venueId: venue.id },
        data: { correctionOfId: null },
      });
      await tx.incomeEntry.deleteMany({ where: { venueId: venue.id } });
      await tx.payrollRecord.deleteMany({ where: { venueId: venue.id } });
      await tx.payout.deleteMany({ where: { venueId: venue.id } });
      await tx.workerAllocation.deleteMany({ where: { batch: { venueId: venue.id } } });
      await tx.allocationBatch.deleteMany({ where: { venueId: venue.id } });
      if (openShiftIds.length) {
        await tx.shiftAssignment.deleteMany({ where: { openShiftId: { in: openShiftIds } } });
        await tx.openShift.deleteMany({ where: { id: { in: openShiftIds } } });
      }
      await tx.shiftEvidence.deleteMany({ where: { venueId: venue.id } });
      await tx.tipEvidence.deleteMany({ where: { venueId: venue.id } });
      await tx.auditLog.deleteMany({
        where: { OR: [{ venueId: venue.id }, { organizationId: organization.id }] },
      });
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
}

async function seedHistory({ venue, manager, policy, mappings }, historyCsv) {
  const rows = parseCsv(historyCsv);
  const mappingByExternal = new Map(mappings.map((mapping) => [mapping.externalWorkerId, mapping]));
  const byDate = new Map();

  await prisma.$transaction(
    async (tx) => {
      for (const mapping of mappings) {
        const names = { worker_001: "Alice", worker_002: "Bob", worker_003: "Carol" };
        await tx.user.update({
          where: { id: mapping.worker.user.id },
          data: { displayName: names[mapping.externalWorkerId] },
        });
        await tx.externalWorkerAccount.update({
          where: { id: mapping.id },
          data: { mappingStatus: "CONFIRMED", verifiedBy: manager.id, verifiedAt: new Date() },
        });
      }

      for (const row of rows) {
        const mapping = mappingByExternal.get(row.worker_external_id);
        if (!mapping) throw new Error(`No mapping for ${row.worker_external_id}`);
        const clockIn = new Date(row.clock_in);
        const clockOut = new Date(row.clock_out);
        const businessDate = row.clock_in.slice(0, 10);
        const workedMinutes = Math.round((clockOut.getTime() - clockIn.getTime()) / 60_000);
        const amount = Math.round(Number(row.gross_tip) * 100);
        const sourceHash = sha256(JSON.stringify(row));
        const shift = await tx.shiftEvidence.create({
          data: {
            provider: row.provider,
            ingestSource: "CSV_UPLOAD",
            venueId: venue.id,
            externalShiftId: row.shift_external_id,
            externalWorkerId: row.worker_external_id,
            mappedWorkerId: mapping.workerId,
            role: row.role,
            clockIn,
            clockOut,
            workedMinutes,
            shiftStatus: "COMPLETED",
            businessDate,
            sourceHash,
            sourcePayoutRail: "PAYROLL",
            sourcePayrollStatus: "PROVIDER_CONFIRMED",
          },
        });
        await tx.tipEvidence.create({
          data: {
            provider: row.provider,
            ingestSource: "CSV_UPLOAD",
            venueId: venue.id,
            externalPaymentId: `csv:${row.shift_external_id}`,
            tipType: "CARD_TIP",
            grossAmountUsdCents: amount,
            businessDate,
            sourceHash,
            sourcePayoutRail: "PAYROLL",
            sourcePayrollStatus: "PROVIDER_CONFIRMED",
          },
        });
        byDate.set(businessDate, [
          ...(byDate.get(businessDate) ?? []),
          {
            workerId: mapping.workerId,
            externalWorkerId: row.worker_external_id,
            role: row.role,
            workedMinutes,
            shiftId: shift.id,
            tip: amount,
            sourceHash,
          },
        ]);
      }

      let aliceOldestAllocation = null;
      const dates = [...byDate.keys()].sort();
      for (const businessDate of dates) {
        const recipients = byDate.get(businessDate);
        const pool = recipients.reduce((sum, recipient) => sum + recipient.tip, 0);
        const allocations = allocate(pool, recipients);
        const evidenceHash = sha256(
          JSON.stringify(recipients.map((recipient) => recipient.sourceHash).sort()),
        );
        const allocationHash = sha256(
          JSON.stringify(allocations.map((recipient) => [recipient.workerId, recipient.amount])),
        );
        const batch = await tx.allocationBatch.create({
          data: {
            venueId: venue.id,
            businessDate,
            tipPoolAmountUsdCents: pool,
            policyId: policy.id,
            policyVersion: policy.version,
            status: "PAID",
            evidenceHash,
            allocationHash,
            reviewIssues: [],
            calculatedAt: new Date(),
            calculatedBy: manager.id,
            approvedAt: new Date(),
            approvedBy: manager.id,
          },
        });
        for (const allocation of allocations) {
          const saved = await tx.workerAllocation.create({
            data: {
              batchId: batch.id,
              workerId: allocation.workerId,
              pooledTipUsdCents: allocation.amount,
              netAllocatedUsdCents: allocation.amount,
              plannedPayoutRail: "PAYROLL",
              payoutRail: "PAYROLL",
              payoutStatus: "PAID",
            },
          });
          await tx.payout.create({
            data: {
              paymentId: saved.id,
              paymentIdHash: sha256(saved.id),
              allocationId: saved.id,
              workerId: allocation.workerId,
              venueId: venue.id,
              rail: "PAYROLL",
              asset: "USD",
              amountUsdCents: allocation.amount,
              status: "FINALIZED",
              externalReference: `DEMO-HISTORY-${businessDate}-${allocation.externalWorkerId}`,
              initiatedByUserId: manager.id,
              submittedByUserId: manager.id,
              settledAt: new Date(),
            },
          });
          if (businessDate === dates[0] && allocation.externalWorkerId === "worker_001") {
            aliceOldestAllocation = { businessDate, amount: allocation.amount };
          }
        }
      }

      if (!aliceOldestAllocation) throw new Error("Could not create Alice payroll fixture.");
      const alice = mappingByExternal.get("worker_001");
      await tx.payrollRecord.create({
        data: {
          workerId: alice.workerId,
          venueId: venue.id,
          periodStart: new Date(`${aliceOldestAllocation.businessDate}T00:00:00Z`),
          periodEnd: new Date(`${aliceOldestAllocation.businessDate}T23:59:59Z`),
          reportedTipUsdCents: aliceOldestAllocation.amount,
          federalWithholdingUsdCents: Math.max(1, Math.round(aliceOldestAllocation.amount * 0.1)),
          status: "PROVIDER_CONFIRMED",
          providerReference: `DEMO-PAYROLL-${aliceOldestAllocation.businessDate}-ALICE`,
        },
      });
    },
    { maxWait: 10_000, timeout: 60_000 },
  );

  await rebuildVenueIncome(prisma, venue.id, manager.id, "SYSTEM");
}

async function main() {
  const appEnv = process.env.APP_ENV ?? "local";
  if (!["local", "staging"].includes(appEnv)) {
    throw new Error(`Refusing demo preparation in APP_ENV=${appEnv}`);
  }
  const ctx = await context();
  await runDemoDoctor({ prisma });
  const workerIds = ctx.mappings.map((mapping) => mapping.workerId);
  const before = await counts(ctx.venue.id, workerIds);
  const apply = process.env.DEMO_PREPARE_APPLY === "1";
  const confirmed = process.env.DEMO_PREPARE_CONFIRM === ctx.venue.name;

  console.log(`Target: ${ctx.organization.displayName} / ${ctx.venue.name} (${appEnv})`);
  console.log("Current operational rows:", before);
  if (!apply || !confirmed) {
    console.log("Dry run only. To apply:");
    console.log(`DEMO_PREPARE_APPLY=1 DEMO_PREPARE_CONFIRM='${ctx.venue.name}' pnpm demo:prepare`);
    return;
  }

  const archive = await archiveOnchain(ctx.venue.id);
  await resetDemoData(ctx);

  const liveDate = ymd(new Date(Date.now() - 86_400_000));
  const historyEnd = ymd(new Date(Date.now() - 2 * 86_400_000));
  const history = generateDemoCsv({
    days: 4,
    endDate: historyEnd,
    seed: "pitch-history-v1",
    profile: "history",
  });
  const live = generateDemoCsv({
    days: 1,
    endDate: liveDate,
    seed: "pitch-live-v1",
    profile: "live",
  });
  const held = generateDemoCsv({
    days: 1,
    endDate: liveDate,
    seed: "pitch-held-v1",
    profile: "live",
    unmapped: true,
  });

  await seedHistory(ctx, history.csv);
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "demo-history.csv"), history.csv);
  fs.writeFileSync(path.join(artifactDir, "demo-live.csv"), live.csv);
  fs.writeFileSync(path.join(artifactDir, "demo-held-optional.csv"), held.csv);

  const after = await counts(ctx.venue.id, workerIds);
  const alice = ctx.mappings.find((mapping) => mapping.externalWorkerId === "worker_001");
  const aliceAGrades = await prisma.incomeEntry.count({
    where: {
      workerId: alice.workerId,
      venueId: ctx.venue.id,
      evidenceGrade: "A",
      effectiveStatus: "ACTIVE",
    },
  });
  const liveRows = await prisma.shiftEvidence.count({
    where: { venueId: ctx.venue.id, businessDate: liveDate },
  });

  console.log("Prepared operational rows:", after);
  console.log(`Alice grade-A rows: ${aliceAGrades}`);
  console.log(`Live date ${liveDate} imported rows: ${liveRows} (expected 0)`);
  console.log(`Live CSV: ${path.join(artifactDir, "demo-live.csv")}`);
  console.log(`Optional held-share CSV: ${path.join(artifactDir, "demo-held-optional.csv")}`);
  console.log(`Archived ${archive.count} previous on-chain signature(s): ${archive.archivePath}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
