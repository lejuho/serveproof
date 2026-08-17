"use client";

import { Badge, Button, Card } from "@/components/ui";

export interface VenueConnection {
  venue: { id: string; name: string };
  connectionStage: "MAPPING_PENDING" | "CONNECTED" | "PAYOUT_READY";
  externalAccounts: {
    id: string;
    provider: string;
    externalWorkerId: string;
    mappingStatus: string;
    verifiedAt: string | null;
  }[];
  defaultWalletMasked: string | null;
  latestAllocation: {
    businessDate: string;
    amountUsdCents: number;
    payoutStatus: string;
    payoutRail: string | null;
  } | null;
  latestPayout: {
    rail: string;
    status: string;
    txSignature: string | null;
    settledAt: string | null;
  } | null;
  incomeEntries: { count: number; lastUpdatedAt: string | null };
}

const usd = (cents: number) => "$" + (cents / 100).toFixed(2);

export function VenueConnectionCards({
  connections,
  locale,
  respondingId,
  onRespond,
}: {
  connections: VenueConnection[];
  locale: "ko" | "en";
  respondingId?: string | null;
  onRespond?: (mappingId: string, decision: "ACCEPT" | "REJECT") => void;
}) {
  const ko = locale === "ko";
  const empty = ko ? "없음" : "Not available";
  const mappingStatus = (status: string) =>
    ko
      ? ({ PENDING: "확인 대기", CONFIRMED: "연결됨", REJECTED: "연결 거절" }[status] ?? status)
      : status;
  const payoutStatus = (status: string) =>
    ko
      ? ({
          UNPAID: "지급 전",
          PENDING: "지급 처리 중",
          PAID: "지급 완료",
          FAILED: "지급 실패",
        }[status] ?? status)
      : status;
  return (
    <Card
      title={ko ? "연결된 사업장" : "Connected venues"}
      description={
        ko
          ? "사업장별 계정 연결, 수취 지갑, 최근 배분 및 지급 내역을 확인할 수 있습니다."
          : "Your external identity, payout wallet, latest settlement, and income ledger by venue."
      }
    >
      {connections.length === 0 ? (
        <p className="text-sm text-zinc-400">
          {ko ? "연결된 사업장이 없습니다." : "No connected venues."}
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {connections.map((connection) => {
            const stageLabel =
              connection.connectionStage === "PAYOUT_READY"
                ? ko
                  ? "지급 준비 완료"
                  : "Payout ready"
                : connection.connectionStage === "CONNECTED"
                  ? ko
                    ? "사업장 연결됨"
                    : "Connected"
                  : ko
                    ? "계정 연결 대기"
                    : "Mapping pending";
            return (
              <details
                key={connection.venue.id}
                open={connection.connectionStage === "MAPPING_PENDING"}
                className="rounded-xl border border-zinc-200 bg-white open:border-emerald-200 open:bg-emerald-50/20"
              >
                <summary className="cursor-pointer list-none p-4 [&::-webkit-details-marker]:hidden">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-zinc-900">{connection.venue.name}</p>
                      <p className="mt-1 font-mono text-xs text-zinc-500">
                        {connection.externalAccounts
                          .map((account) => account.provider + " · " + account.externalWorkerId)
                          .join(" / ")}
                      </p>
                    </div>
                    <Badge
                      tone={
                        connection.connectionStage === "PAYOUT_READY"
                          ? "CONFIRMED"
                          : connection.connectionStage === "CONNECTED"
                            ? "CALCULATED"
                            : "PENDING"
                      }
                    >
                      {stageLabel}
                    </Badge>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
                    <span className="rounded bg-zinc-100 px-2 py-1">
                      {ko ? "외부 ID" : "External ID"}
                    </span>
                    <span>→</span>
                    <span className="rounded bg-blue-50 px-2 py-1 text-blue-700">ServeProof</span>
                    <span>→</span>
                    <span className="rounded bg-zinc-100 px-2 py-1">
                      {connection.defaultWalletMasked ?? (ko ? "지갑 없음" : "No wallet")}
                    </span>
                    <span>→</span>
                    <span className="rounded bg-emerald-50 px-2 py-1 text-emerald-700">
                      {ko ? "소득 내역" : "Income entries"} {connection.incomeEntries.count}
                    </span>
                  </div>
                </summary>
                <div className="grid gap-3 border-t border-zinc-200 px-4 py-4 text-xs sm:grid-cols-2">
                  <div>
                    <p className="font-semibold text-zinc-500">
                      {ko ? "사업장 계정 연결" : "Venue identity"}
                    </p>
                    {connection.externalAccounts.map((account) => (
                      <div
                        key={account.provider + ":" + account.externalWorkerId}
                        className="mt-2 rounded-lg border border-zinc-200 bg-white p-3 text-zinc-700"
                      >
                        <p>
                          {account.provider} · {account.externalWorkerId} ·{" "}
                          {mappingStatus(account.mappingStatus)}
                        </p>
                        {account.mappingStatus === "PENDING" && onRespond && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              onClick={() => onRespond(account.id, "ACCEPT")}
                              disabled={Boolean(respondingId)}
                              loading={respondingId === account.id}
                              loadingLabel={ko ? "처리 중…" : "Saving…"}
                            >
                              {ko ? "내 근무 계정이 맞습니다" : "Accept connection"}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => onRespond(account.id, "REJECT")}
                              disabled={Boolean(respondingId)}
                            >
                              {ko ? "내 계정이 아닙니다" : "Reject"}
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                    <p className="mt-1 text-zinc-700">
                      {ko ? "수취 지갑" : "Recipient wallet"}:{" "}
                      {connection.defaultWalletMasked ?? empty}
                    </p>
                  </div>
                  <div>
                    <p className="font-semibold text-zinc-500">
                      {ko ? "최근 정산" : "Latest settlement"}
                    </p>
                    <p className="mt-1 text-zinc-700">
                      {connection.latestAllocation
                        ? connection.latestAllocation.businessDate +
                          " · " +
                          usd(connection.latestAllocation.amountUsdCents)
                        : empty}
                    </p>
                    <p className="mt-1 text-zinc-500">
                      {ko ? "지급" : "Payout"}:{" "}
                      {connection.latestPayout
                        ? connection.latestPayout.rail +
                          " · " +
                          payoutStatus(connection.latestPayout.status)
                        : empty}
                    </p>
                    <p className="mt-1 text-zinc-500">
                      {ko ? "소득 내역" : "Income entries"}: {connection.incomeEntries.count}
                      {ko ? "건" : " entries"}
                    </p>
                  </div>
                </div>
              </details>
            );
          })}
        </div>
      )}
    </Card>
  );
}
