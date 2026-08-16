"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  api,
  ApiError,
  getCurrentSession,
  getToken,
  logoutSession,
  syncCurrentSession,
  switchAppMode,
  type AppMode,
} from "@/lib/api";
import { connectWallet, signTransactionBase64 } from "@/lib/wallet";
import { useI18n } from "@/lib/i18n";
import {
  AppShell,
  Badge,
  Button,
  Callout,
  Card,
  inputClass,
  tableCellClass,
  tableHeadClass,
} from "@/components/ui";
import { WorkerConnections, type WorkerConnectionsResponse } from "@/components/worker-connections";

interface Venue {
  id: string;
  name: string;
}
interface Organization {
  id: string;
  displayName: string;
  venues: Venue[];
}
interface ImportSummary {
  tipsUpserted: number;
  shiftsUpserted: number;
  mappedShifts: number;
  unmappedShifts: number;
  businessDates?: string[];
  errors: { line: number; message: string }[];
}
interface PendingMapping {
  id: string;
  externalWorkerId: string;
  provider: string;
  worker: { user: { displayName: string; email: string } };
}
interface UnmappedResponse {
  unmappedShiftWorkers: { provider: string; externalWorkerId: string }[];
  pendingMappings: PendingMapping[];
}
interface Allocation {
  id: string;
  pooledTipUsdCents: number;
  netAllocatedUsdCents: number;
  payoutStatus: "UNPAID" | "PENDING" | "PAID" | "FAILED";
  payoutRail: string | null;
  worker: { defaultWalletId: string | null; user: { displayName: string } };
}
interface Batch {
  id: string;
  status: string;
  businessDate: string;
  policyVersion: number;
  tipPoolAmountUsdCents: number;
  reviewIssues: { code: string; blocking: boolean; detail: Record<string, unknown> }[];
  allocations: Allocation[];
}
interface Payout {
  id: string;
  status:
    | "CREATED"
    | "INITIATED"
    | "SUBMITTED"
    | "CONFIRMED"
    | "FINALIZED"
    | "FAILED"
    | "REVERSED"
    | "CORRECTED";
  txSignature: string | null;
}

const PAYOUT_VERIFICATION_ERRORS = [
  "Payout is CONFIRMED",
  "Payout is SUBMITTED",
  "Settlement already exists on-chain",
  "Previous payout blockhash is still valid",
  "Payout transaction blockhash is still valid",
];

function isPayoutVerificationError(message: string): boolean {
  return PAYOUT_VERIFICATION_ERRORS.some((fragment) => message.includes(fragment));
}

function isPayoutBlockhashExpiredError(message: string): boolean {
  return message.includes("blockhash expired before submission");
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function DashboardPage() {
  const { locale, t } = useI18n();
  const statusLabel = (value: string) => {
    if (locale !== "ko") return value;
    const labels: Record<string, string> = {
      DRAFT: "작성 중",
      CALCULATED: "계산 완료",
      REVIEW_REQUIRED: "검토 필요",
      APPROVED: "승인 완료",
      UNPAID: "지급 전",
      PENDING: "처리 중",
      PAID: "지급 완료",
      FAILED: "실패",
      CREATED: "요청 생성됨",
      INITIATED: "전송 준비 중",
      SUBMITTED: "전송됨",
      CONFIRMED: "확인됨",
      FINALIZED: "최종 확정",
    };
    return labels[value] ?? value;
  };
  const issueLabel = (issue: Batch["reviewIssues"][number]) => {
    if (locale !== "ko") return `${issue.code} ${JSON.stringify(issue.detail)}`;
    const amount =
      typeof issue.detail.amountUsdCents === "number" ? usd(issue.detail.amountUsdCents) : null;
    switch (issue.code) {
      case "REFUNDED_PAYMENT_EXCLUDED":
        return `${amount ? `${amount}의 ` : ""}환불된 결제는 배분 대상에서 제외했습니다.`;
      case "CANCELED_PAYMENT_EXCLUDED":
        return `${amount ? `${amount}의 ` : ""}취소된 결제는 배분 대상에서 제외했습니다.`;
      case "UNMAPPED_WORKER":
        return `계정에 연결되지 않은 직원(${String(issue.detail.externalWorkerId ?? "정보 없음")})의 근무 기록이 있습니다.`;
      case "NON_POSITIVE_MINUTES":
        return "근무 시간이 올바르지 않은 기록이 있습니다. 근무 시간을 확인해 주세요.";
      case "UNKNOWN_ROLE":
        return `배분 정책에 등록되지 않은 직무(${String(issue.detail.role ?? "정보 없음")})가 있습니다.`;
      case "EMPTY_POOL":
        return "이 영업일에는 배분할 팁이 없습니다.";
      case "NO_ELIGIBLE_SHIFTS":
        return "배분 대상에 포함할 수 있는 근무 기록이 없습니다.";
      default:
        return "배분 전에 확인해야 할 항목이 있습니다.";
    }
  };
  const router = useRouter();
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [venueId, setVenueId] = useState<string>("");
  const [csvText, setCsvText] = useState("");
  const [importResult, setImportResult] = useState<ImportSummary | null>(null);
  const [unmapped, setUnmapped] = useState<UnmappedResponse | null>(null);
  const [businessDate, setBusinessDate] = useState("2026-08-05");
  const [batch, setBatch] = useState<Batch | null>(null);
  const [payoutProgress, setPayoutProgress] = useState<Record<string, string>>({});
  // Legacy 증빙 인라인 입력 — 열려 있는 행 id와 참조번호 입력값
  const [legacyOpenFor, setLegacyOpenFor] = useState<string | null>(null);
  const [legacyRef, setLegacyRef] = useState("");
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [rebuildResult, setRebuildResult] = useState<{
    entriesUpserted: number;
    alerts: number;
  } | null>(null);
  const [actionItems, setActionItems] = useState<{
    unmappedWorkerCount: number;
    uncalculatedDates: string[];
    awaitingApprovalCount: number;
    awaitingApproval?: { id: string; businessDate: string; status: string }[];
    unpaidAllocationCount: number;
    unpaidTotalUsdCents: number;
    unpaidBatches?: { id: string; businessDate: string; status: string; unpaidCount: number }[];
  } | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [venueSigner, setVenueSigner] = useState<string | null>(null);
  const [workerConnections, setWorkerConnections] = useState<WorkerConnectionsResponse | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [availableModes, setAvailableModes] = useState<AppMode[]>([]);
  // React state does not update synchronously, so `busy` alone cannot stop two
  // clicks in the same render frame from opening parallel wallet-sign flows.
  const payoutLocks = useRef(new Set<string>());

  const guard = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) {
        router.push("/login");
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    },
    [router],
  );

  useEffect(() => {
    if (!getToken()) {
      router.push("/login");
      return;
    }
    setAvailableModes(getCurrentSession()?.modes ?? []);
    void syncCurrentSession().then((session) => setAvailableModes(session?.modes ?? []));
    api<Organization[]>("/organizations/mine")
      .then((data) => {
        setAvailableModes(getCurrentSession()?.modes ?? []);
        setOrgs(data);
        const firstVenue = data.flatMap((o) => o.venues)[0];
        if (firstVenue) setVenueId(firstVenue.id);
      })
      .catch(guard);
  }, [router, guard]);

  const refreshUnmapped = useCallback(() => {
    if (!venueId) return;
    api<UnmappedResponse>(`/venues/${venueId}/unmapped-workers`).then(setUnmapped).catch(guard);
    api<typeof actionItems>(`/venues/${venueId}/action-items`).then(setActionItems).catch(guard);
    api<WorkerConnectionsResponse>(`/venues/${venueId}/worker-connections`)
      .then(setWorkerConnections)
      .catch(guard);
  }, [venueId, guard]);

  useEffect(() => {
    refreshUnmapped();
    setBatch(null);
    setImportResult(null);
    setRebuildResult(null);
    if (venueId) {
      api<{ payoutSignerWallet: string | null }>(`/venues/${venueId}`)
        .then((venue) => setVenueSigner(venue.payoutSignerWallet))
        .catch(guard);
    }
  }, [venueId, refreshUnmapped, guard]);

  const connect = () =>
    run(async () => {
      setWalletAddress(await connectWallet());
    });

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      guard(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  const refreshBatch = useCallback(async () => {
    if (!batch) return;
    const refreshed = await api<Batch>(`/allocation-batches/${batch.id}`);
    setBatch(refreshed);
  }, [batch]);

  /** 데모용 Toast POS 데이터 — 오늘 영업일 기준으로 임의 금액 CSV를 생성해 채운다. */
  const fillToastDemoCsv = () => {
    const today = new Date().toISOString().slice(0, 10);
    const rnd = (min: number, max: number) => (Math.random() * (max - min) + min).toFixed(2);
    setCsvText(
      [
        "provider,venue_external_id,worker_external_id,shift_external_id,tip_type,gross_tip,clock_in,clock_out,role,payout_route,payroll_status",
        `toast_mock,venue_demo,smoke.a,${today}_s1,CARD_TIP,${rnd(90, 180)},${today}T17:00:00Z,${today}T22:00:00Z,SERVER,PAYROLL,PROVIDER_CONFIRMED`,
        `toast_mock,venue_demo,smoke.b,${today}_s2,CARD_TIP,${rnd(60, 150)},${today}T17:30:00Z,${today}T23:00:00Z,SERVER,USDC,PENDING`,
        `toast_mock,venue_demo,demo.b,${today}_s3,CARD_TIP,${rnd(50, 120)},${today}T18:00:00Z,${today}T23:30:00Z,SERVER,USDC,PENDING`,
        `toast_mock,venue_demo,demo.b,${today}_s3,CASH_TIP,${rnd(10, 40)},${today}T18:00:00Z,${today}T23:30:00Z,SERVER,USDC,PENDING`,
      ].join("\n"),
    );
    setSyncMessage(null);
  };

  /** Square Sandbox에서 최근 14일 증거를 실제로 동기화 (worker가 처리). */
  const syncSquare = () =>
    run(async () => {
      const end = new Date().toISOString().slice(0, 10);
      const start = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
      const res = await api<{ jobId: string; status: string }>("/evidence/sync", {
        method: "POST",
        body: { venueId, provider: "square", startDate: start, endDate: end },
      });
      setSyncMessage(`${t("dash.source.syncQueued")} (job ${res.jobId})`);
      setTimeout(refreshUnmapped, 5000);
    });

  const importCsv = () =>
    run(async () => {
      const result = await api<ImportSummary>("/providers/csv/import", {
        method: "POST",
        body: { venueId, csvText },
      });
      setImportResult(result);
      // 임포트된 CSV의 최신 영업일을 계산 날짜로 자동 선택
      const latest = result.businessDates?.at(-1);
      if (latest) setBusinessDate(latest);
      refreshUnmapped();
    });

  const verifyMapping = (mappingId: string) =>
    run(async () => {
      await api(`/worker-mappings/${mappingId}/verify`, { method: "PATCH", body: {} });
      refreshUnmapped();
    });

  const calculate = () =>
    run(async () => {
      const result = await api<Batch>("/allocation-batches/calculate", {
        method: "POST",
        body: { venueId, businessDate },
      });
      setBatch(result);
    });

  const approve = () =>
    run(async () => {
      if (!batch) return;
      await api(`/allocation-batches/${batch.id}/approve`, { method: "POST", body: {} });
      await refreshBatch();
      refreshUnmapped();
    });

  const scrollToCard = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  // 오늘 할 일 타일 클릭 → 해당 배치를 3단계 카드에 로드하고 이동
  const openBatch = (b: { id: string; businessDate: string }) =>
    run(async () => {
      setBusinessDate(b.businessDate);
      setBatch(await api<Batch>(`/allocation-batches/${b.id}`));
      scrollToCard("card-alloc");
    });

  const setProgress = (allocationId: string, message: string) =>
    setPayoutProgress((prev) => ({ ...prev, [allocationId]: message }));

  /** Spec §29.4 flow: create → unsigned tx → wallet signs → submit → poll. */
  const payUsdc = async (allocationId: string) => {
    if (payoutLocks.current.has(allocationId)) return;
    payoutLocks.current.add(allocationId);
    setBusy(true);
    setError(null);
    try {
      await payUsdcInner(allocationId);
    } catch (e) {
      // 실패를 그 행에 그대로 표시 — "생성 중…"으로 고착되지 않게
      const message = e instanceof Error ? e.message : String(e);
      if (isPayoutVerificationError(message)) {
        // §29.7 가드는 정상적인 안전 상태다. 행에는 안내문을 표시하되
        // 같은 409 영어 원문을 전역 오류 Callout에 다시 노출하지 않는다.
        setProgress(allocationId, t("dash.progress.verifying"));
        await refreshBatch().catch(guard);
      } else if (isPayoutBlockhashExpiredError(message)) {
        setProgress(allocationId, t("dash.progress.expired"));
        await refreshBatch().catch(guard);
      } else {
        setProgress(allocationId, `${t("dash.progress.failed")}: ${message}`);
        guard(e);
      }
    } finally {
      payoutLocks.current.delete(allocationId);
      setBusy(false);
    }
  };

  const payUsdcInner = async (allocationId: string) => {
    {
      setProgress(allocationId, t("dash.progress.create"));
      const payout = await api<Payout>("/payouts", { method: "POST", body: { allocationId } });

      // POST /payouts is idempotent and may return an existing attempt. Never
      // rebuild or request another signature while that attempt is resolving.
      if (["SUBMITTED", "CONFIRMED"].includes(payout.status)) {
        setProgress(allocationId, t("dash.progress.verifying"));
        await refreshBatch();
        refreshUnmapped();
        return;
      }
      if (payout.status === "FINALIZED") {
        setProgress(allocationId, `${t("dash.progress.onchain")} FINALIZED`);
        await refreshBatch();
        refreshUnmapped();
        return;
      }

      setProgress(allocationId, t("dash.progress.build"));
      const tx = await api<{ transactionBase64: string; signer: string }>(
        `/payouts/${payout.id}/transaction`,
      );

      setProgress(allocationId, t("dash.progress.sign"));
      const signed = await signTransactionBase64(tx.transactionBase64, tx.signer);

      setProgress(allocationId, t("dash.progress.submit"));
      await api(`/payouts/${payout.id}/submit`, {
        method: "POST",
        body: { signedTransactionBase64: signed },
      });

      let terminal = false;
      for (let i = 0; i < 30; i++) {
        const current = await api<Payout>(`/payouts/${payout.id}`);
        setProgress(
          allocationId,
          current.status === "CONFIRMED"
            ? t("dash.progress.confirmed")
            : `${t("dash.progress.onchain")} ${statusLabel(current.status)}`,
        );
        if (["FINALIZED", "FAILED"].includes(current.status)) {
          terminal = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (!terminal) setProgress(allocationId, t("dash.progress.verifying"));
      await refreshBatch();
      refreshUnmapped();
    }
  };

  const payLegacy = (allocationId: string, reference: string) =>
    run(async () => {
      try {
        await api("/payouts/legacy-evidence", {
          method: "POST",
          body: { allocationId, rail: "PAYROLL", externalReference: reference },
        });
        setProgress(allocationId, t("dash.progress.legacyDone"));
        setLegacyOpenFor(null);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setProgress(allocationId, `${t("dash.progress.failed")}: ${message}`);
        throw e;
      }
      await refreshBatch();
      refreshUnmapped();
    });

  const rebuildIncome = () =>
    run(async () => {
      const result = await api<{ entriesUpserted: number; alerts: number }>(
        `/venues/${venueId}/income/rebuild`,
        { method: "POST", body: {} },
      );
      setRebuildResult(result);
      refreshUnmapped();
    });

  const payable = batch && ["PAYABLE", "PARTIALLY_PAID", "PAID"].includes(batch.status);

  return (
    <AppShell
      wide
      title={locale === "ko" ? "사업장 관리" : "Venue Dashboard"}
      subtitle={t("dash.subtitle")}
      right={
        <>
          <select
            className="max-w-64 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 shadow-sm outline-none focus:border-emerald-500"
            value={venueId}
            onChange={(e) => setVenueId(e.target.value)}
          >
            {orgs.flatMap((org) =>
              org.venues.map((v) => (
                <option key={v.id} value={v.id}>
                  {org.displayName} / {v.name}
                </option>
              )),
            )}
          </select>
          {availableModes.includes("worker") && (
            <button
              type="button"
              onClick={() => {
                const destination = switchAppMode("worker");
                if (destination) router.push(destination);
              }}
              className="text-sm font-medium text-emerald-700 hover:text-emerald-800"
            >
              {t("auth.viewAsWorker")}
            </button>
          )}
          <a
            href="/login?switch=1"
            className="text-sm font-medium text-zinc-400 hover:text-zinc-600"
          >
            {t("auth.switch")}
          </a>
          <button
            onClick={async () => {
              await logoutSession();
              router.push("/login?switch=1");
            }}
            className="text-sm font-medium text-zinc-400 hover:text-zinc-600"
          >
            {t("logout")}
          </button>
        </>
      }
    >
      {error && <Callout tone="red">{error}</Callout>}

      {walletAddress && venueSigner && walletAddress !== venueSigner && (
        <Callout tone="amber">
          {t("dash.banner.signerMismatch")}{" "}
          <code className="font-mono text-xs">
            {walletAddress.slice(0, 8)}…{walletAddress.slice(-6)}
          </code>{" "}
          ≠{" "}
          <code className="font-mono text-xs">
            {venueSigner.slice(0, 8)}…{venueSigner.slice(-6)}
          </code>
        </Callout>
      )}

      {actionItems && (
        <Card title={t("dash.todo.title")} description={t("dash.todo.desc")}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                label: t("dash.todo.unmapped"),
                value: String(actionItems.unmappedWorkerCount),
                urgent: actionItems.unmappedWorkerCount > 0,
                action:
                  actionItems.unmappedWorkerCount > 0
                    ? () => scrollToCard("card-mapping")
                    : undefined,
                cta: t("dash.todo.cta.map"),
              },
              {
                label: t("dash.todo.uncalculated"),
                value: String(actionItems.uncalculatedDates.length),
                detail: actionItems.uncalculatedDates.slice(0, 3).join(", "),
                urgent: actionItems.uncalculatedDates.length > 0,
                action: actionItems.uncalculatedDates.length
                  ? () => {
                      setBusinessDate(actionItems.uncalculatedDates[0] ?? businessDate);
                      scrollToCard("card-alloc");
                    }
                  : undefined,
                cta: t("dash.todo.cta.calc"),
              },
              {
                label: t("dash.todo.approval"),
                value: String(actionItems.awaitingApprovalCount),
                detail: actionItems.awaitingApproval
                  ?.slice(0, 2)
                  .map((b) => b.businessDate)
                  .join(", "),
                urgent: actionItems.awaitingApprovalCount > 0,
                action: (() => {
                  const target = actionItems.awaitingApproval?.[0];
                  return target ? () => openBatch(target) : undefined;
                })(),
                cta: t("dash.todo.cta.review"),
              },
              {
                label: t("dash.todo.unpaid"),
                value: `${actionItems.unpaidAllocationCount}`,
                detail:
                  actionItems.unpaidAllocationCount > 0
                    ? usd(actionItems.unpaidTotalUsdCents)
                    : undefined,
                urgent: actionItems.unpaidAllocationCount > 0,
                action: (() => {
                  const target = actionItems.unpaidBatches?.[0];
                  return target ? () => openBatch(target) : undefined;
                })(),
                cta: t("dash.todo.cta.pay"),
              },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={item.action}
                disabled={!item.action}
                className={`rounded-xl border p-4 text-left transition ${
                  item.urgent
                    ? "cursor-pointer border-amber-300 bg-amber-50/70 hover:border-amber-400 hover:shadow-sm"
                    : "cursor-default border-zinc-200 bg-zinc-50/60"
                }`}
              >
                <p className="text-xs font-medium text-zinc-500">{item.label}</p>
                <p
                  className={`mt-1 text-2xl font-bold tabular-nums ${
                    item.urgent ? "text-amber-700" : "text-zinc-400"
                  }`}
                >
                  {item.value}
                </p>
                {item.detail && <p className="mt-0.5 text-xs text-zinc-500">{item.detail}</p>}
                {item.action && (
                  <p className="mt-2 text-xs font-semibold text-amber-700">{item.cta} →</p>
                )}
              </button>
            ))}
          </div>
        </Card>
      )}

      {workerConnections && <WorkerConnections data={workerConnections} locale={locale} />}

      <Card
        step={1}
        title={locale === "ko" ? "팁 및 근무 기록 가져오기" : "CSV Import"}
        description={t("dash.csv.desc")}
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
            {t("dash.source.label")}
          </span>
          <Button size="sm" variant="secondary" onClick={fillToastDemoCsv} disabled={busy}>
            🍞 {t("dash.source.toast")}
          </Button>
          <Button size="sm" variant="secondary" onClick={syncSquare} disabled={busy || !venueId}>
            ⬛ {t("dash.source.square")}
          </Button>
          {syncMessage && <span className="text-sm text-emerald-700">{syncMessage}</span>}
        </div>
        <textarea
          className={`${inputClass} h-32 font-mono text-xs leading-relaxed`}
          placeholder="provider,venue_external_id,worker_external_id,..."
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
        />
        <div className="mt-3 flex items-center gap-4">
          <Button variant="dark" onClick={importCsv} disabled={busy || !csvText || !venueId}>
            {locale === "ko" ? "가져오기" : "Import"}
          </Button>
          {importResult && (
            <p className="text-sm text-zinc-500">
              {locale === "ko" ? (
                <>
                  팁 <b className="text-zinc-800">{importResult.tipsUpserted}건</b>, 근무 기록{" "}
                  <b className="text-zinc-800">{importResult.shiftsUpserted}건</b> (매핑{" "}
                  {importResult.mappedShifts} / 연결 필요 {importResult.unmappedShifts})
                  {importResult.errors.length > 0 && (
                    <span className="text-red-600">. 오류 {importResult.errors.length}건</span>
                  )}
                  {!!importResult.businessDates?.length && (
                    <span className="text-emerald-700">
                      {" "}
                      . 영업일 {importResult.businessDates.join(", ")}을 확인해 계산 날짜로 자동 선택했습니다.
                    </span>
                  )}
                </>
              ) : (
                <>
                  <b className="text-zinc-800">{importResult.tipsUpserted}</b> tips,{" "}
                  <b className="text-zinc-800">{importResult.shiftsUpserted}</b> shifts (
                  {importResult.mappedShifts} mapped / {importResult.unmappedShifts} unmapped)
                  {importResult.errors.length > 0 && (
                    <span className="text-red-600">. {importResult.errors.length} errors</span>
                  )}
                  {!!importResult.businessDates?.length && (
                    <span className="text-emerald-700">
                      {" "}
                      . Detected {importResult.businessDates.join(", ")}; calculation date was selected automatically.
                    </span>
                  )}
                </>
              )}
            </p>
          )}
        </div>
      </Card>

      <div id="card-mapping" className="scroll-mt-6" />
      <Card
        step={2}
        title={locale === "ko" ? "직원 계정 연결" : "Worker Mapping"}
        description={t("dash.mapping.desc")}
      >
        {unmapped && unmapped.pendingMappings.length === 0 ? (
          <p className="text-sm text-zinc-400">{t("dash.mapping.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {unmapped?.pendingMappings.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3"
              >
                <span className="text-[15px]">
                  <b className="font-mono text-sm">{m.externalWorkerId}</b>
                  <span className="text-zinc-400"> ({m.provider})</span>
                  <span className="mx-2 text-zinc-400">→</span>
                  {m.worker.user.displayName}
                </span>
                <Button
                  size="sm"
                  variant="dark"
                  onClick={() => verifyMapping(m.id)}
                  disabled={busy}
                >
                  {t("dash.mapping.confirm")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div id="card-alloc" className="scroll-mt-6" />
      <Card step={3} title={t("dash.alloc.title")} description={t("dash.alloc.desc")}>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="date"
            className={`${inputClass} w-auto`}
            value={businessDate}
            onChange={(e) => setBusinessDate(e.target.value)}
          />
          <Button variant="dark" onClick={calculate} disabled={busy || !venueId}>
            {t("dash.calc")}
          </Button>
          <Button onClick={approve} disabled={busy || batch?.status !== "CALCULATED"}>
            {t("dash.approve")}
          </Button>
        </div>

        {batch && (
          <div className="mt-5 flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-zinc-50 px-4 py-3">
              <Badge tone={batch.status}>{statusLabel(batch.status)}</Badge>
              <span className="text-sm text-zinc-500">
                {batch.businessDate} · {t("dash.policy")} v{batch.policyVersion}
              </span>
              <span className="ml-auto text-sm text-zinc-500">
                {t("dash.pool")}{" "}
                <b className="text-lg font-bold tracking-tight text-zinc-900 tabular-nums">
                  {usd(batch.tipPoolAmountUsdCents)}
                </b>
              </span>
            </div>

            {batch.reviewIssues.length > 0 && (
              <ul className="flex flex-col gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                {batch.reviewIssues.map((issue, i) => (
                  <li key={i} className="text-xs leading-relaxed">
                    {issue.blocking ? "확인 필요:" : "안내:"} {issueLabel(issue)}
                  </li>
                ))}
              </ul>
            )}

            {!payable && batch.allocations.length > 0 && (
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={tableHeadClass}>{t("worker")}</th>
                    <th className={`${tableHeadClass} text-right`}>{t("amount")}</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.allocations.map((a) => (
                    <tr key={a.id}>
                      <td className={tableCellClass}>{a.worker.user.displayName}</td>
                      <td className={`${tableCellClass} text-right font-semibold tabular-nums`}>
                        {usd(a.netAllocatedUsdCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </Card>

      {batch && payable && (
        <Card step={4} title={t("dash.payout.title")} description={t("dash.payout.desc")}>
          <Callout tone="amber">{t("dash.payout.callout")}</Callout>
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-zinc-50 px-4 py-3">
            {walletAddress ? (
              <>
                <Badge tone={walletAddress === venueSigner ? "CONFIRMED" : "FAILED"}>
                  {t("dash.wallet.connected")} ·{" "}
                  {walletAddress === venueSigner
                    ? t("dash.wallet.match")
                    : t("dash.wallet.mismatch")}
                </Badge>
                <code className="text-xs text-zinc-500">
                  {walletAddress.slice(0, 8)}…{walletAddress.slice(-6)}
                </code>
              </>
            ) : (
              <Button size="sm" variant="secondary" onClick={connect} disabled={busy}>
                {t("dash.wallet.connect")}
              </Button>
            )}
            {venueSigner && (
              <span className="ml-auto text-xs text-zinc-400">
                {t("dash.wallet.expectedSigner")}:{" "}
                <code>
                  {venueSigner.slice(0, 8)}…{venueSigner.slice(-6)}
                </code>
              </span>
            )}
          </div>
          <table className="mt-4 w-full">
            <thead>
              <tr>
                <th className={tableHeadClass}>{t("worker")}</th>
                <th className={`${tableHeadClass} text-right`}>{t("amount")}</th>
                <th className={tableHeadClass}>{t("status")}</th>
                <th className={tableHeadClass}>{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {batch.allocations.map((a) => (
                <tr key={a.id}>
                  <td className={`${tableCellClass} font-medium text-zinc-900`}>
                    {a.worker.user.displayName}
                  </td>
                  <td className={`${tableCellClass} text-right font-semibold tabular-nums`}>
                    {usd(a.netAllocatedUsdCents)}
                  </td>
                  <td className={tableCellClass}>
                    <Badge tone={a.payoutStatus}>
                      {statusLabel(a.payoutStatus)}
                      {a.payoutRail ? ` · ${a.payoutRail}` : ""}
                    </Badge>
                    {payoutProgress[a.id] && (
                      <span className="ml-2 text-xs text-zinc-400">{payoutProgress[a.id]}</span>
                    )}
                  </td>
                  <td className={tableCellClass}>
                    {a.payoutStatus !== "PAID" && (
                      <span className="flex gap-2">
                        <Button
                          size="sm"
                          variant="violet"
                          onClick={() => payUsdc(a.id)}
                          disabled={busy || !a.worker.defaultWalletId}
                          title={a.worker.defaultWalletId ? undefined : t("dash.payout.noWallet")}
                        >
                          {t("dash.payout.usdc")}
                        </Button>
                        {!a.worker.defaultWalletId && (
                          <span className="self-center text-xs text-zinc-400">
                            {t("dash.payout.noWallet")}
                          </span>
                        )}
                        {legacyOpenFor === a.id ? (
                          <span className="flex items-center gap-1.5">
                            <input
                              autoFocus
                              className={`${inputClass} w-44 px-2.5 py-1.5 text-sm`}
                              value={legacyRef}
                              onChange={(e) => setLegacyRef(e.target.value)}
                              placeholder={t("dash.payout.refPlaceholder")}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && legacyRef.trim())
                                  payLegacy(a.id, legacyRef.trim());
                                if (e.key === "Escape") setLegacyOpenFor(null);
                              }}
                            />
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => payLegacy(a.id, legacyRef.trim())}
                              disabled={busy || !legacyRef.trim()}
                            >
                              {t("dash.payout.refConfirm")}
                            </Button>
                            <button
                              type="button"
                              onClick={() => setLegacyOpenFor(null)}
                              className="text-xs text-zinc-400 hover:text-zinc-600"
                            >
                              {t("dash.payout.refCancel")}
                            </button>
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setLegacyRef("");
                              setLegacyOpenFor(a.id);
                            }}
                            disabled={busy}
                          >
                            {t("dash.payout.legacy")}
                          </Button>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card
        step={5}
        title={locale === "ko" ? "소득 상태 확인" : "Income status"}
        description={t("dash.income.desc")}
      >
        <div className="flex items-center gap-4">
          <Button variant="dark" onClick={rebuildIncome} disabled={busy || !venueId}>
            {t("dash.income.rebuild")}
          </Button>
          {rebuildResult && (
            <span className="text-sm text-zinc-500">
              {locale === "ko"
                ? `소득 내역 ${rebuildResult.entriesUpserted}건을 새로고침했습니다. 확인 필요 항목은 ${rebuildResult.alerts}건입니다.`
                : `${rebuildResult.entriesUpserted} income entries refreshed. ${rebuildResult.alerts} items require review.`}
            </span>
          )}
        </div>
        <p className="mt-3 text-sm text-zinc-400">
          {t("dash.income.note1")} <b className="text-zinc-600">{t("dash.income.myIncome")}</b>{" "}
          {t("dash.income.note2")}
        </p>
      </Card>
    </AppShell>
  );
}
