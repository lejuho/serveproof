import type { INestApplication } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AllocationsModule } from "../src/allocations/allocations.module";
import { AuthModule } from "../src/auth/auth.module";
import { EvidenceModule } from "../src/evidence/evidence.module";
import { HealthModule } from "../src/health/health.module";
import { MappingsModule } from "../src/mappings/mappings.module";
import { OrganizationsModule } from "../src/organizations/organizations.module";
import { PoliciesModule } from "../src/policies/policies.module";
import { PrismaModule } from "../src/prisma/prisma.module";
import { ProvidersModule } from "../src/providers/providers.module";
import { WorkersModule } from "../src/workers/workers.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
    PrismaModule,
    AuthModule,
    HealthModule,
    OrganizationsModule,
    PoliciesModule,
    WorkersModule,
    EvidenceModule,
    MappingsModule,
    AllocationsModule,
    ProvidersModule,
  ],
})
class IntegrationTestModule {}

interface Session {
  accessToken: string;
  refreshToken: string;
  userId: string;
}

describe("ServeProof API integration", () => {
  let app: INestApplication;
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const api = () => request(app.getHttpServer());
  const bearer = (session: Session) => ({ Authorization: `Bearer ${session.accessToken}` });

  async function login(label: string): Promise<Session> {
    const email = `${label}-${runId}@example.test`;
    const requested = await api().post("/auth/otp/request").send({ email }).expect(201);
    expect(requested.body).toMatchObject({ sent: true });
    expect(requested.body.devCode).toMatch(/^\d{6}$/);

    const verified = await api()
      .post("/auth/otp/verify")
      .send({ email, code: requested.body.devCode })
      .expect(201);
    expect(verified.body.accessToken).toEqual(expect.any(String));
    expect(verified.body.refreshToken).toEqual(expect.any(String));
    return verified.body as Session;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [IntegrationTestModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("keeps health public while protecting authenticated routes", async () => {
    await api()
      .get("/health")
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ status: "ok", service: "serveproof-api", appEnv: "local" });
      });
    await api().get("/organizations/mine").expect(401);
    await api().get("/organizations/mine").set("Authorization", "Bearer forged-token").expect(401);
  });

  it("rotates refresh tokens and rejects reuse", async () => {
    const session = await login("refresh");
    const rotated = await api()
      .post("/auth/refresh")
      .send({ refreshToken: session.refreshToken })
      .expect(201);

    expect(rotated.body.accessToken).toEqual(expect.any(String));
    expect(rotated.body.refreshToken).not.toBe(session.refreshToken);
    await api().post("/auth/refresh").send({ refreshToken: session.refreshToken }).expect(401);
  });

  it("enforces RBAC, tenant isolation, and allocation state transitions", async () => {
    const [owner, manager, viewer, outsider, worker] = await Promise.all([
      login("owner"),
      login("manager"),
      login("viewer"),
      login("outsider"),
      login("worker"),
    ]);

    const organization = await api()
      .post("/organizations")
      .set(bearer(owner))
      .send({
        legalName: `ServeProof Test ${runId}`,
        displayName: "ServeProof Integration",
        country: "US",
        timezone: "UTC",
      })
      .expect(201);

    const organizationId = organization.body.id as string;
    const memberEmails = [
      { label: "manager", role: "MANAGER" },
      { label: "viewer", role: "VIEWER" },
    ] as const;
    for (const member of memberEmails) {
      await api()
        .post(`/organizations/${organizationId}/members`)
        .set(bearer(owner))
        .send({ email: `${member.label}-${runId}@example.test`, role: member.role })
        .expect(201);
    }

    const venue = await api()
      .post("/venues")
      .set(bearer(owner))
      .send({ organizationId, name: "Integration Venue", timezone: "UTC" })
      .expect(201);
    const venueId = venue.body.id as string;

    await api().get(`/venues/${venueId}`).set(bearer(viewer)).expect(200);
    await api().get(`/venues/${venueId}`).set(bearer(outsider)).expect(403);
    await api()
      .post(`/venues/${venueId}/wallet`)
      .set(bearer(viewer))
      .send({ payoutSignerWallet: "11111111111111111111111111111111" })
      .expect(403);
    await api()
      .post(`/venues/${venueId}/wallet`)
      .set(bearer(manager))
      .send({ payoutSignerWallet: "11111111111111111111111111111111" })
      .expect(201);

    await api().post("/providers/square/connect").set(bearer(viewer)).send({ venueId }).expect(403);
    await api()
      .post("/providers/square/connect")
      .set(bearer(manager))
      .send({ venueId })
      .expect(201)
      .expect(({ body }) => {
        const authorizationUrl = new URL(body.authorizationUrl);
        expect(authorizationUrl.origin).toBe("https://connect.squareupsandbox.com");
        expect(authorizationUrl.searchParams.get("state")).toEqual(expect.any(String));
        expect(authorizationUrl.searchParams.get("scope")).toContain("TIMECARDS_READ");
      });

    const workerProfile = await api().get("/workers/me").set(bearer(worker)).expect(200);
    const workerId = workerProfile.body.id as string;
    const csvText = [
      "provider,venue_external_id,worker_external_id,shift_external_id,tip_type,gross_tip,clock_in,clock_out,role,payout_route,payroll_status",
      `csv_test,venue_${runId},worker_${runId},shift_${runId},CARD_TIP,10.00,2026-08-05T17:00:00Z,2026-08-05T18:00:00Z,SERVER,USDC,PENDING`,
    ].join("\n");

    await api()
      .post("/providers/csv/import")
      .set(bearer(manager))
      .send({ venueId, csvText })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({ tipsUpserted: 1, shiftsUpserted: 1, unmappedShifts: 1 });
      });

    const mapping = await api()
      .post("/worker-mappings")
      .set(bearer(manager))
      .send({ workerId, venueId, provider: "csv_test", externalWorkerId: `worker_${runId}` })
      .expect(201);
    await api()
      .patch(`/worker-mappings/${mapping.body.id}/verify`)
      .set(bearer(manager))
      .expect(200)
      .expect(({ body }) => {
        expect(body.backfilledShifts).toBe(1);
      });

    await api()
      .post(`/venues/${venueId}/allocation-policies`)
      .set(bearer(manager))
      .send({
        allocationType: "ROLE_WEIGHTED_HOURS",
        roleWeights: { SERVER: 1 },
        poolInclusion: { CARD_TIP: true },
        excludedRoles: [],
        effectiveFrom: "2026-08-01T00:00:00.000Z",
      })
      .expect(201);

    const calculated = await api()
      .post("/allocation-batches/calculate")
      .set(bearer(manager))
      .send({ venueId, businessDate: "2026-08-05" })
      .expect(201);
    expect(calculated.body).toMatchObject({
      venueId,
      status: "CALCULATED",
      tipPoolAmountUsdCents: 1000,
    });
    expect(calculated.body.allocations).toHaveLength(1);
    const batchId = calculated.body.id as string;

    await api().post(`/allocation-batches/${batchId}/approve`).set(bearer(viewer)).expect(403);
    await api()
      .post(`/allocation-batches/${batchId}/approve`)
      .set(bearer(owner))
      .expect(201)
      .expect(({ body }) => {
        expect(body.status).toBe("PAYABLE");
        expect(body.approvedBy).toBe(owner.userId);
      });
    await api().post(`/allocation-batches/${batchId}/approve`).set(bearer(owner)).expect(409);
    await api()
      .post("/allocation-batches/calculate")
      .set(bearer(owner))
      .send({ venueId, businessDate: "2026-08-05" })
      .expect(409);
  });
});
