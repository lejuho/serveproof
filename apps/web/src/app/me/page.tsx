"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import * as QRCode from "qrcode";
import { api, ApiError, clearTokens, getToken } from "@/lib/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface Grant {
  id: string;
  purpose: string;
  level: string;
  expiresAt: string;
  revokedAt: string | null;
  reports: { id: string; status: string }[];
}

interface TimelineEntry {
  id: string;
  venue: { id: string; name: string };
  businessDate: string | null;
  role: string | null;
  earnedUsdCents: number;
  allocatedUsdCents: number;
  paidUsdCents: number;
  payrollReportedUsdCents: number;
  withholdingStatus: "UNKNOWN" | "PENDING" | "CONFIRMED";
  payoutRail: string | null;
  evidenceGrade: string;
  isCorrection: boolean;
  correctionReason: string | null;
}
interface Summary {
  totals: {
    earnedUsdCents: number;
    allocatedUsdCents: number;
    paidUsdCents: number;
    payrollReportedUsdCents: number;
  };
  shiftCount: number;
  avgMonthlyAllocatedUsdCents: number;
  payerCount: number;
  gradeCounts: Record<string, number>;
}
interface Alert {
  id: string;
  type: string;
  detail: Record<string, unknown>;
  createdAt: string;
}
interface Me {
  id: string;
  user: { email: string; displayName: string };
  wallets: { id: string; address: string; isDefault: boolean; status: string }[];
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const GRADE_STYLE: Record<string, string> = {
  A: "bg-emerald-100 text-emerald-800",
  B: "bg-blue-100 text-blue-800",
  C: "bg-amber-100 text-amber-800",
  D: "bg-orange-100 text-orange-800",
  E: "bg-red-100 text-red-700",
};

const WITHHOLDING_STYLE: Record<string, string> = {
  CONFIRMED: "bg-emerald-100 text-emerald-800",
  PENDING: "bg-blue-100 text-blue-800",
  UNKNOWN: "bg-zinc-100 text-zinc-600",
};

const ALERT_LABEL: Record<string, string> = {
  ALLOCATION_GAP: "배분 누락 — 근무는 있는데 배분이 없습니다",
  PAYOUT_GAP: "지급 대기 — 승인된 배분이 아직 지급되지 않았습니다",
  PAYROLL_GAP: "Payroll 미신고 — 지급은 됐지만 payroll에 반영되지 않았습니다",
  WITHHOLDING_UNKNOWN: "원천징수 미확인",
  REFUND_ADJUSTMENT_REQUIRED: "환불 반영 필요",
  UNMAPPED_WORKER: "외부 계정 미매핑",
};

export default function MyIncomePage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [level, setLevel] = useState("LEVEL_2");
  const [purpose, setPurpose] = useState("임대 계약 소득증명");
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [lastReportId, setLastReportId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    Promise.all([
      api<Me>("/workers/me"),
      api<TimelineEntry[]>("/workers/me/income-timeline"),
      api<Summary>("/workers/me/income-summary"),
      api<Alert[]>("/workers/me/discrepancies"),
      api<Grant[]>("/disclosures"),
    ])
      .then(([meData, timelineData, summaryData, alertData, grantData]) => {
        setMe(meData);
        setTimeline(timelineData);
        setSummary(summaryData);
        setAlerts(alertData);
        setGrants(grantData);
      })
      .catch(guard);
  }, [router, guard]);

  const refreshGrants = useCallback(() => {
    api<Grant[]>("/disclosures").then(setGrants).catch(guard);
  }, [guard]);

  /** Spec §26 steps 20–21 — create grant, issue report, render QR. */
  async function createDisclosure() {
    setBusy(true);
    setError(null);
    try {
      const now = new Date();
      const start = new Date(now);
      start.setMonth(start.getMonth() - 3); // 최근 3개월 (§26 step 20)
      const expiry = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      const created = await api<{ grant: { id: string }; shareUrl: string }>("/disclosures", {
        method: "POST",
        body: {
          purpose,
          level,
          dateRangeStart: start.toISOString(),
          dateRangeEnd: now.toISOString(),
          expiresAt: expiry.toISOString(),
          allowDownload: true,
          ...(level === "LEVEL_1" ? { thresholdUsdCents: 300000 } : {}),
        },
      });
      const issued = await api<{ report: { id: string } }>("/reports", {
        method: "POST",
        body: { disclosureGrantId: created.grant.id, shareUrl: created.shareUrl },
      });
      setShareUrl(created.shareUrl);
      setLastReportId(issued.report.id);
      setQrDataUrl(await QRCode.toDataURL(created.shareUrl, { width: 180, margin: 1 }));
      refreshGrants();
    } catch (e) {
      guard(e);
    } finally {
      setBusy(false);
    }
  }

  async function revokeGrant(grantId: string) {
    setBusy(true);
    try {
      await api(`/disclosures/${grantId}`, { method: "DELETE" });
      if (shareUrl) setShareUrl(null);
      setQrDataUrl(null);
      refreshGrants();
    } catch (e) {
      guard(e);
    } finally {
      setBusy(false);
    }
  }

  async function downloadPdf(reportId: string) {
    const res = await fetch(`${API_URL}/reports/${reportId}/pdf`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) {
      setError("PDF 다운로드 실패");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `serveproof-report-${reportId}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">내 소득</h1>
          {me && (
            <p className="text-sm text-zinc-500">
              {me.user.displayName} · {me.user.email}
            </p>
          )}
        </div>
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

      {/* Summary cards */}
      {summary && (
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-lg border border-zinc-200 bg-white p-4">
            <p className="text-xs text-zinc-500">확정 배분 총액</p>
            <p className="text-xl font-bold">{usd(summary.totals.allocatedUsdCents)}</p>
          </div>
          <div className="rounded-lg border border-zinc-200 bg-white p-4">
            <p className="text-xs text-zinc-500">실지급 총액</p>
            <p className="text-xl font-bold">{usd(summary.totals.paidUsdCents)}</p>
          </div>
          <div className="rounded-lg border border-zinc-200 bg-white p-4">
            <p className="text-xs text-zinc-500">월평균 배분</p>
            <p className="text-xl font-bold">{usd(summary.avgMonthlyAllocatedUsdCents)}</p>
          </div>
          <div className="rounded-lg border border-zinc-200 bg-white p-4">
            <p className="text-xs text-zinc-500">사업장 수 / 시프트</p>
            <p className="text-xl font-bold">
              {summary.payerCount} / {summary.shiftCount}
            </p>
          </div>
        </section>
      )}

      {/* Discrepancy alerts */}
      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="mb-2 font-semibold">알림 (Discrepancy)</h2>
        {alerts.length === 0 ? (
          <p className="text-sm text-zinc-500">모든 상태가 정상입니다.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {alerts.map((alert) => (
              <li key={alert.id} className="rounded-md bg-amber-50 px-3 py-2 text-sm">
                <b className="text-amber-800">{alert.type}</b>{" "}
                <span className="text-amber-700">{ALERT_LABEL[alert.type] ?? ""}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Shift timeline */}
      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="mb-2 font-semibold">시프트 타임라인</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-zinc-500">
                <th className="py-1 pr-2">날짜</th>
                <th className="py-1 pr-2">사업장</th>
                <th className="py-1 pr-2 text-right">배분</th>
                <th className="py-1 pr-2 text-right">지급</th>
                <th className="py-1 pr-2 text-right">Payroll 신고</th>
                <th className="py-1 pr-2">원천징수</th>
                <th className="py-1 pr-2">경로</th>
                <th className="py-1">등급</th>
              </tr>
            </thead>
            <tbody>
              {timeline.map((entry) => (
                <tr key={entry.id} className="border-b border-zinc-100">
                  <td className="py-2 pr-2">
                    {entry.businessDate}
                    {entry.isCorrection && (
                      <span
                        title={entry.correctionReason ?? ""}
                        className="ml-1 rounded bg-purple-100 px-1 text-xs text-purple-700"
                      >
                        정정
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-2">{entry.venue.name}</td>
                  <td className="py-2 pr-2 text-right font-mono">{usd(entry.allocatedUsdCents)}</td>
                  <td className="py-2 pr-2 text-right font-mono">{usd(entry.paidUsdCents)}</td>
                  <td className="py-2 pr-2 text-right font-mono">
                    {usd(entry.payrollReportedUsdCents)}
                  </td>
                  <td className="py-2 pr-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${WITHHOLDING_STYLE[entry.withholdingStatus]}`}
                    >
                      {entry.withholdingStatus}
                    </span>
                  </td>
                  <td className="py-2 pr-2 text-xs">{entry.payoutRail ?? "—"}</td>
                  <td className="py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-bold ${GRADE_STYLE[entry.evidenceGrade] ?? "bg-zinc-100"}`}
                    >
                      {entry.evidenceGrade}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Selective disclosure (spec §20–21, §26 steps 20–22) */}
      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="mb-2 font-semibold">소득증명 공유</h2>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="공개 목적"
          />
          <select
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
          >
            <option value="LEVEL_1">LEVEL 1 — 조건 충족 여부만 (월 $3,000 이상)</option>
            <option value="LEVEL_2">LEVEL 2 — 월평균·payer 수·등급</option>
            <option value="LEVEL_3">LEVEL 3 — 시프트별 상세</option>
          </select>
          <button
            onClick={createDisclosure}
            disabled={busy}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            최근 3개월 보고서 발급
          </button>
        </div>

        {shareUrl && (
          <div className="mt-3 flex items-start gap-4 rounded-md bg-emerald-50 p-3">
            {qrDataUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qrDataUrl} alt="verification QR" className="h-36 w-36" />
            )}
            <div className="text-sm">
              <p className="font-semibold text-emerald-800">공유 링크 (지금 한 번만 표시됩니다)</p>
              <a
                href={shareUrl}
                target="_blank"
                rel="noreferrer"
                className="break-all text-emerald-700 underline"
              >
                {shareUrl}
              </a>
              {lastReportId && (
                <p className="mt-2">
                  <button
                    onClick={() => downloadPdf(lastReportId)}
                    className="rounded-md bg-emerald-700 px-3 py-1 text-xs text-white"
                  >
                    PDF 다운로드
                  </button>
                </p>
              )}
            </div>
          </div>
        )}

        {grants.length > 0 && (
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {grants.map((grant) => (
              <li
                key={grant.id}
                className="flex items-center justify-between rounded-md border border-zinc-100 px-3 py-2"
              >
                <span>
                  <b>{grant.level}</b> · {grant.purpose} · 만료 {grant.expiresAt.slice(0, 10)}
                  {grant.revokedAt && (
                    <span className="ml-2 rounded bg-red-100 px-1.5 text-xs text-red-700">
                      철회됨
                    </span>
                  )}
                  {!grant.revokedAt && grant.reports[0] && (
                    <span className="ml-2 rounded bg-zinc-100 px-1.5 text-xs text-zinc-600">
                      {grant.reports[0].status}
                    </span>
                  )}
                </span>
                <span className="flex gap-2">
                  {!grant.revokedAt && grant.reports[0] && (
                    <button
                      onClick={() => downloadPdf(grant.reports[0]!.id)}
                      className="rounded-md bg-zinc-600 px-2 py-1 text-xs text-white"
                    >
                      PDF
                    </button>
                  )}
                  {!grant.revokedAt && (
                    <button
                      onClick={() => revokeGrant(grant.id)}
                      disabled={busy}
                      className="rounded-md bg-red-600 px-2 py-1 text-xs text-white disabled:opacity-50"
                    >
                      철회
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Wallets */}
      {me && (
        <section className="rounded-lg border border-zinc-200 bg-white p-4">
          <h2 className="mb-2 font-semibold">수취 지갑</h2>
          {me.wallets.length === 0 ? (
            <p className="text-sm text-zinc-500">연결된 지갑이 없습니다.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {me.wallets.map((wallet) => (
                <li key={wallet.id} className="flex items-center gap-2">
                  <code className="text-xs">
                    {wallet.address.slice(0, 8)}…{wallet.address.slice(-6)}
                  </code>
                  {wallet.isDefault && (
                    <span className="rounded bg-emerald-100 px-1.5 text-xs text-emerald-700">
                      기본
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
