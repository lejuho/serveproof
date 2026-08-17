import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { Keypair, Transaction } from "@solana/web3.js";

/**
 * Spec §26 — the 24-step demo scenario, end to end.
 *
 * UI drives every step that has a screen (login, CSV import, mapping,
 * calculate/approve, legacy payout, income rebuild, worker income view,
 * disclosure issue/revoke, public verify). Steps without a browser surface go
 * through the same API the UI calls; USDC signing uses the venue dev keypair
 * because headless Chromium has no wallet extension (§29.4 flow otherwise
 * identical). Set PW_SKIP_ONCHAIN=1 to route Worker B through a legacy rail
 * when Devnet is unreachable.
 *
 * Fresh state per run: an unallocated business date on the seeded Demo Diner
 * plus a brand-new unmapped worker (steps 5–6).
 */

const API = process.env.PW_API_URL ?? "http://localhost:3001";
// A batch is unique per (venue, businessDate) and approved batches cannot be
// recalculated, so each run needs a date with no batch yet. Setup probes
// candidate dates through the API (calculate → 400 "no evidence" means free,
// 409 means an approved batch already owns the date) and picks the first free
// one, so runs never collide regardless of history.
let BUSINESS_DATE = process.env.PW_BUSINESS_DATE ?? "";
let CSV = "";
const RUN = Date.now().toString(36);
const SKIP_ONCHAIN = process.env.PW_SKIP_ONCHAIN === "1";

const MANAGER_EMAIL = "manager@demo.serveproof.local";
const WORKER_A_EMAIL = "worker.a@demo.serveproof.local";
const WORKER_B_EMAIL = "worker.b@demo.serveproof.local";
const UNMAPPED_EMAIL = `worker.d.${RUN}@demo.serveproof.local`;
const UNMAPPED_EXTERNAL_ID = `worker_004_${RUN}`;

function buildCsv(date: string): string {
  return [
    "provider,venue_external_id,worker_external_id,shift_external_id,tip_type,gross_tip,clock_in,clock_out,role,payout_route,payroll_status",
    `toast_mock,venue_001,worker_001,shift_${RUN}_1,CARD_TIP,120.00,${date}T17:00:00Z,${date}T22:00:00Z,SERVER,PAYROLL,PROVIDER_CONFIRMED`,
    `toast_mock,venue_001,worker_002,shift_${RUN}_2,CARD_TIP,0.00,${date}T17:00:00Z,${date}T23:00:00Z,SERVER,USDC,PENDING`,
    `toast_mock,venue_001,worker_003,shift_${RUN}_3,CASH_TIP,35.50,${date}T18:00:00Z,${date}T22:30:00Z,BUSSER,CASH_RETAINED,PENDING`,
    `toast_mock,venue_001,${UNMAPPED_EXTERNAL_ID},shift_${RUN}_4,CARD_TIP,0.00,${date}T17:30:00Z,${date}T21:30:00Z,SERVER,PAYROLL,PENDING`,
  ].join("\n");
}

/** First 2025 date whose (venue, date) slot has no batch — probed via the API. */
async function pickFreeBusinessDate(
  request: APIRequestContext,
  token: string,
  venueId: string,
): Promise<string> {
  const start = Math.floor(Date.now() / 60_000) % 300;
  for (let offset = 0; offset < 60; offset++) {
    const day = new Date(Date.UTC(2025, 0, 1 + start + offset));
    const candidate = day.toISOString().slice(0, 10);
    const response = await request.post(`${API}/allocation-batches/calculate`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { venueId, businessDate: candidate },
    });
    if (response.status() === 400) return candidate; // no evidence → free slot
  }
  throw new Error("No free business date found in probe window");
}

// ── helpers ─────────────────────────────────────────────────────

async function apiLogin(request: APIRequestContext, email: string): Promise<string> {
  const otp = await (await request.post(`${API}/auth/otp/request`, { data: { email } })).json();
  const verified = await (
    await request.post(`${API}/auth/otp/verify`, { data: { email, code: otp.devCode } })
  ).json();
  expect(verified.accessToken, `login as ${email}`).toBeTruthy();
  return verified.accessToken;
}

async function apiGet(request: APIRequestContext, token: string, path: string) {
  const response = await request.get(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok(), `GET ${path} → ${response.status()}`).toBeTruthy();
  return response.json();
}

async function apiPost(request: APIRequestContext, token: string, path: string, data?: unknown) {
  const response = await request.post(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: data ?? {},
  });
  expect(response.ok(), `POST ${path} → ${response.status()}`).toBeTruthy();
  return response.json();
}

async function uiLogin(page: Page, email: string) {
  await page.goto("/login");
  await page.getByRole("textbox").fill(email);
  await page.getByRole("button", { name: "인증 코드 받기" }).click();
  const devCodeText = await page.locator("p", { hasText: "로컬 개발 코드" }).textContent();
  const code = devCodeText?.match(/(\d{6})/)?.[1];
  expect(code, "dev OTP code visible on login page").toBeTruthy();
  await page.getByPlaceholder("000000").fill(code!);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
}

async function workerPage(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL: process.env.PW_WEB_URL ?? "http://localhost:3000",
  });
  const page = await context.newPage();
  await uiLogin(page, email);
  await expect(page.getByRole("heading", { name: "내 소득" })).toBeVisible({ timeout: 15_000 });
  return page;
}

test("§26 demo scenario, steps 1–24", async ({ page, browser, request }) => {
  let venueId = "";
  let managerToken = "";
  let unmappedWorkerToken = "";
  let batchId = "";
  let shareUrl = "";

  await test.step("0. fresh-state setup: unmapped worker profile + pending mapping", async () => {
    managerToken = await apiLogin(request, MANAGER_EMAIL);
    const orgs = await apiGet(request, managerToken, "/organizations/mine");
    venueId = orgs
      .flatMap((org: { venues: { id: string; name: string }[] }) => org.venues)
      .find((venue: { name: string }) => venue.name === "Demo Diner")!.id;

    if (!BUSINESS_DATE) {
      BUSINESS_DATE = await pickFreeBusinessDate(request, managerToken, venueId);
    }
    CSV = buildCsv(BUSINESS_DATE);

    unmappedWorkerToken = await apiLogin(request, UNMAPPED_EMAIL); // creates the worker profile
    const me = await apiGet(request, unmappedWorkerToken, "/workers/me");
    await apiPost(request, managerToken, "/worker-mappings", {
      workerId: me.id,
      venueId,
      provider: "toast_mock",
      externalWorkerId: UNMAPPED_EXTERNAL_ID,
    });

    // self-heal: the seed intentionally leaves worker_003 pending.
    const unmappedNow = await apiGet(request, managerToken, `/venues/${venueId}/unmapped-workers`);
    for (const pending of unmappedNow.pendingMappings as {
      id: string;
      externalWorkerId: string;
    }[]) {
      if (pending.externalWorkerId === "worker_003") {
        const workerCToken = await apiLogin(request, "worker.c@demo.serveproof.local");
        await request.patch(`${API}/worker-mappings/${pending.id}/respond`, {
          headers: { Authorization: `Bearer ${workerCToken}` },
          data: { decision: "ACCEPT" },
        });
      }
    }
  });

  await test.step("1. venue manager logs in through the UI", async () => {
    await uiLogin(page, MANAGER_EMAIL);
    await expect(page.getByRole("heading", { name: "Venue Dashboard" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator("select")).toContainText("Demo Diner");
  });

  await test.step("2–4. CSV import: $120 card tip + 4 shifts (1 unmapped)", async () => {
    await page.getByText("데이터 및 직원 준비", { exact: true }).click();
    await page.locator("textarea").fill(CSV);
    await page.getByRole("button", { name: "Import" }).click();
    await expect(page.getByText(/시프트 4건/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/미매핑 1/)).toBeVisible();
  });

  // The pending connection row (the review-issue list can mention the same id).
  const mappingItem = (target: Page) =>
    target
      .locator("li")
      .filter({ hasText: UNMAPPED_EXTERNAL_ID })
      .filter({ hasText: "직원 수락 대기" });

  await test.step("5. unmapped worker blocks approval: calculate → REVIEW_REQUIRED", async () => {
    await expect(mappingItem(page)).toBeVisible();
    await page.locator('input[type="date"]').fill(BUSINESS_DATE);
    const calcResponse = page.waitForResponse((r) =>
      r.url().includes("/allocation-batches/calculate"),
    );
    await page.getByRole("button", { name: "계산", exact: true }).click();
    batchId = (await (await calcResponse).json()).id;
    await expect(page.getByText("REVIEW_REQUIRED")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/UNMAPPED_WORKER/)).toBeVisible();
  });

  await test.step("6. worker accepts the venue connection request", async () => {
    const worker = await workerPage(browser, UNMAPPED_EMAIL);
    await worker.getByRole("button", { name: "근무", exact: true }).click();
    await worker.getByRole("button", { name: "내 근무 계정이 맞습니다" }).click();
    await expect(worker.getByText(/기존 근무 기록이 이 계정에 연결/)).toBeVisible({
      timeout: 15_000,
    });
    await worker.close();
    await page.reload();
    await page.locator('input[type="date"]').fill(BUSINESS_DATE);
  });

  await test.step("7–8. recalculate with the active policy → CALCULATED, pool $120", async () => {
    await page.getByRole("button", { name: "계산", exact: true }).click();
    await expect(page.getByText("CALCULATED")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/팁 풀/)).toContainText("$120.00");
  });

  await test.step("9. manager approves → PAYABLE", async () => {
    await page.getByRole("button", { name: "승인" }).click();
    await expect(page.getByText("PAYABLE").first()).toBeVisible({ timeout: 15_000 });
  });

  await test.step("10. Worker A payroll route via UI (legacy evidence)", async () => {
    page.once("dialog", (dialog) => dialog.accept(`gusto-run-${RUN}`));
    const rowA = page.locator("tr", { hasText: "Worker A" });
    await rowA.getByRole("button", { name: "급여 이체 기록" }).click();
    await expect(rowA.getByText(/PAID · PAYROLL/)).toBeVisible({ timeout: 15_000 });
  });

  await test.step("11–16. Worker B USDC payout: unsigned tx → sign → settle → PAID", async () => {
    const batch = await apiGet(request, managerToken, `/allocation-batches/${batchId}`);
    const allocationB = batch.allocations.find(
      (a: { worker: { user: { displayName: string } } }) =>
        a.worker.user.displayName === "Worker B",
    );
    expect(allocationB).toBeTruthy();

    if (SKIP_ONCHAIN) {
      await apiPost(request, managerToken, "/payouts/legacy-evidence", {
        allocationId: allocationB.id,
        rail: "PAYOUT_PROVIDER",
        externalReference: `skip-onchain-${RUN}`,
      });
      return;
    }

    const payout = await apiPost(request, managerToken, "/payouts", {
      allocationId: allocationB.id,
    });
    const unsigned = await apiGet(request, managerToken, `/payouts/${payout.id}/transaction`);

    // venue wallet signature — dev keypair stands in for the browser wallet
    const keypair = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))),
    );
    expect(keypair.publicKey.toBase58(), "dev keypair must be the venue signer").toBe(
      unsigned.signer,
    );
    const tx = Transaction.from(Buffer.from(unsigned.transactionBase64, "base64"));
    tx.partialSign(keypair);
    await apiPost(request, managerToken, `/payouts/${payout.id}/submit`, {
      signedTransactionBase64: tx.serialize().toString("base64"),
    });

    // §26 step 15–16: PayoutSettled → FINALIZED → allocation PAID
    await expect
      .poll(
        async () => (await apiGet(request, managerToken, `/payouts/${payout.id}`)).status as string,
        // Devnet finalization is usually <30s but can stall for minutes; the
        // worker's reconcile sweep self-heals, so give it room.
        { timeout: 300_000, intervals: [5_000] },
      )
      .toBe("FINALIZED");
    const refreshed = await apiGet(request, managerToken, `/allocation-batches/${batchId}`);
    expect(
      refreshed.allocations.find((a: { id: string }) => a.id === allocationB.id).payoutStatus,
    ).toBe("PAID");
  });

  await test.step("17. payroll mock import for Worker A, then income rebuild via UI", async () => {
    await apiPost(request, managerToken, "/payroll/import", {
      venueId,
      provider: "gusto_mock",
      records: [
        {
          workerEmail: WORKER_A_EMAIL,
          periodStart: `${BUSINESS_DATE}T00:00:00Z`,
          periodEnd: `${BUSINESS_DATE}T23:59:59Z`,
          reportedTipUsdCents: 4000,
          federalWithholdingUsdCents: 400,
          stateWithholdingUsdCents: 100,
          status: "PROVIDER_CONFIRMED",
          providerReference: `gusto-${RUN}`,
        },
      ],
    });
    await page.getByRole("button", { name: "소득 상태 새로고침" }).click();
    await expect(page.getByText(/소득 내역 \d+건을 새로고침했습니다/)).toBeVisible({
      timeout: 20_000,
    });
  });

  let workerB: Page;
  await test.step("18. Worker A sees payroll confirmed on the business date", async () => {
    const workerA = await workerPage(browser, WORKER_A_EMAIL);
    const row = workerA.locator("tr", { hasText: BUSINESS_DATE });
    await expect(row.getByText("CONFIRMED")).toBeVisible({ timeout: 15_000 });
    await workerA.context().close();
  });

  await test.step("19. Worker B sees the payroll-pending alert", async () => {
    workerB = await workerPage(browser, WORKER_B_EMAIL);
    await expect(workerB.getByText("PAYROLL_GAP").first()).toBeVisible({ timeout: 15_000 });
  });

  await test.step("20–21. Worker B issues a 3-month LEVEL_2 report with QR", async () => {
    await workerB.getByText("다른 제출 목적 보기").click();
    await workerB.getByRole("button", { name: /자동차 대출/ }).click();
    await workerB.getByRole("button", { name: "소득 확인 자료 만들기" }).click();
    const link = workerB.locator('a[href*="/verify/"]');
    await expect(link).toBeVisible({ timeout: 30_000 });
    shareUrl = (await link.getAttribute("href"))!;
    await expect(workerB.locator('img[alt="verification QR"]')).toBeVisible();
  });

  const publicContext = await browser.newContext();
  const verifier = await publicContext.newPage();
  await test.step("22. public verifier opens the QR link → VALID", async () => {
    await verifier.goto(shareUrl);
    await expect(verifier.getByText("VALID", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(verifier.getByText("공개 허용된 필드")).toBeVisible();
  });

  await test.step("23–24. correction flips the report to CORRECTED", async () => {
    const workerBToken = await apiLogin(request, WORKER_B_EMAIL);
    const timeline = await apiGet(request, workerBToken, "/workers/me/income-timeline");
    const entry = timeline.items.find(
      (e: { businessDate: string | null }) => e.businessDate === BUSINESS_DATE,
    );
    expect(entry, `Worker B income entry for ${BUSINESS_DATE}`).toBeTruthy();
    await apiPost(request, managerToken, `/income-entries/${entry.id}/correct`, {
      reason: `shift correction ${RUN}`,
    });

    await verifier.reload();
    await expect(verifier.getByText("CORRECTED", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
  });

  await test.step("acceptance: revoke blocks the link (§28/§30)", async () => {
    await workerB.reload();
    await workerB.getByRole("button", { name: "철회" }).first().click();
    await expect(workerB.getByText("철회됨").first()).toBeVisible({ timeout: 15_000 });

    await verifier.reload();
    await expect(verifier.getByText("REVOKED", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(verifier.getByText("공개 허용된 필드")).toBeHidden();
    await workerB.context().close();
    await publicContext.close();
  });
});
