"use client";

import { use, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Badge, Card, LanguageToggle, Logo, tableCellClass, tableHeadClass } from "@/components/ui";
import { useI18n } from "@/lib/i18n";

interface VerifyResult {
  status: "VALID" | "EXPIRED" | "REVOKED" | "CORRECTED" | "NOT_ISSUED";
  issuer: string;
  purpose: string;
  level: string;
  workerDisplayName: string;
  issuedAt: string | null;
  expiresAt: string;
  reportId: string | null;
  reportHash: string | null;
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
  const { t } = useI18n();
  const { token } = use(params);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<VerifyResult>(`/verify/${token}`, { auth: false })
      .then(setResult)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [token]);

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

        {error && (
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </p>
        )}

        {result && hero && (
          <>
            <div className={`rounded-2xl border-2 p-8 text-center ${hero.box}`}>
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
                <dd className="tabular-nums">{result.issuedAt ?? "—"}</dd>
                <dt className="text-zinc-400">{t("verify.expiresAt")}</dt>
                <dd className="tabular-nums">{result.expiresAt}</dd>
                <dt className="text-zinc-400">Report hash</dt>
                <dd className="break-all font-mono text-xs leading-relaxed text-zinc-500">
                  {result.reportHash ?? "—"}
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
                  </dl>
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
