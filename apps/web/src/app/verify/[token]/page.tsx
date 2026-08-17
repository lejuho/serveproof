"use client";

import React, { use, useEffect, useState } from "react";
import { api } from "@/lib/api";
import {
  Badge,
  Button,
  Card,
  inputClass,
  LanguageToggle,
  LoadingState,
  Logo,
  tableCellClass,
  tableHeadClass,
} from "@/components/ui";
import { useI18n } from "@/lib/i18n";

interface VerifyResult {
  status: "VALID" | "EXPIRED" | "REVOKED" | "CORRECTED" | "NOT_ISSUED" | "AUTH_REQUIRED";
  issuer?: string;
  purpose?: string;
  level?: string;
  workerDisplayName?: string;
  issuedAt?: string | null;
  expiresAt: string;
  reportId?: string | null;
  reportHash?: string | null;
  accessMode?: "LINK" | "RECIPIENT_OTP";
  recipientEmailMasked?: string;
  disclosed?: Record<string, unknown> | null;
}

function usd(cents: unknown): string {
  return `$${((cents as number) / 100).toFixed(2)}`;
}

const STATUS_HERO: Record<string, { box: string; icon: string; message: string }> = {
  VALID: {
    box: "border-emerald-300 bg-emerald-50 text-emerald-800",
    icon: "✓",
    message: "이 보고서는 유효합니다.",
  },
  EXPIRED: {
    box: "border-zinc-300 bg-zinc-100 text-zinc-600",
    icon: "⏱",
    message: "이 보고서는 만료되었습니다.",
  },
  REVOKED: {
    box: "border-red-300 bg-red-50 text-red-700",
    icon: "✕",
    message: "이 공유 링크는 노동자에 의해 철회되었습니다. 소득 정보는 표시되지 않습니다.",
  },
  CORRECTED: {
    box: "border-purple-300 bg-purple-50 text-purple-700",
    icon: "↺",
    message: "원본 기록에 정정이 발생했습니다. 최신 보고서를 요청하세요.",
  },
  NOT_ISSUED: {
    box: "border-amber-300 bg-amber-50 text-amber-800",
    icon: "…",
    message: "아직 보고서가 발급되지 않았습니다.",
  },
};

/** Public verifier view (spec §3.4, §21.2) — no account required. */
export default function VerifyPage({ params }: { params: Promise<{ token: string }> }) {
  const { locale, t } = useI18n();
  const { token } = use(params);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [otpRequested, setOtpRequested] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);

  const sessionKey = `serveproof-disclosure-session:${token}`;

  async function loadReport(accessSession?: string | null) {
    const loaded = await api<VerifyResult>(`/verify/${token}`, {
      auth: false,
      headers: accessSession ? { "x-disclosure-session": accessSession } : undefined,
    });
    setResult(loaded);
  }

  useEffect(() => {
    const accessSession = sessionStorage.getItem(sessionKey);
    loadReport(accessSession).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // `sessionKey` and `loadReport` are stable for this route token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function requestOtp() {
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ sent: boolean; devCode?: string }>(
        `/verify/${token}/access/request`,
        { method: "POST", body: {}, auth: false },
      );
      setOtpRequested(response.sent);
      setDevCode(response.devCode ?? null);
      if (response.devCode) setOtpCode(response.devCode);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp() {
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ accessToken: string }>(`/verify/${token}/access/verify`, {
        method: "POST",
        body: { code: otpCode },
        auth: false,
      });
      sessionStorage.setItem(sessionKey, response.accessToken);
      await loadReport(response.accessToken);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const disclosed = result?.disclosed as Record<string, unknown> | undefined;
  const hero = result ? STATUS_HERO[result.status] : null;

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-12">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <div className="flex items-center justify-between">
          <Logo />
          <span className="flex items-center gap-3 text-sm font-medium text-zinc-400">
            {t("verify.header")}
            <LanguageToggle />
          </span>
        </div>

        {!result && !error && (
          <LoadingState title={t("loading.report")} description={t("loading.wait")} />
        )}

        {error && (
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </p>
        )}

        {result?.status === "AUTH_REQUIRED" && (
          <Card
            className="sp-content-reveal"
            title={t("verify.auth.title")}
            description={t("verify.auth.description").replace(
              "{email}",
              result.recipientEmailMasked ?? "***",
            )}
          >
            {!otpRequested ? (
              <Button onClick={requestOtp} loading={busy} loadingLabel={t("verify.auth.sending")}>
                {t("verify.auth.send")}
              </Button>
            ) : (
              <div className="max-w-sm">
                <label className="text-sm font-medium text-zinc-700">
                  {t("verify.auth.code")}
                  <input
                    className={`${inputClass} mt-1.5 font-mono tracking-[0.3em]`}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={otpCode}
                    onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, ""))}
                  />
                </label>
                {devCode && (
                  <p className="mt-2 text-xs text-amber-700">
                    {t("verify.auth.devCode").replace("{code}", devCode)}
                  </p>
                )}
                <div className="mt-3 flex gap-2">
                  <Button
                    onClick={verifyOtp}
                    disabled={otpCode.length !== 6}
                    loading={busy}
                    loadingLabel={t("verify.auth.checking")}
                  >
                    {t("verify.auth.verify")}
                  </Button>
                  <Button variant="secondary" onClick={requestOtp} disabled={busy}>
                    {t("verify.auth.resend")}
                  </Button>
                </div>
              </div>
            )}
            <p className="mt-4 text-xs leading-relaxed text-zinc-500">{t("verify.auth.notice")}</p>
          </Card>
        )}

        {result && result.status !== "AUTH_REQUIRED" && hero && (
          <>
            <div className={`sp-content-reveal rounded-2xl border-2 p-8 text-center ${hero.box}`}>
              <p className="text-5xl">{hero.icon}</p>
              <p className="mt-3 text-4xl font-black tracking-wide">{result.status}</p>
              <p className="mt-2 text-[15px]">{t(`verify.msg.${result.status}`)}</p>
            </div>

            <Card title={t("verify.info.title")}>
              <dl className="grid grid-cols-[140px_1fr] gap-y-2.5 text-[15px]">
                <dt className="text-zinc-400">{t("verify.issuer")}</dt>
                <dd className="font-medium text-zinc-800">{result.issuer}</dd>
                <dt className="text-zinc-400">{t("verify.subject")}</dt>
                <dd className="font-medium text-zinc-800">{result.workerDisplayName}</dd>
                <dt className="text-zinc-400">{t("verify.purpose")}</dt>
                <dd>{result.purpose}</dd>
                <dt className="text-zinc-400">{t("verify.level")}</dt>
                <dd>
                  <Badge>{result.level}</Badge>
                </dd>
                <dt className="text-zinc-400">{t("verify.issuedAt")}</dt>
                <dd className="tabular-nums">
                  {result.issuedAt ?? (locale === "ko" ? "정보 없음" : "Not available")}
                </dd>
                <dt className="text-zinc-400">{t("verify.expiresAt")}</dt>
                <dd className="tabular-nums">{result.expiresAt}</dd>
                <dt className="text-zinc-400">Report hash</dt>
                <dd className="break-all font-mono text-xs leading-relaxed text-zinc-500">
                  {result.reportHash ?? (locale === "ko" ? "정보 없음" : "Not available")}
                </dd>
              </dl>
            </Card>

            {disclosed && (
              <Card title={t("verify.disclosed.title")}>
                {disclosed.level === "LEVEL_1" ? (
                  <div className="py-2 text-center">
                    <p className="text-zinc-500">{String(disclosed.criterion)}</p>
                    <p className="mt-2 text-5xl font-black tracking-tight text-zinc-900">
                      {disclosed.result ? "TRUE" : "FALSE"}
                    </p>
                  </div>
                ) : (
                  <>
                    <dl className="grid grid-cols-[190px_1fr] gap-y-2.5 text-[15px]">
                      <dt className="text-zinc-400">{t("verify.totalIncome")}</dt>
                      <dd className="font-bold tabular-nums text-zinc-900">
                        {usd(disclosed.totalVerifiedIncomeUsdCents)}
                      </dd>
                      <dt className="text-zinc-400">{t("verify.avgMonthly")}</dt>
                      <dd className="font-bold tabular-nums text-zinc-900">
                        {usd(disclosed.avgMonthlyIncomeUsdCents)}
                      </dd>
                      <dt className="text-zinc-400">{t("verify.months")}</dt>
                      <dd>{String(disclosed.monthsCovered)}</dd>
                      <dt className="text-zinc-400">{t("verify.payers")}</dt>
                      <dd>{String(disclosed.payerCount)}</dd>
                      <dt className="text-zinc-400">{t("verify.bestGrade")}</dt>
                      <dd>
                        <Badge tone={String(disclosed.bestGrade)}>
                          {String(disclosed.bestGrade)}
                        </Badge>
                      </dd>
                      <dt className="text-zinc-400">{t("verify.corrections")}</dt>
                      <dd>{disclosed.hasCorrections ? t("verify.yes") : t("verify.no")}</dd>
                      {typeof disclosed.posVerifiedSharePct === "number" && (
                        <>
                          <dt className="text-zinc-400">{t("verify.posShare")}</dt>
                          <dd className="font-semibold text-emerald-700">
                            {String(disclosed.posVerifiedSharePct)}%
                          </dd>
                        </>
                      )}
                      {typeof disclosed.observedShiftDays === "number" && (
                        <>
                          <dt className="text-zinc-400">{t("verify.observedDays")}</dt>
                          <dd>{String(disclosed.observedShiftDays)}</dd>
                        </>
                      )}
                    </dl>
                    {disclosed.monthlyBreakdown &&
                      Object.keys(disclosed.monthlyBreakdown as Record<string, number>).length >
                        0 && (
                        <div className="mt-4">
                          <p className="text-sm font-semibold text-zinc-600">
                            {t("verify.monthly.title")}
                          </p>
                          <dl className="mt-1.5 grid grid-cols-[190px_1fr] gap-y-1.5 text-sm">
                            {Object.entries(disclosed.monthlyBreakdown as Record<string, number>)
                              .sort()
                              .map(([month, cents]) => (
                                <React.Fragment key={month}>
                                  <dt className="font-mono text-zinc-400">{month}</dt>
                                  <dd className="tabular-nums text-zinc-800">{usd(cents)}</dd>
                                </React.Fragment>
                              ))}
                          </dl>
                        </div>
                      )}
                    {Number(disclosed.monthsCovered) <= 1 && (
                      <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
                        {t("verify.shortWindow")}
                      </p>
                    )}
                  </>
                )}
                {Array.isArray(disclosed.entries) && (
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr>
                          <th className={tableHeadClass}>{t("me.col.date")}</th>
                          <th className={tableHeadClass}>{t("me.col.venue")}</th>
                          <th className={`${tableHeadClass} text-right`}>
                            {t("me.col.allocated")}
                          </th>
                          <th className={`${tableHeadClass} text-right`}>{t("me.col.paid")}</th>
                          <th className={tableHeadClass}>{t("me.col.withholding")}</th>
                          <th className={tableHeadClass}>{t("me.col.grade")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(disclosed.entries as Record<string, unknown>[]).map((entry, i) => (
                          <tr key={i}>
                            <td className={`${tableCellClass} whitespace-nowrap`}>
                              {String(entry.businessDate)}
                            </td>
                            <td className={tableCellClass}>{String(entry.venue)}</td>
                            <td
                              className={`${tableCellClass} text-right font-semibold tabular-nums`}
                            >
                              {usd(entry.allocatedUsdCents)}
                            </td>
                            <td
                              className={`${tableCellClass} text-right font-semibold tabular-nums`}
                            >
                              {usd(entry.paidUsdCents)}
                            </td>
                            <td className={tableCellClass}>
                              <Badge tone={String(entry.withholdingStatus)}>
                                {String(entry.withholdingStatus)}
                              </Badge>
                            </td>
                            <td className={tableCellClass}>
                              <Badge tone={String(entry.evidenceGrade)}>
                                {String(entry.evidenceGrade)}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            )}

            <p className="text-center text-xs leading-relaxed text-zinc-400">
              {t("verify.footer")}
            </p>
          </>
        )}
      </div>
    </main>
  );
}
