// Demo seed — spec §29.6 (staging seed) / §26 (demo scenario).
// Idempotent: re-running updates in place instead of duplicating.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function upsertUser(authUserId, email, displayName, role) {
  // A fresh staging DB may receive an OTP login before the demo seed runs.
  // Auth creates that address as `otp:<email>`/WORKER, so reconcile by email
  // as well as authUserId instead of failing the unique email constraint.
  const byAuthUserId = await prisma.user.findUnique({ where: { authUserId } });
  if (byAuthUserId) {
    return prisma.user.update({
      where: { id: byAuthUserId.id },
      data: { email, displayName, role },
    });
  }

  const byEmail = await prisma.user.findUnique({ where: { email } });
  if (byEmail) {
    return prisma.user.update({
      where: { id: byEmail.id },
      data: { authUserId, displayName, role },
    });
  }

  return prisma.user.create({ data: { authUserId, email, displayName, role } });
}

async function main() {
  // ── Venue manager + organization ──────────────────────────────
  const manager = await upsertUser(
    "demo-manager",
    "manager@demo.serveproof.local",
    "Demo Manager",
    "VENUE_MANAGER",
  );
  await prisma.worker.upsert({
    where: { userId: manager.id },
    update: {},
    create: { userId: manager.id },
  });

  let org = await prisma.organization.findFirst({
    where: { legalName: "ServeProof Demo LLC" },
  });
  if (!org) {
    org = await prisma.organization.create({
      data: {
        legalName: "ServeProof Demo LLC",
        displayName: "ServeProof Demo",
        country: "US",
        timezone: "America/New_York",
      },
    });
  }

  await prisma.organizationMember.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId: manager.id } },
    update: { role: "OWNER" },
    create: { organizationId: org.id, userId: manager.id, role: "OWNER" },
  });

  let venue = await prisma.venue.findFirst({
    where: { organizationId: org.id, name: "Demo Diner" },
  });
  if (!venue) {
    venue = await prisma.venue.create({
      data: {
        organizationId: org.id,
        name: "Demo Diner",
        timezone: "America/New_York",
        externalIds: { csv: "venue_001", toast_mock: "venue_001" },
      },
    });
  }

  // ── Workers (§26: A=payroll route, B=USDC route, C=unmapped at start) ──
  const workerSpecs = [
    {
      authUserId: "demo-worker-a",
      email: "worker.a@demo.serveproof.local",
      name: "Worker A",
      externalWorkerId: "worker_001",
      mappingStatus: "CONFIRMED",
    },
    {
      authUserId: "demo-worker-b",
      email: "worker.b@demo.serveproof.local",
      name: "Worker B",
      externalWorkerId: "worker_002",
      mappingStatus: "CONFIRMED",
    },
    {
      authUserId: "demo-worker-c",
      email: "worker.c@demo.serveproof.local",
      name: "Worker C",
      externalWorkerId: "worker_003",
      mappingStatus: "PENDING", // §26 step 5 — worker accepts the venue connection request
    },
  ];

  for (const spec of workerSpecs) {
    const user = await upsertUser(spec.authUserId, spec.email, spec.name, "WORKER");
    const worker = await prisma.worker.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id },
    });
    await prisma.externalWorkerAccount.upsert({
      where: {
        venueId_provider_externalWorkerId: {
          venueId: venue.id,
          provider: "toast_mock",
          externalWorkerId: spec.externalWorkerId,
        },
      },
      update: { mappingStatus: spec.mappingStatus },
      create: {
        workerId: worker.id,
        venueId: venue.id,
        provider: "toast_mock",
        externalWorkerId: spec.externalWorkerId,
        mappingStatus: spec.mappingStatus,
        verifiedBy: spec.mappingStatus === "CONFIRMED" ? manager.id : null,
        verifiedAt: spec.mappingStatus === "CONFIRMED" ? new Date() : null,
      },
    });
  }

  // ── Allocation policy v1 (§10) ────────────────────────────────
  await prisma.allocationPolicy.upsert({
    where: { venueId_version: { venueId: venue.id, version: 1 } },
    update: {},
    create: {
      venueId: venue.id,
      version: 1,
      status: "ACTIVE",
      allocationType: "ROLE_WEIGHTED_HOURS",
      roleWeights: { SERVER: 1.0, BUSSER: 0.7, BARTENDER: 1.0 },
      poolInclusion: {
        CARD_TIP: true,
        QR_TIP: true,
        CASH_TIP: false,
        AUTOMATIC_GRATUITY: false,
        SERVICE_CHARGE: false,
      },
      excludedRoles: ["MANAGER", "SUPERVISOR"],
      tipOutRules: [],
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      createdBy: manager.id,
    },
  });

  const counts = {
    users: await prisma.user.count(),
    organizations: await prisma.organization.count(),
    venues: await prisma.venue.count(),
    workers: await prisma.worker.count(),
    externalWorkerAccounts: await prisma.externalWorkerAccount.count(),
    allocationPolicies: await prisma.allocationPolicy.count(),
  };
  console.log("Seed complete:", counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
