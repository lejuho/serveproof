"use client";

import { use, useEffect, useState } from "react";
import { api } from "@/lib/api";

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

const STATUS_STYLE: Record<string, string> = {
  VALID: "bg-emerald-100 text-emerald-800 border-emerald-300",
  EXPIRED: "bg-zinc-100 text-zinc-600 border-zinc-300",
  REVOKED: "bg-red-100 text-red-700 border-red-300",
  CORRECTED: "bg-purple-100 text-purple-700 border-purple-300",
  NOT_ISSUED: "bg-amber-100 text-amber-800 border-amber-300",
};

/** Public verifier view (spec §3.4, §21.2) — no account required. */
export default function VerifyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<VerifyResult>(`/verify/${token}`, { auth: false })
      .then(setResult)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [token]);

  const disclosed = result?.disclosed as Record<string, unknown> | undefined;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-5 p-8">
      <h1 className="text-2xl font-bold">ServeProof 소득증명 검증</h1>
      {error && <p className="rounded-md bg-red-100 px-3 py-2 text-sm text-red-700">{error}</p>}

      {result && (
        <>
          <div className={`rounded-lg border-2 p-5 text-center ${STATUS_STYLE[result.status]}`}>
            <p className="text-3xl font-black tracking-wide">{result.status}</p>
            <p className="mt-1 text-sm">
              {result.status === "VALID" && "이 보고서는 유효합니다."}
              {result.status === "EXPIRED" && "이 보고서는 만료되었습니다."}
              {result.status === "REVOKED" &&
                "이 공유 링크는 노동자에 의해 철회되었습니다. 소득 정보는 표시되지 않습니다."}
              {result.status === "CORRECTED" &&
                "원본 기록에 정정이 발생했습니다. 최신 보고서를 요청하세요."}
              {result.status === "NOT_ISSUED" && "아직 보고서가 발급되지 않았습니다."}
            </p>
          </div>

          <section className="rounded-lg border border-zinc-200 bg-white p-4 text-sm">
            <h2 className="mb-2 font-semibold">보고서 정보</h2>
            <dl className="grid grid-cols-[130px_1fr] gap-y-1">
              <dt className="text-zinc-500">발급자</dt>
              <dd>{result.issuer}</dd>
              <dt className="text-zinc-500">대상</dt>
              <dd>{result.workerDisplayName}</dd>
              <dt className="text-zinc-500">목적</dt>
              <dd>{result.purpose}</dd>
              <dt className="text-zinc-500">공개 수준</dt>
              <dd>{result.level}</dd>
              <dt className="text-zinc-500">발급 시각</dt>
              <dd>{result.issuedAt ?? "—"}</dd>
              <dt className="text-zinc-500">만료 시각</dt>
              <dd>{result.expiresAt}</dd>
              <dt className="text-zinc-500">Report hash</dt>
              <dd className="break-all font-mono text-xs">{result.reportHash ?? "—"}</dd>
            </dl>
          </section>

          {disclosed && (
            <section className="rounded-lg border border-zinc-200 bg-white p-4 text-sm">
              <h2 className="mb-2 font-semibold">공개 허용된 필드</h2>
              {disclosed.level === "LEVEL_1" ? (
                <div>
                  <p className="text-zinc-600">{String(disclosed.criterion)}</p>
                  <p className="mt-1 text-2xl font-black">{disclosed.result ? "TRUE" : "FALSE"}</p>
                </div>
              ) : (
                <dl className="grid grid-cols-[180px_1fr] gap-y-1">
                  <dt className="text-zinc-500">검증된 소득 총액</dt>
                  <dd className="font-mono">{usd(disclosed.totalVerifiedIncomeUsdCents)}</dd>
                  <dt className="text-zinc-500">월평균 소득</dt>
                  <dd className="font-mono">{usd(disclosed.avgMonthlyIncomeUsdCents)}</dd>
                  <dt className="text-zinc-500">포함 개월 수</dt>
                  <dd>{String(disclosed.monthsCovered)}</dd>
                  <dt className="text-zinc-500">Payer 수</dt>
                  <dd>{String(disclosed.payerCount)}</dd>
                  <dt className="text-zinc-500">최고 증거 등급</dt>
                  <dd className="font-bold">{String(disclosed.bestGrade)}</dd>
                  <dt className="text-zinc-500">정정 이력</dt>
                  <dd>{disclosed.hasCorrections ? "있음" : "없음"}</dd>
                </dl>
              )}
              {Array.isArray(disclosed.entries) && (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-zinc-200 text-left text-zinc-500">
                        <th className="py-1 pr-2">날짜</th>
                        <th className="py-1 pr-2">사업장</th>
                        <th className="py-1 pr-2 text-right">배분</th>
                        <th className="py-1 pr-2 text-right">지급</th>
                        <th className="py-1 pr-2">원천징수</th>
                        <th className="py-1">등급</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(disclosed.entries as Record<string, unknown>[]).map((entry, i) => (
                        <tr key={i} className="border-b border-zinc-100">
                          <td className="py-1 pr-2">{String(entry.businessDate)}</td>
                          <td className="py-1 pr-2">{String(entry.venue)}</td>
                          <td className="py-1 pr-2 text-right font-mono">
                            {usd(entry.allocatedUsdCents)}
                          </td>
                          <td className="py-1 pr-2 text-right font-mono">
                            {usd(entry.paidUsdCents)}
                          </td>
                          <td className="py-1 pr-2">{String(entry.withholdingStatus)}</td>
                          <td className="py-1 font-bold">{String(entry.evidenceGrade)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          <p className="text-center text-xs text-zinc-400">
            원본 소득 데이터와 PDF는 공개되지 않습니다 · Devnet 테스트 토큰은 화폐 가치가 없습니다
          </p>
        </>
      )}
    </main>
  );
}
