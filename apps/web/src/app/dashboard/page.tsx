"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, clearTokens, getToken } from "@/lib/api";
import { signTransactionBase64 } from "@/lib/wallet";

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
  worker: { user: { displayName: string } };
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
  status: string;
  txSignature: string | null;
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const STATUS_STYLE: Record<string, string> = {
  CALCULATED: "bg-blue-100 text-blue-800",
  REVIEW_REQUIRED: "bg-amber-100 text-amber-800",
  PAYABLE: "bg-green-100 text-green-800",
  PARTIALLY_PAID: "bg-emerald-100 text-emerald-800",
  PAID: "bg-emerald-200 text-emerald-900",
  DRAFT: "bg-zinc-100 text-zinc-600",
  UNPAID: "bg-zinc-100 text-zinc-600",
  PENDING: "bg-blue-100 text-blue-800",
  FAILED: "bg-red-100 text-red-700",
};

export default function DashboardPage() {
  const router = useRouter();
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [venueId, setVenueId] = useState<string>("");
  const [csvText, setCsvText] = useState("");
  const [importResult, setImportResult] = useState<ImportSummary | null>(null);
  const [unmapped, setUnmapped] = useState<UnmappedResponse | null>(null);
  const [businessDate, setBusinessDate] = useState("2026-08-05");
  const [batch, setBatch] = useState<Batch | null>(null);
  const [payoutProgress, setPayoutProgress] = useState<Record<string, string>>({});
  const [rebuildResult, setRebuildResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const guard = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) {
        clearTokens();
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
    api<Organization[]>("/organizations/mine")
      .then((data) => {
        setOrgs(data);
        const firstVenue = data.flatMap((o) => o.venues)[0];
        if (firstVenue) setVenueId(firstVenue.id);
      })
      .catch(guard);
  }, [router, guard]);

  const refreshUnmapped = useCallback(() => {
    if (!venueId) return;
    api<UnmappedResponse>(`/venues/${venueId}/unmapped-workers`).then(setUnmapped).catch(guard);
  }, [venueId, guard]);

  useEffect(() => {
    refreshUnmapped();
    setBatch(null);
    setImportResult(null);
    setRebuildResult(null);
  }, [venueId, refreshUnmapped]);

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

  const importCsv = () =>
    run(async () => {
      const result = await api<ImportSummary>("/providers/csv/import", {
        method: "POST",
        body: { venueId, csvText },
      });
      setImportResult(result);
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
    });

  const setProgress = (allocationId: string, message: string) =>
    setPayoutProgress((prev) => ({ ...prev, [allocationId]: message }));

  /** Spec §29.4 flow: create → unsigned tx → wallet signs → submit → poll. */
  const payUsdc = (allocationId: string) =>
    run(async () => {
      setProgress(allocationId, "payout 생성 중…");
      const payout = await api<Payout>("/payouts", { method: "POST", body: { allocationId } });

      setProgress(allocationId, "트랜잭션 생성 중…");
      const tx = await api<{ transactionBase64: string; signer: string }>(
        `/payouts/${payout.id}/transaction`,
      );

      setProgress(allocationId, "지갑 서명 대기…");
      const signed = await signTransactionBase64(tx.transactionBase64, tx.signer);

      setProgress(allocationId, "제출 중…");
      await api(`/payouts/${payout.id}/submit`, {
        method: "POST",
        body: { signedTransactionBase64: signed },
      });

      for (let i = 0; i < 30; i++) {
        const current = await api<Payout>(`/payouts/${payout.id}`);
        setProgress(allocationId, `온체인 ${current.status}`);
        if (["FINALIZED", "FAILED"].includes(current.status)) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
      await refreshBatch();
    });

  const payLegacy = (allocationId: string) =>
    run(async () => {
      const reference = window.prompt("지급 증빙 reference (예: payroll run ID)");
      if (!reference) return;
      await api("/payouts/legacy-evidence", {
        method: "POST",
        body: { allocationId, rail: "PAYROLL", externalReference: reference },
      });
      setProgress(allocationId, "legacy 증빙 등록됨 (PAYROLL)");
      await refreshBatch();
    });

  const rebuildIncome = () =>
    run(async () => {
      const result = await api<{ entriesUpserted: number; alerts: number }>(
        `/venues/${venueId}/income/rebuild`,
        { method: "POST", body: {} },
      );
      setRebuildResult(
        `IncomeEntry ${result.entriesUpserted}건 재계산, discrepancy 경고 ${result.alerts}건`,
      );
    });

  const payable = batch && ["PAYABLE", "PARTIALLY_PAID", "PAID"].includes(batch.status);

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Venue Dashboard</h1>
        <button
          onClick={() => {
            clearTokens();
            router.push("/login");
          }}
          className="text-sm text-zinc-500 underline"
        >
          로그아웃
        </button>
      </header>

      {error && <p className="rounded-md bg-red-100 px-3 py-2 text-sm text-red-700">{error}</p>}

      {/* Venue picker */}
      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="mb-2 font-semibold">사업장</h2>
        <select
          className="w-full rounded-md border border-zinc-300 px-3 py-2"
          value={venueId}
          onChange={(e) => setVenueId(e.target.value)}
        >
          {orgs.flatMap((org) =>
            org.venues.map((v) => (
              <option key={v.id} value={v.id}>
                {org.displayName} — {v.name}
              </option>
            )),
          )}
        </select>
      </section>

      {/* CSV import */}
      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="mb-2 font-semibold">1. CSV Import</h2>
        <textarea
          className="h-28 w-full rounded-md border border-zinc-300 p-2 font-mono text-xs"
          placeholder="provider,venue_external_id,worker_external_id,..."
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
        />
        <button
          onClick={importCsv}
          disabled={busy || !csvText || !venueId}
          className="mt-2 rounded-md bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          Import
        </button>
        {importResult && (
          <p className="mt-2 text-sm text-zinc-600">
            팁 {importResult.tipsUpserted}건, 시프트 {importResult.shiftsUpserted}건 (매핑{" "}
            {importResult.mappedShifts} / 미매핑 {importResult.unmappedShifts})
          </p>
        )}
      </section>

      {/* Worker mapping */}
      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="mb-2 font-semibold">2. Worker Mapping</h2>
        {unmapped && unmapped.pendingMappings.length === 0 && (
          <p className="text-sm text-zinc-500">확인 대기 중인 매핑이 없습니다.</p>
        )}
        <ul className="flex flex-col gap-2">
          {unmapped?.pendingMappings.map((m) => (
            <li
              key={m.id}
              className="flex items-center justify-between rounded-md bg-amber-50 px-3 py-2 text-sm"
            >
              <span>
                <b>{m.externalWorkerId}</b> ({m.provider}) → {m.worker.user.displayName}
              </span>
              <button
                onClick={() => verifyMapping(m.id)}
                disabled={busy}
                className="rounded-md bg-amber-600 px-3 py-1 text-white disabled:opacity-50"
              >
                매핑 확정
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* Allocation */}
      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="mb-2 font-semibold">3. 배분 계산 · 승인</h2>
        <div className="flex items-center gap-2">
          <input
            type="date"
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
            value={businessDate}
            onChange={(e) => setBusinessDate(e.target.value)}
          />
          <button
            onClick={calculate}
            disabled={busy || !venueId}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            계산
          </button>
          <button
            onClick={approve}
            disabled={busy || batch?.status !== "CALCULATED"}
            className="rounded-md bg-green-700 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            승인
          </button>
        </div>

        {batch && (
          <div className="mt-4 flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_STYLE[batch.status] ?? "bg-zinc-100"}`}
              >
                {batch.status}
              </span>
              <span className="text-sm text-zinc-600">
                {batch.businessDate} · 정책 v{batch.policyVersion} · 팁 풀{" "}
                <b>{usd(batch.tipPoolAmountUsdCents)}</b>
              </span>
            </div>
            {batch.reviewIssues.length > 0 && (
              <ul className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">
                {batch.reviewIssues.map((issue, i) => (
                  <li key={i}>
                    {issue.blocking ? "⛔" : "ℹ️"} {issue.code} {JSON.stringify(issue.detail)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* Payouts (spec §12, §29.4 — venue wallet signs in the browser) */}
      {batch && payable && (
        <section className="rounded-lg border border-zinc-200 bg-white p-4">
          <h2 className="mb-2 font-semibold">4. 지급 (Payout)</h2>
          <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            USDC 지급은 Devnet 테스트 토큰(tUSDC)이며 화폐 가치가 없습니다. venue signer 지갑으로
            서명해야 합니다.
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-zinc-500">
                <th className="py-1">Worker</th>
                <th className="py-1 text-right">배분액</th>
                <th className="py-1">상태</th>
                <th className="py-1">액션</th>
              </tr>
            </thead>
            <tbody>
              {batch.allocations.map((a) => (
                <tr key={a.id} className="border-b border-zinc-100">
                  <td className="py-2">{a.worker.user.displayName}</td>
                  <td className="py-2 text-right font-mono">{usd(a.netAllocatedUsdCents)}</td>
                  <td className="py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[a.payoutStatus] ?? "bg-zinc-100"}`}
                    >
                      {a.payoutStatus}
                      {a.payoutRail ? ` · ${a.payoutRail}` : ""}
                    </span>
                    {payoutProgress[a.id] && (
                      <span className="ml-2 text-xs text-zinc-500">{payoutProgress[a.id]}</span>
                    )}
                  </td>
                  <td className="py-2">
                    {a.payoutStatus !== "PAID" && (
                      <span className="flex gap-2">
                        <button
                          onClick={() => payUsdc(a.id)}
                          disabled={busy}
                          className="rounded-md bg-violet-700 px-3 py-1 text-xs text-white disabled:opacity-50"
                        >
                          USDC 지급 (지갑 서명)
                        </button>
                        <button
                          onClick={() => payLegacy(a.id)}
                          disabled={busy}
                          className="rounded-md bg-zinc-600 px-3 py-1 text-xs text-white disabled:opacity-50"
                        >
                          Legacy 증빙
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Observability */}
      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="mb-2 font-semibold">5. Income Observability</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={rebuildIncome}
            disabled={busy || !venueId}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            IncomeEntry 재계산
          </button>
          {rebuildResult && <span className="text-sm text-zinc-600">{rebuildResult}</span>}
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          지급·payroll 변경 후 실행하면 시프트별 earned→allocated→paid→payroll 상태와 discrepancy
          경고가 갱신됩니다. 노동자는 <b>내 소득</b> 화면에서 자기 상태를 확인합니다.
        </p>
      </section>
    </main>
  );
}
