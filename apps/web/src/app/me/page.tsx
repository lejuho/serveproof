"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
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
import { apiStaleTime, fetchApiQuery, invalidateApiQueries } from "@/lib/query";
import { solscanTxUrl } from "@/lib/solana";
import { connectWallet } from "@/lib/wallet";
import {
  AppShell,
  Badge,
  Button,
  Callout,
  Card,
  LoadingState,
  inputClass,
  StatCard,
  tableCellClass,
  tableHeadClass,
} from "@/components/ui";
import { VenueConnectionCards, type VenueConnection } from "@/components/venue-connection-cards";
import { WorkerStaffingCard } from "@/components/staffing-cards";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface Grant {
  id: string;
  purpose: string;
  level: string;
  accessMode: "LINK" | "RECIPIENT_OTP";
  recipientEmail: string | null;
  expiresAt: string;
  revokedAt: string | null;
  reports: { id: string; status: string }[];
  accesses: { id: string; accessedAt: string; ipMasked: string | null; userAgent: string | null }[];
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
  ingestSource: "CSV_UPLOAD" | "PROVIDER_API" | "PLATFORM_ATTESTED" | null;
  isCorrection: boolean;
  correctionReason: string | null;
}
interface TimelinePage {
  items: TimelineEntry[];
  nextCursor: string | null;
}

function SourceBadge({
  ingestSource,
  t,
}: {
  ingestSource: string | null;
  t: (k: string) => string;
}) {
  const pos = ingestSource === "PROVIDER_API";
  const staffing = ingestSource === "PLATFORM_ATTESTED";
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
        pos || staffing ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-500"
      }`}
    >
      {pos ? t("me.source.pos") : staffing ? t("me.source.staffing") : t("me.source.self")}
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
  venue?: { id: string; name: string } | null;
  shift?: { businessDate: string; role: string } | null;
}
interface Me {
  id: string;
  user: { email: string; displayName: string };
  wallets: {
    id: string;
    address: string;
    isDefault: boolean;
    status: string;
    linkedAt: string;
  }[];
}
interface WorkerOverview {
  me: Me;
  summary: Summary;
  alerts: Alert[];
  timeline: TimelinePage;
}
interface TaxReadiness {
  year: number;
  unmatchedUsdCents: number;
  withholdingUnknownUsdCents: number;
  devnetTestUsdCents: number;
  byRail: Record<string, number>;
  guidance: { tipIncome: string; withholding: string; estimatedTax: string };
  disclaimer: string;
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
  const queryClient = useQueryClient();
  const [me, setMe] = useState<Me | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [timelineCursor, setTimelineCursor] = useState<string | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [venueConnections, setVenueConnections] = useState<VenueConnection[]>([]);
  const [respondingMappingId, setRespondingMappingId] = useState<string | null>(null);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [taxReadiness, setTaxReadiness] = useState<TaxReadiness | null>(null);
  const [reserveRate, setReserveRate] = useState("20");
  const [level, setLevel] = useState("LEVEL_2");
  const [purposeKey, setPurposeKey] = useState("me.share.preset.rent.purpose");
  const [customPurpose, setCustomPurpose] = useState<string | null>(null);
  const [selectedPreset, setSelectedPreset] = useState("rent");
  const [rangeMonths, setRangeMonths] = useState("3");
  const [expiresInDays, setExpiresInDays] = useState("7");
  const [thresholdUsd, setThresholdUsd] = useState("3000");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientEmailConfirm, setRecipientEmailConfirm] = useState("");
  const [accessMode, setAccessMode] = useState<"LINK" | "RECIPIENT_OTP">("RECIPIENT_OTP");
  const [emailStatus, setEmailStatus] = useState<"sent" | "failed" | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [lastReportId, setLastReportId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [incomeSecondaryLoading, setIncomeSecondaryLoading] = useState(false);
  const [incomeSecondaryLoaded, setIncomeSecondaryLoaded] = useState(false);
  const [workDataLoading, setWorkDataLoading] = useState(false);
  const [workDataLoaded, setWorkDataLoaded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedAlertId, setCopiedAlertId] = useState<string | null>(null);
  const [copiedWalletId, setCopiedWalletId] = useState<string | null>(null);
  const [walletNotice, setWalletNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [availableModes, setAvailableModes] = useState<AppMode[]>([]);
  const [workerWorkspace, setWorkerWorkspace] = useState<"work" | "income">("income");
  const incomeSecondaryRequested = useRef(false);
  const workDataRequested = useRef(false);
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
    fetchApiQuery<WorkerOverview>(queryClient, "/workers/me/overview", apiStaleTime.overview)
      .then((overview) => {
        setAvailableModes(getCurrentSession()?.modes ?? []);
        setMe(overview.me);
        setTimeline(overview.timeline.items);
        setTimelineCursor(overview.timeline.nextCursor);
        setSummary(overview.summary);
        setAlerts(overview.alerts);
      })
      .catch(guard)
      .finally(() => setInitialLoading(false));
  }, [router, guard, queryClient]);

  useEffect(() => {
    if (initialLoading || workerWorkspace !== "income" || incomeSecondaryRequested.current) return;
    incomeSecondaryRequested.current = true;
    setIncomeSecondaryLoading(true);
    Promise.all([
      fetchApiQuery<Grant[]>(queryClient, "/disclosures", apiStaleTime.overview),
      fetchApiQuery<TaxReadiness>(queryClient, "/workers/me/tax-readiness", apiStaleTime.overview),
    ])
      .then(([grantData, taxData]) => {
        setGrants(grantData);
        setTaxReadiness(taxData);
      })
      .catch(guard)
      .finally(() => {
        setIncomeSecondaryLoaded(true);
        setIncomeSecondaryLoading(false);
      });
  }, [guard, initialLoading, workerWorkspace, queryClient]);

  useEffect(() => {
    if (initialLoading || workerWorkspace !== "work" || workDataRequested.current) return;
    workDataRequested.current = true;
    setWorkDataLoading(true);
    fetchApiQuery<VenueConnection[]>(
      queryClient,
      "/workers/me/venue-connections",
      apiStaleTime.connections,
    )
      .then(setVenueConnections)
      .catch(guard)
      .finally(() => {
        setWorkDataLoaded(true);
        setWorkDataLoading(false);
      });
  }, [guard, initialLoading, workerWorkspace, queryClient]);

  const refreshGrants = useCallback(async () => {
    await invalidateApiQueries(queryClient, ["/disclosures"]);
    fetchApiQuery<Grant[]>(queryClient, "/disclosures", apiStaleTime.overview)
      .then(setGrants)
      .catch(guard);
  }, [guard, queryClient]);

  const respondToMapping = async (mappingId: string, decision: "ACCEPT" | "REJECT") => {
    setRespondingMappingId(mappingId);
    setConnectionMessage(null);
    setError(null);
    try {
      await api(`/worker-mappings/${mappingId}/respond`, {
        method: "PATCH",
        body: { decision },
      });
      await invalidateApiQueries(queryClient, [
        "/workers/me/venue-connections",
        "/workers/me/overview",
      ]);
      setVenueConnections(
        await fetchApiQuery<VenueConnection[]>(
          queryClient,
          "/workers/me/venue-connections",
          apiStaleTime.connections,
        ),
      );
      setConnectionMessage(
        decision === "ACCEPT"
          ? locale === "ko"
            ? "사업장 계정 연결을 수락했습니다. 기존 근무 기록이 이 계정에 연결되었습니다."
            : "Connection accepted. Existing work records are now linked to this account."
          : locale === "ko"
            ? "사업장 계정 연결 요청을 거절했습니다."
            : "Connection request rejected.",
      );
    } catch (caught) {
      guard(caught);
    } finally {
      setRespondingMappingId(null);
    }
  };

  async function loadMoreTimeline() {
    if (!timelineCursor || timelineLoading) return;
    setTimelineLoading(true);
    try {
      const path = `/workers/me/income-timeline?limit=25&cursor=${encodeURIComponent(timelineCursor)}`;
      const page = await fetchApiQuery<TimelinePage>(queryClient, path, apiStaleTime.overview);
      setTimeline((current) => [
        ...current,
        ...page.items.filter((entry) => !current.some((existing) => existing.id === entry.id)),
      ]);
      setTimelineCursor(page.nextCursor);
    } catch (caught) {
      guard(caught);
    } finally {
      setTimelineLoading(false);
    }
  }

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
          accessMode,
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
    setWalletNotice(null);
    try {
      const existing = me?.wallets ?? [];
      const address = await connectWallet({ forceReconnect: existing.length > 0 });
      if (existing.some((wallet) => wallet.address === address)) {
        setWalletNotice(t("me.wallet.alreadyLinked"));
        return;
      }
      await api("/workers/me/wallets", { method: "POST", body: { address } });
      await invalidateApiQueries(queryClient, [
        "/workers/me/overview",
        "/workers/me/venue-connections",
      ]);
      setMe(await api<Me>("/workers/me"));
      setVenueConnections(
        await fetchApiQuery<VenueConnection[]>(
          queryClient,
          "/workers/me/venue-connections",
          apiStaleTime.connections,
        ),
      );
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

  async function copyWalletAddress(walletId: string, address: string) {
    await navigator.clipboard.writeText(address);
    setCopiedWalletId(walletId);
    window.setTimeout(() => setCopiedWalletId(null), 2000);
  }

  function scrollToIncomeTarget(targetId: string) {
    document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function copyAlertInquiry(alert: Alert) {
    const amount = Number(
      alert.detail.allocatedUsdCents ??
        alert.detail.paidUsdCents ??
        alert.detail.payrollReportedUsdCents ??
        0,
    );
    const context = [alert.venue?.name, alert.shift?.businessDate, alert.shift?.role]
      .filter(Boolean)
      .join(" · ");
    const message =
      locale === "ko"
        ? `[ServeProof 확인 요청] ${t(`alert.label.${alert.type}`)}${context ? ` — ${context}` : ""}${amount > 0 ? ` — ${usd(amount)}` : ""}\n${t(`alert.${alert.type}`)}`
        : `[ServeProof review request] ${t(`alert.label.${alert.type}`)}${context ? ` — ${context}` : ""}${amount > 0 ? ` — ${usd(amount)}` : ""}\n${t(`alert.${alert.type}`)}`;
    try {
      await navigator.clipboard.writeText(message);
      setCopiedAlertId(alert.id);
      window.setTimeout(() => setCopiedAlertId(null), 2000);
    } catch {
      setError(t("me.alerts.copyFailed"));
    }
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
  const recipientRequired = accessMode === "RECIPIENT_OTP" && recipientEmail.length === 0;
  const recipientMismatch =
    recipientEmail.length > 0 &&
    recipientEmail.toLowerCase() !== recipientEmailConfirm.toLowerCase();
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

  if (initialLoading) {
    return <LoadingState fullScreen title={t("loading.income")} description={t("loading.wait")} />;
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
            className="text-sm font-medium text-zinc-500 hover:text-zinc-700"
          >
            {t("auth.switch")}
          </a>
          <button
            onClick={async () => {
              await logoutSession();
              router.push("/");
            }}
            className="text-sm font-medium text-zinc-500 hover:text-zinc-700"
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
              onClick={() => (
                setWorkerWorkspace("income"),
                window.setTimeout(
                  () =>
                    document
                      .getElementById("card-wallet")
                      ?.scrollIntoView({ behavior: "smooth", block: "start" }),
                  0,
                )
              )}
              className="font-semibold underline underline-offset-2 hover:opacity-80"
            >
              {t("me.banner.goConnect")} →
            </button>
          </Callout>
        )}

      <div
        role="tablist"
        aria-label={locale === "ko" ? "노동자 작업공간" : "Worker workspace"}
        className="grid grid-cols-2 gap-2 rounded-2xl border border-zinc-200 bg-zinc-100 p-1.5"
      >
        <button
          type="button"
          role="tab"
          aria-selected={workerWorkspace === "work"}
          onClick={() => setWorkerWorkspace("work")}
          className={`rounded-xl px-4 py-3 text-left transition ${
            workerWorkspace === "work"
              ? "bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200"
              : "text-zinc-500 hover:bg-white/60"
          }`}
        >
          <span className="block text-sm font-semibold">{locale === "ko" ? "근무" : "Work"}</span>
          <span className="mt-0.5 block text-xs">
            {locale === "ko"
              ? "사업장 연결 · 모집 시프트 · 출퇴근"
              : "Connections · shifts · attendance"}
          </span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={workerWorkspace === "income"}
          onClick={() => setWorkerWorkspace("income")}
          className={`rounded-xl px-4 py-3 text-left transition ${
            workerWorkspace === "income"
              ? "bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200"
              : "text-zinc-500 hover:bg-white/60"
          }`}
        >
          <span className="block text-sm font-semibold">
            {locale === "ko" ? "소득 · 증명" : "Income & proof"}
          </span>
          <span className="mt-0.5 block text-xs">
            {locale === "ko"
              ? "소득원장 · 세금 준비 · 증빙 공유"
              : "Ledger · tax readiness · sharing"}
          </span>
        </button>
      </div>

      {workerWorkspace === "work" && (
        <>
          {connectionMessage && <Callout tone="emerald">{connectionMessage}</Callout>}
          {workDataLoading || !workDataLoaded ? (
            <LoadingState title={t("loading.connections")} description={t("loading.wait")} />
          ) : (
            <VenueConnectionCards
              connections={venueConnections}
              locale={locale}
              respondingId={respondingMappingId}
              onRespond={respondToMapping}
            />
          )}
          <WorkerStaffingCard locale={locale} onGoToIncome={() => setWorkerWorkspace("income")} />
        </>
      )}

      {workerWorkspace === "income" && (
        <>
          {summary && (
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatCard
                label={t("me.stat.allocated")}
                value={usd(summary.totals.allocatedUsdCents)}
              />
              <StatCard
                label={t("me.stat.paid")}
                value={usd(summary.totals.paidUsdCents)}
                valueClass="text-emerald-700"
              />
              <StatCard label={t("me.stat.avg")} value={usd(summary.avgMonthlyAllocatedUsdCents)} />
              <StatCard
                label={t("me.stat.payers")}
                value={`${summary.payerCount} · ${summary.shiftCount}`}
                hint={locale === "ko" ? "사업장 수 · 근무 건수" : "payer count · shifts"}
              />
            </div>
          )}

          {(incomeSecondaryLoading || !incomeSecondaryLoaded) && (
            <LoadingState compact title={t("loading.incomeDetails")} />
          )}

          <div id="card-wallet" className="scroll-mt-6" />
          <div className="grid items-start gap-6 lg:grid-cols-2">
            {taxReadiness && (
              <Card
                title={
                  locale === "ko"
                    ? `${taxReadiness.year} 세금 준비`
                    : `${taxReadiness.year} tax readiness`
                }
                description={
                  locale === "ko"
                    ? "급여 신고 또는 원천징수 기록과 아직 연결되지 않은 지급액을 미리 확인합니다."
                    : "Review paid income not yet matched to payroll or withholding records."
                }
              >
                <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
                  <div>
                    <p className="text-3xl font-bold tracking-tight tabular-nums">
                      {usd(taxReadiness.unmatchedUsdCents)}
                    </p>
                    <p className="mt-1 text-sm text-zinc-500">
                      {locale === "ko"
                        ? "세금 신고 또는 예상 납부 준비가 필요할 수 있는 금액"
                        : "Amount that may require filing or estimated-payment planning"}
                    </p>
                  </div>
                  <label className="text-sm text-zinc-600">
                    {locale === "ko" ? "개인 준비율" : "Personal reserve rate"}
                    <select
                      className={`${inputClass} mt-1`}
                      value={reserveRate}
                      onChange={(e) => setReserveRate(e.target.value)}
                    >
                      {[10, 15, 20, 25, 30].map((rate) => (
                        <option key={rate} value={rate}>
                          {rate}%
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="mt-4 rounded-xl bg-zinc-50 px-4 py-3 text-sm">
                  {locale === "ko" ? "준비용 적립 예시" : "Planning reserve example"}:{" "}
                  <b>
                    {usd(Math.round((taxReadiness.unmatchedUsdCents * Number(reserveRate)) / 100))}
                  </b>
                </div>
                {taxReadiness.devnetTestUsdCents > 0 && (
                  <Callout tone="amber">
                    {locale === "ko"
                      ? `Devnet tUSDC ${usd(taxReadiness.devnetTestUsdCents)}는 금전 가치가 없는 테스트 자산이므로 위 계산에서 제외했습니다.`
                      : `${usd(taxReadiness.devnetTestUsdCents)} of Devnet tUSDC is excluded because it has no monetary value.`}
                  </Callout>
                )}
                <p className="mt-3 text-xs leading-relaxed text-zinc-500">
                  {locale === "ko"
                    ? "세무 자문이나 실제 세액 계산이 아닙니다. 개인 상황은 세무 전문가에게 확인하세요."
                    : taxReadiness.disclaimer}{" "}
                  <a
                    className="font-medium text-emerald-700 underline"
                    href={taxReadiness.guidance.tipIncome}
                    target="_blank"
                    rel="noreferrer"
                  >
                    IRS tip guidance
                  </a>
                  {" · "}
                  <a
                    className="font-medium text-emerald-700 underline"
                    href={taxReadiness.guidance.estimatedTax}
                    target="_blank"
                    rel="noreferrer"
                  >
                    IRS Publication 505
                  </a>
                </p>
              </Card>
            )}
            {me && (
              <Card title={t("me.wallet.title")} description={t("me.wallet.desc")}>
                {me.wallets.length === 0 ? (
                  <p className="text-sm text-zinc-500">{t("me.wallet.empty")}</p>
                ) : (
                  <ul className="flex flex-col gap-2.5">
                    {me.wallets.map((wallet) => (
                      <li
                        key={wallet.id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-zinc-200 bg-zinc-50/70 px-3.5 py-2.5"
                      >
                        <code
                          title={wallet.address}
                          className="text-[15px] font-medium text-zinc-800"
                        >
                          {wallet.address.slice(0, 8)}…{wallet.address.slice(-6)}
                        </code>
                        {wallet.isDefault && (
                          <Badge tone="CONFIRMED">{t("me.wallet.default")}</Badge>
                        )}
                        {wallet.linkedAt && (
                          <span className="text-xs text-zinc-500">
                            {t("me.wallet.linkedAt")} {wallet.linkedAt.slice(0, 10)}
                          </span>
                        )}
                        <Button
                          size="sm"
                          variant="secondary"
                          className="ml-auto"
                          onClick={() => copyWalletAddress(wallet.id, wallet.address)}
                        >
                          {copiedWalletId === wallet.id
                            ? t("me.wallet.copied")
                            : t("me.wallet.copy")}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {walletNotice && (
                  <div className="mt-3">
                    <Callout tone="amber">{walletNotice}</Callout>
                  </div>
                )}
                <div className="mt-4">
                  <Button variant="violet" onClick={registerWallet} disabled={busy}>
                    {me.wallets.length === 0 ? t("me.wallet.connect") : t("me.wallet.connectMore")}
                  </Button>
                </div>
              </Card>
            )}
          </div>

          <Card title={t("me.alerts.title")} description={t("me.alerts.desc")}>
            {alerts.length === 0 ? (
              <p className="text-sm text-zinc-500">{t("me.alerts.empty")}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {alerts.map((alert) => {
                  const workerCanFixWallet =
                    alert.type === "PAYOUT_GAP" && me?.wallets.length === 0;
                  return (
                    <li
                      key={alert.id}
                      className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3"
                    >
                      <div className="flex flex-wrap items-center gap-2.5">
                        <Badge tone="REVIEW_REQUIRED">{t(`alert.label.${alert.type}`)}</Badge>
                        {alert.venue?.name && (
                          <span className="text-xs font-medium text-amber-700">
                            {alert.venue.name}
                            {alert.shift?.businessDate ? ` · ${alert.shift.businessDate}` : ""}
                          </span>
                        )}
                      </div>
                      <p className="mt-2 text-sm text-amber-800">{t(`alert.${alert.type}`)}</p>
                      <div className="mt-3 rounded-lg border border-amber-200/80 bg-white/70 p-3">
                        <p className="text-xs font-semibold text-zinc-700">
                          {workerCanFixWallet
                            ? t("me.alerts.workerAction")
                            : t("me.alerts.venueAction")}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {workerCanFixWallet && (
                            <Button size="sm" onClick={() => scrollToIncomeTarget("card-wallet")}>
                              {t("me.alerts.checkWallet")}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => scrollToIncomeTarget("income-timeline")}
                          >
                            {t("me.alerts.viewIncome")}
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => copyAlertInquiry(alert)}
                          >
                            {copiedAlertId === alert.id
                              ? t("me.alerts.inquiryCopied")
                              : t("me.alerts.copyInquiry")}
                          </Button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <div id="income-timeline" className="scroll-mt-6" />
          <Card
            title={t("me.timeline.title")}
            description={
              <>
                {t("me.timeline.desc")}{" "}
                <a
                  href="/grades"
                  className="font-medium text-emerald-700 underline underline-offset-2"
                >
                  {t("gradeGuide.link")}
                </a>
              </>
            }
          >
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
                      <td
                        className={`${tableCellClass} whitespace-nowrap font-medium text-zinc-900`}
                      >
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
                        <span
                          className={
                            entry.allocatedUsdCents > entry.paidUsdCents
                              ? "text-amber-700"
                              : entry.paidUsdCents > 0
                                ? "text-emerald-700"
                                : undefined
                          }
                        >
                          {usd(entry.paidUsdCents)}
                        </span>
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
                            href={solscanTxUrl(entry.payoutTxSignature)}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium text-violet-600 underline underline-offset-2 hover:text-violet-800"
                            title={t("me.explorer.title")}
                          >
                            Solscan ↗
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
            {timelineCursor && (
              <div className="mt-4 flex justify-center">
                <Button
                  variant="secondary"
                  onClick={loadMoreTimeline}
                  loading={timelineLoading}
                  loadingLabel={t("me.timeline.loadingMore")}
                >
                  {t("me.timeline.loadMore")}
                </Button>
              </div>
            )}
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
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <label
                      className={`cursor-pointer rounded-xl border p-4 ${
                        accessMode === "RECIPIENT_OTP"
                          ? "border-emerald-400 bg-emerald-50"
                          : "border-zinc-200"
                      }`}
                    >
                      <input
                        type="radio"
                        name="disclosure-access-mode"
                        className="mr-2 accent-emerald-600"
                        checked={accessMode === "RECIPIENT_OTP"}
                        onChange={() => setAccessMode("RECIPIENT_OTP")}
                      />
                      <span className="font-semibold text-zinc-900">
                        {t("me.share.accessRecipient")}
                      </span>
                      <span className="mt-1 block text-xs leading-relaxed text-zinc-500">
                        {t("me.share.accessRecipientHint")}
                      </span>
                    </label>
                    <label
                      className={`cursor-pointer rounded-xl border p-4 ${
                        accessMode === "LINK" ? "border-amber-400 bg-amber-50" : "border-zinc-200"
                      }`}
                    >
                      <input
                        type="radio"
                        name="disclosure-access-mode"
                        className="mr-2 accent-amber-600"
                        checked={accessMode === "LINK"}
                        onChange={() => setAccessMode("LINK")}
                      />
                      <span className="font-semibold text-zinc-900">
                        {t("me.share.accessLink")}
                      </span>
                      <span className="mt-1 block text-xs leading-relaxed text-zinc-500">
                        {t("me.share.accessLinkHint")}
                      </span>
                    </label>
                  </div>
                  <label
                    className="mt-4 block text-sm font-medium text-zinc-700"
                    htmlFor="recipient-email"
                  >
                    {t("me.share.recipientLabel")}
                    {accessMode === "LINK" && (
                      <span className="ml-1 font-normal text-zinc-500">{t("optional")}</span>
                    )}
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
                    aria-invalid={invalidEmail || recipientRequired}
                  />
                  <p
                    id="recipient-help"
                    className={`mt-1.5 text-xs ${invalidEmail || recipientRequired ? "text-red-600" : "text-zinc-500"}`}
                  >
                    {invalidEmail
                      ? t("me.share.emailInvalid")
                      : recipientRequired
                        ? t("me.share.emailRequired")
                        : accessMode === "RECIPIENT_OTP"
                          ? t("me.share.recipientSecureHint")
                          : t("me.share.recipientHint")}
                  </p>
                  {recipientEmail && (
                    <label className="mt-3 block text-sm font-medium text-zinc-700">
                      {t("me.share.recipientConfirm")}
                      <input
                        className={`${inputClass} mt-1.5 ${recipientMismatch ? "border-red-400" : ""}`}
                        type="email"
                        autoComplete="off"
                        value={recipientEmailConfirm}
                        onChange={(e) => setRecipientEmailConfirm(e.target.value.trim())}
                        placeholder={recipientEmail}
                      />
                      <span
                        className={`mt-1.5 block text-xs ${recipientMismatch ? "text-red-600" : "text-zinc-500"}`}
                      >
                        {recipientMismatch
                          ? t("me.share.recipientMismatch")
                          : t("me.share.recipientConfirmHint")}
                      </span>
                    </label>
                  )}
                </fieldset>
              </div>

              <aside className="h-fit rounded-2xl border border-zinc-200 bg-zinc-50 p-5 lg:sticky lg:top-24">
                <p className="text-xs font-bold uppercase tracking-wider text-zinc-500">
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
                        $
                        {Number(thresholdUsd || 0).toLocaleString(
                          locale === "ko" ? "ko-KR" : "en-US",
                        )}
                        {t("me.share.perMonth")}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt className="text-zinc-500">{t("me.share.included")}</dt>
                    <dd className="mt-1 font-semibold text-zinc-900">{chosenLevel.title}</dd>
                    <dd className="mt-1 text-xs leading-relaxed text-zinc-500">
                      {chosenLevel.detail}
                    </dd>
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
                      {accessMode === "RECIPIENT_OTP"
                        ? `${recipientEmail || "—"} · OTP`
                        : recipientEmail || t("me.share.deliveryLink")}
                    </dd>
                  </div>
                </dl>
                <Button
                  className="mt-6 w-full py-3"
                  onClick={createDisclosure}
                  disabled={
                    busy ||
                    !purpose.trim() ||
                    invalidEmail ||
                    recipientRequired ||
                    recipientMismatch ||
                    invalidThreshold
                  }
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
                {emailStatus === "sent"
                  ? t("me.share.emailSent")
                  : accessMode === "RECIPIENT_OTP"
                    ? t("me.share.emailFailedSecure")
                    : t("me.share.emailFailed")}
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
                  <p className="text-base font-semibold text-emerald-900">
                    {t("me.share.created")}
                  </p>
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
                  <li key={grant.id} className="rounded-xl border border-zinc-200 px-4 py-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <span className="flex min-w-0 flex-wrap items-center gap-2.5 text-[15px]">
                        <Badge>{statusLabel(grant.level)}</Badge>
                        <Badge
                          tone={grant.accessMode === "RECIPIENT_OTP" ? "CONFIRMED" : "PENDING"}
                        >
                          {grant.accessMode === "RECIPIENT_OTP"
                            ? t("me.share.accessRecipientShort")
                            : t("me.share.accessLinkShort")}
                        </Badge>
                        <span className="text-zinc-700">{grant.purpose}</span>
                        <span className="text-sm text-zinc-500">
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
                    </div>
                    <details className="mt-2 text-xs text-zinc-500">
                      <summary className="cursor-pointer font-medium text-zinc-600">
                        {t("me.share.accessHistory")} · {grant.accesses.length}
                      </summary>
                      {grant.accesses.length === 0 ? (
                        <p className="mt-2 text-zinc-500">{t("me.share.noAccess")}</p>
                      ) : (
                        <ul className="mt-2 space-y-1.5">
                          {grant.accesses.map((access) => (
                            <li key={access.id} className="flex flex-wrap gap-x-2">
                              <span>{new Date(access.accessedAt).toLocaleString()}</span>
                              <span>{access.ipMasked ?? t("me.share.unknownIp")}</span>
                              <span className="max-w-full truncate text-zinc-500">
                                {access.userAgent ?? "—"}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </AppShell>
  );
}
