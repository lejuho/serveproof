"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import * as QRCode from "qrcode";
import { api, ApiError, clearTokens, getToken } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import {
  AppShell,
  Badge,
  Button,
  Callout,
  Card,
  inputClass,
  StatCard,
  tableCellClass,
  tableHeadClass,
} from "@/components/ui";

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
  payoutTxSignature: string | null;
  evidenceGrade: string;
  ingestSource: "CSV_UPLOAD" | "PROVIDER_API" | null;
  isCorrection: boolean;
  correctionReason: string | null;
}

function SourceBadge({ ingestSource, t }: { ingestSource: string | null; t: (k: string) => string }) {
  const pos = ingestSource === "PROVIDER_API";
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
        pos ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-500"
      }`}
    >
      {pos ? t("me.source.pos") : t("me.source.self")}
    </span>
  );
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

export default function MyIncomePage() {
  const { t } = useI18n();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [level, setLevel] = useState("LEVEL_2");
  const [purpose, setPurpose] = useState("임대 계약 소득증명");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [emailStatus, setEmailStatus] = useState<"sent" | "failed" | null>(null);
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

      // 발급까지 서버가 한 호출로 처리 — 수신자 이메일이 미발급 링크를 받는 틈이 없다
      const created = await api<{
        grant: { id: string };
        report: { id: string };
        shareUrl: string;
        emailSent?: boolean;
      }>("/disclosures", {
        method: "POST",
        body: {
          purpose,
          level,
          dateRangeStart: start.toISOString(),
          dateRangeEnd: now.toISOString(),
          expiresAt: expiry.toISOString(),
          allowDownload: true,
          autoIssue: true,
          ...(level === "LEVEL_1" ? { thresholdUsdCents: 300000 } : {}),
          ...(recipientEmail.trim() ? { recipientEmail: recipientEmail.trim() } : {}),
        },
      });
      setEmailStatus(
        created.emailSent === undefined ? null : created.emailSent ? "sent" : "failed",
      );
      setShareUrl(created.shareUrl);
      setLastReportId(created.report.id);
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
      setError(t("me.share.pdfFail"));
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
    <AppShell
      wide
      title={t("me.title")}
      subtitle={me ? `${me.user.displayName} · ${me.user.email}` : undefined}
      right={
        <button
          onClick={() => {
            clearTokens();
            router.push("/login");
          }}
          className="text-sm font-medium text-zinc-400 hover:text-zinc-600"
        >
          {t("logout")}
        </button>
      }
    >
      {error && <Callout tone="red">{error}</Callout>}

      {me &&
        me.wallets.length === 0 &&
        timeline.some((e) => e.payoutRail === "USDC" || e.allocatedUsdCents > e.paidUsdCents) && (
          <Callout tone="amber">
            {t("me.banner.noWallet")}{" "}
            <button
              type="button"
              onClick={() =>
                document
                  .getElementById("card-wallet")
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
              className="font-semibold underline underline-offset-2 hover:opacity-80"
            >
              {t("me.banner.goConnect")} →
            </button>
          </Callout>
        )}

      {summary && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label={t("me.stat.allocated")} value={usd(summary.totals.allocatedUsdCents)} />
          <StatCard label={t("me.stat.paid")} value={usd(summary.totals.paidUsdCents)} />
          <StatCard label={t("me.stat.avg")} value={usd(summary.avgMonthlyAllocatedUsdCents)} />
          <StatCard
            label={t("me.stat.payers")}
            value={`${summary.payerCount} · ${summary.shiftCount}`}
            hint="payer count · shifts"
          />
        </div>
      )}

      <Card title={t("me.alerts.title")} description={t("me.alerts.desc")}>
        {alerts.length === 0 ? (
          <p className="text-sm text-zinc-400">{t("me.alerts.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {alerts.map((alert) => (
              <li
                key={alert.id}
                className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3"
              >
                <Badge tone="REVIEW_REQUIRED">{alert.type}</Badge>
                <span className="text-sm text-amber-800">{t(`alert.${alert.type}`)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t("me.timeline.title")} description={t("me.timeline.desc")}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className={tableHeadClass}>{t("me.col.date")}</th>
                <th className={tableHeadClass}>{t("me.col.venue")}</th>
                <th className={`${tableHeadClass} text-right`}>{t("me.col.allocated")}</th>
                <th className={`${tableHeadClass} text-right`}>{t("me.col.paid")}</th>
                <th className={`${tableHeadClass} text-right`}>{t("me.col.payroll")}</th>
                <th className={tableHeadClass}>{t("me.col.withholding")}</th>
                <th className={tableHeadClass}>{t("me.col.rail")}</th>
                <th className={tableHeadClass}>{t("me.col.source")}</th>
                <th className={tableHeadClass}>{t("me.col.grade")}</th>
              </tr>
            </thead>
            <tbody>
              {timeline.map((entry) => (
                <tr key={entry.id}>
                  <td className={`${tableCellClass} whitespace-nowrap font-medium text-zinc-900`}>
                    {entry.businessDate}
                    {entry.isCorrection && (
                      <span
                        title={entry.correctionReason ?? ""}
                        className="ml-1.5 rounded bg-purple-100 px-1.5 py-0.5 text-xs font-semibold text-purple-700"
                      >
                        {t("me.corrected")}
                      </span>
                    )}
                  </td>
                  <td className={tableCellClass}>{entry.venue.name}</td>
                  <td className={`${tableCellClass} text-right font-semibold tabular-nums`}>
                    {usd(entry.allocatedUsdCents)}
                  </td>
                  <td className={`${tableCellClass} text-right font-semibold tabular-nums`}>
                    {usd(entry.paidUsdCents)}
                  </td>
                  <td className={`${tableCellClass} text-right tabular-nums`}>
                    {usd(entry.payrollReportedUsdCents)}
                  </td>
                  <td className={tableCellClass}>
                    <Badge tone={entry.withholdingStatus}>{entry.withholdingStatus}</Badge>
                  </td>
                  <td className={`${tableCellClass} text-sm text-zinc-500`}>
                    {entry.payoutRail === "USDC" && entry.payoutTxSignature ? (
                      <a
                        href={`https://explorer.solana.com/tx/${entry.payoutTxSignature}?cluster=devnet`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-violet-600 underline underline-offset-2 hover:text-violet-800"
                        title={t("me.explorer.title")}
                      >
                        USDC ↗
                      </a>
                    ) : (
                      (entry.payoutRail ?? "—")
                    )}
                  </td>
                  <td className={tableCellClass}>
                    <SourceBadge ingestSource={entry.ingestSource} t={t} />
                  </td>
                  <td className={tableCellClass}>
                    <Badge tone={entry.evidenceGrade}>{entry.evidenceGrade}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={t("me.share.title")} description={t("me.share.desc")}>
        <div className="flex flex-wrap items-center gap-3">
          <select
            className={`${inputClass} w-auto`}
            defaultValue=""
            onChange={(e) => {
              // 용도 프리셋 — 수준·목적을 실사용 시나리오로 한 번에 세팅
              const preset = e.target.value;
              if (preset === "rent") {
                setLevel("LEVEL_1");
                setPurpose(t("me.share.preset.rent.purpose"));
              } else if (preset === "loan") {
                setLevel("LEVEL_2");
                setPurpose(t("me.share.preset.loan.purpose"));
              } else if (preset === "tax") {
                setLevel("LEVEL_3");
                setPurpose(t("me.share.preset.tax.purpose"));
              }
            }}
          >
            <option value="">{t("me.share.preset.custom")}</option>
            <option value="rent">{t("me.share.preset.rent")}</option>
            <option value="loan">{t("me.share.preset.loan")}</option>
            <option value="tax">{t("me.share.preset.tax")}</option>
          </select>
          <input
            className={`${inputClass} w-auto min-w-52`}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder={t("me.share.purpose")}
          />
          <select
            className={`${inputClass} w-auto`}
            value={level}
            onChange={(e) => setLevel(e.target.value)}
          >
            <option value="LEVEL_1">{t("me.share.l1")}</option>
            <option value="LEVEL_2">{t("me.share.l2")}</option>
            <option value="LEVEL_3">{t("me.share.l3")}</option>
          </select>
          <input
            className={`${inputClass} w-auto min-w-56`}
            type="email"
            value={recipientEmail}
            onChange={(e) => setRecipientEmail(e.target.value)}
            placeholder={t("me.share.recipient")}
          />
          <Button onClick={createDisclosure} disabled={busy}>
            {t("me.share.issue")}
          </Button>
        </div>
        {emailStatus && (
          <p
            className={`mt-3 rounded-lg px-3.5 py-2.5 text-sm ${
              emailStatus === "sent"
                ? "border border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border border-red-200 bg-red-50 text-red-700"
            }`}
          >
            {emailStatus === "sent" ? t("me.share.emailSent") : t("me.share.emailFailed")}
          </p>
        )}

        {shareUrl && (
          <div className="mt-4 flex items-start gap-5 rounded-xl border border-emerald-200 bg-emerald-50/70 p-5">
            {qrDataUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrDataUrl}
                alt="verification QR"
                className="h-36 w-36 rounded-lg border border-emerald-200 bg-white p-1.5"
              />
            )}
            <div className="text-sm">
              <p className="font-semibold text-emerald-800">{t("me.share.linkOnce")}</p>
              <a
                href={shareUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 block break-all text-emerald-700 underline underline-offset-2"
              >
                {shareUrl}
              </a>
              {lastReportId && (
                <div className="mt-3">
                  <Button size="sm" onClick={() => downloadPdf(lastReportId)}>
                    {t("me.share.pdf")}
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        {grants.length > 0 && (
          <ul className="mt-4 flex flex-col gap-2">
            {grants.map((grant) => (
              <li
                key={grant.id}
                className="flex items-center justify-between rounded-xl border border-zinc-200 px-4 py-3"
              >
                <span className="flex items-center gap-2.5 text-[15px]">
                  <Badge>{grant.level}</Badge>
                  <span className="text-zinc-700">{grant.purpose}</span>
                  <span className="text-sm text-zinc-400">
                    {t("me.share.expires")} {grant.expiresAt.slice(0, 10)}
                  </span>
                  {grant.revokedAt && <Badge tone="FAILED">{t("me.share.revoked")}</Badge>}
                  {!grant.revokedAt && grant.reports[0] && (
                    <Badge tone={grant.reports[0].status}>{grant.reports[0].status}</Badge>
                  )}
                </span>
                <span className="flex gap-2">
                  {!grant.revokedAt && grant.reports[0] && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => downloadPdf(grant.reports[0]!.id)}
                    >
                      PDF
                    </Button>
                  )}
                  {!grant.revokedAt && (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => revokeGrant(grant.id)}
                      disabled={busy}
                    >
                      {t("me.share.revoke")}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div id="card-wallet" className="scroll-mt-6" />
      {me && (
        <Card title={t("me.wallet.title")} description={t("me.wallet.desc")}>
          {me.wallets.length === 0 ? (
            <p className="text-sm text-zinc-400">{t("me.wallet.empty")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {me.wallets.map((wallet) => (
                <li key={wallet.id} className="flex items-center gap-3">
                  <code className="rounded-lg bg-zinc-100 px-2.5 py-1 text-sm text-zinc-600">
                    {wallet.address.slice(0, 8)}…{wallet.address.slice(-6)}
                  </code>
                  {wallet.isDefault && <Badge tone="CONFIRMED">{t("me.wallet.default")}</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </AppShell>
  );
}
