"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import * as QRCode from "qrcode";
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
import { useI18n } from "@/lib/i18n";
import { connectWallet } from "@/lib/wallet";
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
import { VenueConnectionCards, type VenueConnection } from "@/components/venue-connection-cards";

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

function SourceBadge({
  ingestSource,
  t,
}: {
  ingestSource: string | null;
  t: (k: string) => string;
}) {
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

function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  if (!domain) return "***";
  const visible = local.slice(0, Math.min(2, local.length));
  return visible + "*".repeat(Math.max(3, local.length - visible.length)) + "@" + domain;
}

export default function MyIncomePage() {
  const { locale, t } = useI18n();
  const statusLabel = (value: string) => {
    if (locale !== "ko") return value;
    const labels: Record<string, string> = {
      UNKNOWN: "확인 전",
      PENDING: "확인 중",
      CONFIRMED: "확인됨",
      ACTIVE: "사용 중",
      REVOKED: "철회됨",
      ISSUED: "발급 완료",
      FAILED: "실패",
      LEVEL_1: "1단계",
      LEVEL_2: "2단계",
      LEVEL_3: "3단계",
    };
    return labels[value] ?? value;
  };
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [venueConnections, setVenueConnections] = useState<VenueConnection[]>([]);
  const [level, setLevel] = useState("LEVEL_2");
  const [purposeKey, setPurposeKey] = useState("me.share.preset.rent.purpose");
  const [customPurpose, setCustomPurpose] = useState<string | null>(null);
  const [selectedPreset, setSelectedPreset] = useState("rent");
  const [rangeMonths, setRangeMonths] = useState("3");
  const [expiresInDays, setExpiresInDays] = useState("7");
  const [thresholdUsd, setThresholdUsd] = useState("3000");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [emailStatus, setEmailStatus] = useState<"sent" | "failed" | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [lastReportId, setLastReportId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availableModes, setAvailableModes] = useState<AppMode[]>([]);
  const purpose = customPurpose ?? t(purposeKey);

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
    Promise.all([
      api<Me>("/workers/me"),
      api<TimelineEntry[]>("/workers/me/income-timeline"),
      api<Summary>("/workers/me/income-summary"),
      api<Alert[]>("/workers/me/discrepancies"),
      api<Grant[]>("/disclosures"),
      api<VenueConnection[]>("/workers/me/venue-connections"),
    ])
      .then(([meData, timelineData, summaryData, alertData, grantData, connectionData]) => {
        setAvailableModes(getCurrentSession()?.modes ?? []);
        setMe(meData);
        setTimeline(timelineData);
        setSummary(summaryData);
        setAlerts(alertData);
        setGrants(grantData);
        setVenueConnections(connectionData);
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
      const end = new Date(now);
      if (rangeMonths === "ytd") {
        start.setMonth(0, 1);
        start.setHours(0, 0, 0, 0);
      } else if (rangeMonths === "lastYear") {
        start.setFullYear(now.getFullYear() - 1, 0, 1);
        start.setHours(0, 0, 0, 0);
        end.setFullYear(now.getFullYear() - 1, 11, 31);
        end.setHours(23, 59, 59, 999);
      } else {
        start.setMonth(start.getMonth() - Number(rangeMonths));
      }
      const expiry = new Date(now.getTime() + Number(expiresInDays) * 24 * 60 * 60 * 1000);

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
          dateRangeEnd: end.toISOString(),
          expiresAt: expiry.toISOString(),
          allowDownload: true,
          autoIssue: true,
          ...(level === "LEVEL_1"
            ? { thresholdUsdCents: Math.round(Number(thresholdUsd) * 100) }
            : {}),
          ...(recipientEmail.trim() ? { recipientEmail: recipientEmail.trim() } : {}),
        },
      });
      setEmailStatus(
        created.emailSent === undefined ? null : created.emailSent ? "sent" : "failed",
      );
      setShareUrl(created.shareUrl);
      setCopied(false);
      setLastReportId(created.report.id);
      setQrDataUrl(await QRCode.toDataURL(created.shareUrl, { width: 180, margin: 1 }));
      refreshGrants();
    } catch (e) {
      guard(e);
    } finally {
      setBusy(false);
    }
  }

  /** Phantom/Solflare 연결 → 주소를 수취 지갑으로 등록 (첫 지갑은 자동 기본 지정). */
  async function registerWallet() {
    setBusy(true);
    setError(null);
    try {
      const address = await connectWallet();
      await api("/workers/me/wallets", { method: "POST", body: { address } });
      setMe(await api<Me>("/workers/me"));
      setVenueConnections(await api<VenueConnection[]>("/workers/me/venue-connections"));
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

  async function copyShareLink() {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  const presetOptions = [
    {
      value: "rent",
      label: t("me.share.preset.rent"),
      description: t("me.share.preset.rent.hint"),
      audience: t("me.share.preset.rent.audience"),
      level: "LEVEL_2",
      range: "3",
      expiry: "7",
      purposeKey: "me.share.preset.rent.purpose",
      primary: true,
    },
    {
      value: "benefits",
      label: t("me.share.preset.benefits"),
      description: t("me.share.preset.benefits.hint"),
      audience: t("me.share.preset.benefits.audience"),
      level: "LEVEL_3",
      range: "1",
      expiry: "30",
      purposeKey: "me.share.preset.benefits.purpose",
      primary: true,
    },
    {
      value: "housing",
      label: t("me.share.preset.housing"),
      description: t("me.share.preset.housing.hint"),
      audience: t("me.share.preset.housing.audience"),
      level: "LEVEL_3",
      range: "3",
      expiry: "30",
      purposeKey: "me.share.preset.housing.purpose",
      primary: true,
    },
    {
      value: "auto",
      label: t("me.share.preset.auto"),
      description: t("me.share.preset.auto.hint"),
      audience: t("me.share.preset.auto.audience"),
      level: "LEVEL_2",
      range: "3",
      expiry: "7",
      purposeKey: "me.share.preset.auto.purpose",
      primary: false,
    },
    {
      value: "mortgage",
      label: t("me.share.preset.mortgage"),
      description: t("me.share.preset.mortgage.hint"),
      audience: t("me.share.preset.mortgage.audience"),
      level: "LEVEL_2",
      range: "12",
      expiry: "30",
      purposeKey: "me.share.preset.mortgage.purpose",
      primary: false,
    },
    {
      value: "marketplace",
      label: t("me.share.preset.marketplace"),
      description: t("me.share.preset.marketplace.hint"),
      audience: t("me.share.preset.marketplace.audience"),
      level: "LEVEL_2",
      range: "ytd",
      expiry: "30",
      purposeKey: "me.share.preset.marketplace.purpose",
      primary: false,
    },
    {
      value: "immigration",
      label: t("me.share.preset.immigration"),
      description: t("me.share.preset.immigration.hint"),
      audience: t("me.share.preset.immigration.audience"),
      level: "LEVEL_3",
      range: "6",
      expiry: "30",
      purposeKey: "me.share.preset.immigration.purpose",
      primary: false,
    },
    {
      value: "tax",
      label: t("me.share.preset.tax"),
      description: t("me.share.preset.tax.hint"),
      audience: t("me.share.preset.tax.audience"),
      level: "LEVEL_3",
      range: "lastYear",
      expiry: "30",
      purposeKey: "me.share.preset.tax.purpose",
      primary: false,
    },
  ];
  const levelOptions = [
    { value: "LEVEL_1", title: t("me.share.l1.title"), detail: t("me.share.l1.detail") },
    { value: "LEVEL_2", title: t("me.share.l2.title"), detail: t("me.share.l2.detail") },
    { value: "LEVEL_3", title: t("me.share.l3.title"), detail: t("me.share.l3.detail") },
  ];
  const chosenLevel = levelOptions.find((option) => option.value === level)!;
  const chosenPreset = presetOptions.find((option) => option.value === selectedPreset);
  const invalidEmail = recipientEmail.length > 0 && !/^\S+@\S+\.\S+$/.test(recipientEmail);
  const invalidThreshold =
    level === "LEVEL_1" && (!Number.isFinite(Number(thresholdUsd)) || Number(thresholdUsd) <= 0);

  function selectPreset(preset: (typeof presetOptions)[number]) {
    setSelectedPreset(preset.value);
    setLevel(preset.level);
    setPurposeKey(preset.purposeKey);
    setCustomPurpose(null);
    setRangeMonths(preset.range);
    setExpiresInDays(preset.expiry);
  }

  return (
    <AppShell
      wide
      title={t("me.title")}
      subtitle={me ? `${me.user.displayName} · ${maskEmail(me.user.email)}` : undefined}
      right={
        <span className="flex items-center gap-3">
          {availableModes.includes("staff") && (
            <button
              type="button"
              onClick={() => {
                const destination = switchAppMode("staff");
                if (destination) router.push(destination);
              }}
              className="text-sm font-medium text-emerald-700 hover:text-emerald-800"
            >
              {t("auth.viewAsStaff")}
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
        </span>
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
            hint={locale === "ko" ? "사업장 수 · 근무 건수" : "payer count · shifts"}
          />
        </div>
      )}

      <VenueConnectionCards connections={venueConnections} locale={locale} />

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
                <Badge tone="REVIEW_REQUIRED">{t(`alert.label.${alert.type}`)}</Badge>
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
                    <Badge tone={entry.withholdingStatus}>
                      {statusLabel(entry.withholdingStatus)}
                    </Badge>
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
                      (entry.payoutRail ?? (locale === "ko" ? "없음" : "Not available"))
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
        <div className="mb-6 flex flex-wrap items-center gap-2 border-b border-zinc-100 pb-5 text-xs font-medium text-zinc-500">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1.5 text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {t("me.share.private")}
          </span>
          <span>·</span>
          <span>{t(`me.share.range.${rangeMonths}`)}</span>
          <span>·</span>
          <span>{t("me.share.expiresIn").replace("{days}", expiresInDays)}</span>
        </div>

        <div className="mb-6 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm leading-relaxed text-blue-900">
          <span className="font-semibold">{t("me.share.supplement.title")}</span>{" "}
          {t("me.share.supplement.detail")}
        </div>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-8">
            <fieldset>
              <legend className="text-sm font-semibold text-zinc-900">
                <span className="mr-2 text-emerald-600">1</span>
                {t("me.share.forWhat")}
              </legend>
              <p className="mt-1 text-sm text-zinc-500">{t("me.share.forWhatHint")}</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {presetOptions
                  .filter((preset) => preset.primary)
                  .map((preset, index) => (
                    <button
                      key={preset.value}
                      type="button"
                      aria-pressed={selectedPreset === preset.value}
                      onClick={() => selectPreset(preset)}
                      className={`rounded-xl border p-3.5 text-left transition ${
                        selectedPreset === preset.value
                          ? "border-emerald-500 bg-emerald-50/70 ring-1 ring-emerald-500"
                          : "border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50"
                      }`}
                    >
                      <span className="mb-2 inline-flex rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-bold text-zinc-500">
                        {index + 1} · {t("me.share.priority")}
                      </span>
                      <span className="block text-sm font-semibold text-zinc-900">
                        {preset.label}
                      </span>
                      <span className="mt-1 block text-xs leading-relaxed text-zinc-500">
                        {preset.description}
                      </span>
                    </button>
                  ))}
              </div>
              <details className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50/70 open:bg-white">
                <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-zinc-700 marker:hidden">
                  <span className="flex items-center justify-between">
                    {t("me.share.moreUses")}
                    <span aria-hidden className="text-zinc-400">
                      ＋
                    </span>
                  </span>
                </summary>
                <div className="grid gap-2 border-t border-zinc-200 p-3 sm:grid-cols-2">
                  {presetOptions
                    .filter((preset) => !preset.primary)
                    .map((preset) => (
                      <button
                        key={preset.value}
                        type="button"
                        aria-pressed={selectedPreset === preset.value}
                        onClick={() => selectPreset(preset)}
                        className={`rounded-lg border p-3 text-left transition ${
                          selectedPreset === preset.value
                            ? "border-emerald-500 bg-emerald-50 ring-1 ring-emerald-500"
                            : "border-zinc-200 bg-white hover:border-zinc-300"
                        }`}
                      >
                        <span className="block text-sm font-semibold text-zinc-900">
                          {preset.label}
                        </span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-zinc-500">
                          {preset.description}
                        </span>
                      </button>
                    ))}
                  <button
                    type="button"
                    aria-pressed={selectedPreset === "custom"}
                    onClick={() => {
                      setSelectedPreset("custom");
                      setCustomPurpose("");
                    }}
                    className={`rounded-lg border p-3 text-left transition ${
                      selectedPreset === "custom"
                        ? "border-emerald-500 bg-emerald-50 ring-1 ring-emerald-500"
                        : "border-zinc-200 bg-white hover:border-zinc-300"
                    }`}
                  >
                    <span className="block text-sm font-semibold text-zinc-900">
                      {t("me.share.preset.other")}
                    </span>
                    <span className="mt-0.5 block text-xs text-zinc-500">
                      {t("me.share.preset.other.hint")}
                    </span>
                  </button>
                </div>
              </details>
              {chosenPreset && (
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 rounded-lg bg-emerald-50 px-3.5 py-2.5 text-xs text-emerald-800">
                  <span>
                    <strong>{t("me.share.typicalRecipient")}</strong> {chosenPreset.audience}
                  </span>
                  <span>
                    <strong>{t("me.share.recommendedSettings")}</strong>{" "}
                    {t(`me.share.range.${chosenPreset.range}`)} · {chosenLevel.title}
                  </span>
                </div>
              )}
              <label
                className="mt-4 block text-sm font-medium text-zinc-700"
                htmlFor="share-purpose"
              >
                {t("me.share.purpose")}
              </label>
              <input
                id="share-purpose"
                className={`${inputClass} mt-1.5`}
                value={purpose}
                onChange={(e) => {
                  setCustomPurpose(e.target.value);
                  setSelectedPreset("custom");
                }}
                placeholder={t("me.share.purposePlaceholder")}
              />
            </fieldset>

            <fieldset>
              <legend className="text-sm font-semibold text-zinc-900">
                <span className="mr-2 text-emerald-600">2</span>
                {t("me.share.chooseScope")}
              </legend>
              <p className="mt-1 text-sm text-zinc-500">{t("me.share.chooseScopeHint")}</p>
              <div className="mt-3 space-y-2">
                {levelOptions.map((option) => (
                  <label
                    key={option.value}
                    className={`flex cursor-pointer gap-3 rounded-xl border p-4 transition ${
                      level === option.value
                        ? "border-emerald-500 bg-emerald-50/60 ring-1 ring-emerald-500"
                        : "border-zinc-200 hover:border-zinc-300"
                    }`}
                  >
                    <input
                      type="radio"
                      name="disclosure-level"
                      value={option.value}
                      checked={level === option.value}
                      onChange={() => {
                        setLevel(option.value);
                        setSelectedPreset("custom");
                      }}
                      className="mt-1 h-4 w-4 accent-emerald-600"
                    />
                    <span>
                      <span className="block text-sm font-semibold text-zinc-900">
                        {option.title}
                      </span>
                      <span className="mt-0.5 block text-sm leading-relaxed text-zinc-500">
                        {option.detail}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {level === "LEVEL_1" && (
                <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                  <label
                    className="block text-sm font-medium text-zinc-700"
                    htmlFor="income-threshold"
                  >
                    {t("me.share.threshold")}
                  </label>
                  <div className="relative mt-1.5">
                    <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-zinc-500">
                      $
                    </span>
                    <input
                      id="income-threshold"
                      className={`${inputClass} pl-8 ${invalidThreshold ? "border-red-400" : ""}`}
                      type="number"
                      min="1"
                      step="100"
                      inputMode="decimal"
                      value={thresholdUsd}
                      onChange={(e) => setThresholdUsd(e.target.value)}
                    />
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">
                    {t("me.share.thresholdHint")}
                  </p>
                </div>
              )}
            </fieldset>

            <fieldset>
              <legend className="text-sm font-semibold text-zinc-900">
                <span className="mr-2 text-emerald-600">3</span>
                {t("me.share.accessSettings")}
              </legend>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <label className="block text-sm font-medium text-zinc-700">
                  {t("me.share.period")}
                  <select
                    className={`${inputClass} mt-1.5`}
                    value={rangeMonths}
                    onChange={(e) => setRangeMonths(e.target.value)}
                  >
                    {["1", "3", "6", "12", "24", "ytd", "lastYear"].map((months) => (
                      <option key={months} value={months}>
                        {t(`me.share.range.${months}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm font-medium text-zinc-700">
                  {t("me.share.expiration")}
                  <select
                    className={`${inputClass} mt-1.5`}
                    value={expiresInDays}
                    onChange={(e) => setExpiresInDays(e.target.value)}
                  >
                    {["1", "7", "30"].map((days) => (
                      <option key={days} value={days}>
                        {t("me.share.expiresIn").replace("{days}", days)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label
                className="mt-4 block text-sm font-medium text-zinc-700"
                htmlFor="recipient-email"
              >
                {t("me.share.recipientLabel")}
                <span className="ml-1 font-normal text-zinc-400">{t("optional")}</span>
              </label>
              <input
                id="recipient-email"
                className={`${inputClass} mt-1.5 ${invalidEmail ? "border-red-400 focus:border-red-500 focus:ring-red-500/20" : ""}`}
                type="email"
                autoComplete="email"
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value.trim())}
                placeholder="name@company.com"
                aria-describedby="recipient-help"
                aria-invalid={invalidEmail}
              />
              <p
                id="recipient-help"
                className={`mt-1.5 text-xs ${invalidEmail ? "text-red-600" : "text-zinc-500"}`}
              >
                {invalidEmail ? t("me.share.emailInvalid") : t("me.share.recipientHint")}
              </p>
            </fieldset>
          </div>

          <aside className="h-fit rounded-2xl border border-zinc-200 bg-zinc-50 p-5 lg:sticky lg:top-24">
            <p className="text-xs font-bold uppercase tracking-wider text-zinc-400">
              {t("me.share.review")}
            </p>
            <dl className="mt-4 space-y-4 text-sm">
              <div>
                <dt className="text-zinc-500">{t("me.share.destination")}</dt>
                <dd className="mt-1 font-semibold leading-relaxed text-zinc-900">
                  {chosenPreset?.audience ?? t("me.share.destinationCustom")}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">{t("me.share.purpose")}</dt>
                <dd className="mt-1 font-semibold leading-relaxed text-zinc-900">
                  {purpose || (locale === "ko" ? "입력하지 않음" : "Not provided")}
                </dd>
              </div>
              {level === "LEVEL_1" && (
                <div>
                  <dt className="text-zinc-500">{t("me.share.threshold")}</dt>
                  <dd className="mt-1 font-semibold text-zinc-900">
                    ${Number(thresholdUsd || 0).toLocaleString(locale === "ko" ? "ko-KR" : "en-US")}
                    {t("me.share.perMonth")}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-zinc-500">{t("me.share.included")}</dt>
                <dd className="mt-1 font-semibold text-zinc-900">{chosenLevel.title}</dd>
                <dd className="mt-1 text-xs leading-relaxed text-zinc-500">{chosenLevel.detail}</dd>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <dt className="text-zinc-500">{t("me.share.period")}</dt>
                  <dd className="mt-1 font-semibold text-zinc-900">
                    {t(`me.share.range.${rangeMonths}`)}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">{t("me.share.expiration")}</dt>
                  <dd className="mt-1 font-semibold text-zinc-900">
                    {t("me.share.expiresIn").replace("{days}", expiresInDays)}
                  </dd>
                </div>
              </div>
              <div>
                <dt className="text-zinc-500">{t("me.share.delivery")}</dt>
                <dd className="mt-1 break-all font-semibold text-zinc-900">
                  {recipientEmail || t("me.share.deliveryLink")}
                </dd>
              </div>
            </dl>
            <Button
              className="mt-6 w-full py-3"
              onClick={createDisclosure}
              disabled={busy || !purpose.trim() || invalidEmail || invalidThreshold}
            >
              {busy ? t("me.share.issuing") : t("me.share.create")}
            </Button>
            <p className="mt-3 text-center text-xs leading-relaxed text-zinc-500">
              {t("me.share.controlNote")}
            </p>
          </aside>
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
          <div className="mt-6 flex flex-col items-center gap-5 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-5 sm:flex-row sm:items-start">
            {qrDataUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrDataUrl}
                alt="verification QR"
                className="h-36 w-36 rounded-lg border border-emerald-200 bg-white p-1.5"
              />
            )}
            <div className="min-w-0 flex-1 text-sm">
              <p className="text-base font-semibold text-emerald-900">{t("me.share.created")}</p>
              <p className="mt-1 text-emerald-800">{t("me.share.linkOnce")}</p>
              <a
                href={shareUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 block break-all rounded-lg bg-white/80 px-3 py-2 font-mono text-xs text-emerald-800 ring-1 ring-emerald-200"
              >
                {shareUrl}
              </a>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={copyShareLink}>
                  {copied ? t("me.share.copied") : t("me.share.copy")}
                </Button>
                {lastReportId && (
                  <Button size="sm" onClick={() => downloadPdf(lastReportId)}>
                    {t("me.share.pdf")}
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}

        {grants.length > 0 && (
          <ul className="mt-4 flex flex-col gap-2">
            {grants.map((grant) => (
              <li
                key={grant.id}
                className="flex flex-col gap-3 rounded-xl border border-zinc-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="flex min-w-0 flex-wrap items-center gap-2.5 text-[15px]">
                  <Badge>{statusLabel(grant.level)}</Badge>
                  <span className="text-zinc-700">{grant.purpose}</span>
                  <span className="text-sm text-zinc-400">
                    {t("me.share.expires")} {grant.expiresAt.slice(0, 10)}
                  </span>
                  {grant.revokedAt && <Badge tone="FAILED">{t("me.share.revoked")}</Badge>}
                  {!grant.revokedAt && grant.reports[0] && (
                    <Badge tone={grant.reports[0].status}>
                      {statusLabel(grant.reports[0].status)}
                    </Badge>
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
          <div className="mt-4">
            <Button variant="violet" onClick={registerWallet} disabled={busy}>
              {me.wallets.length === 0 ? t("me.wallet.connect") : t("me.wallet.connectMore")}
            </Button>
          </div>
        </Card>
      )}
    </AppShell>
  );
}
