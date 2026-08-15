"use client";

import { Badge, Card } from "@/components/ui";

export interface ActorLabel {
  displayName: string;
  emailMasked: string | null;
}

export interface WorkerConnection {
  key: string;
  workerId: string | null;
  displayName: string;
  emailMasked: string | null;
  connectionStage: "EXTERNAL_ONLY" | "MAPPING_PENDING" | "CONNECTED" | "PAYOUT_READY";
  externalAccounts: {
    provider: string;
    externalWorkerId: string;
    mappingStatus: string;
  }[];
  defaultWalletMasked: string | null;
  latestAllocation: {
    businessDate: string;
    amountUsdCents: number;
    payoutStatus: string;
    calculatedBy: ActorLabel | null;
    approvedBy: ActorLabel | null;
  } | null;
  latestPayout: {
    rail: string;
    status: string;
    signerWalletMasked: string | null;
    submittedBy: ActorLabel | null;
  } | null;
  incomeEntries: { count: number; lastUpdatedAt: string | null };
}

export interface WorkerConnectionsResponse {
  venue: { id: string; name: string; payoutSignerWalletMasked: string | null };
  latestIncomeRebuild: {
    at: string;
    actor: ActorLabel | null;
    source: string;
  } | null;
  members: WorkerConnection[];
}

const usd = (cents: number) => "$" + (cents / 100).toFixed(2);

const actorLabel = (actor: ActorLabel | null, locale: string) => {
  if (!actor) return locale === "ko" ? "기록 없음" : "Not recorded";
  return actor.emailMasked ? actor.displayName + " · " + actor.emailMasked : actor.displayName;
};

const rebuildActorLabel = (
  rebuild: WorkerConnectionsResponse["latestIncomeRebuild"],
  locale: "ko" | "en",
) => {
  if (!rebuild) return "—";
  if (rebuild.actor) return actorLabel(rebuild.actor, locale);
  return (locale === "ko" ? "시스템" : "System") + " · " + rebuild.source;
};

export function WorkerConnections({
  data,
  locale,
}: {
  data: WorkerConnectionsResponse;
  locale: "ko" | "en";
}) {
  const ko = locale === "ko";
  return (
    <Card
      title={ko ? "구성원 및 연결" : "People & connections"}
      description={
        ko
          ? "외부 worker ID부터 로그인 계정, 수취 지갑, 배분·지급·소득원장 행위자까지 한 흐름으로 확인합니다."
          : "Trace each external worker ID through account, wallet, allocation, payout, and income actors."
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-zinc-50 px-4 py-3 text-sm text-zinc-600">
        <span className="font-semibold text-zinc-900">{data.venue.name}</span>
        <span className="text-zinc-300">·</span>
        <span>
          Venue signer:{" "}
          <code className="font-mono text-xs">{data.venue.payoutSignerWalletMasked ?? "—"}</code>
        </span>
        <span className="ml-auto text-xs text-zinc-500">
          {ko ? "최근 IncomeEntry 재계산" : "Latest IncomeEntry rebuild"}:{" "}
          {data.latestIncomeRebuild
            ? rebuildActorLabel(data.latestIncomeRebuild, locale) +
              " · " +
              new Date(data.latestIncomeRebuild.at).toLocaleString(ko ? "ko-KR" : "en-US")
            : "—"}
        </span>
      </div>

      {data.members.length === 0 ? (
        <p className="text-sm text-zinc-400">
          {ko ? "발견되거나 연결된 노동자가 없습니다." : "No workers discovered or connected."}
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {data.members.map((member) => {
            const stageTone =
              member.connectionStage === "PAYOUT_READY"
                ? "CONFIRMED"
                : member.connectionStage === "CONNECTED"
                  ? "CALCULATED"
                  : member.connectionStage === "MAPPING_PENDING"
                    ? "PENDING"
                    : "UNKNOWN";
            const stageLabel = ko
              ? {
                  EXTERNAL_ONLY: "외부 기록만 발견",
                  MAPPING_PENDING: "계정 있음 · 매핑 대기",
                  CONNECTED: "사업장 연결됨",
                  PAYOUT_READY: "지급 준비 완료",
                }[member.connectionStage]
              : member.connectionStage.replaceAll("_", " ");

            return (
              <details
                key={member.key}
                className="group rounded-xl border border-zinc-200 bg-white open:border-emerald-200 open:bg-emerald-50/20"
              >
                <summary className="cursor-pointer list-none p-4 [&::-webkit-details-marker]:hidden">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-zinc-900">{member.displayName}</span>
                        <Badge tone={stageTone}>{stageLabel}</Badge>
                      </div>
                      <p className="mt-1 truncate text-xs text-zinc-500">
                        {member.emailMasked ??
                          (ko ? "ServeProof 계정 미연결" : "No ServeProof account")}
                      </p>
                      <p className="mt-2 font-mono text-xs text-zinc-500">
                        {member.externalAccounts
                          .map((account) => account.provider + " · " + account.externalWorkerId)
                          .join(" / ")}
                      </p>
                    </div>
                    <div className="text-right text-xs text-zinc-500">
                      <p>{member.defaultWalletMasked ?? (ko ? "지갑 없음" : "No wallet")}</p>
                      <p className="mt-1 font-semibold text-zinc-700">
                        {member.latestPayout
                          ? member.latestPayout.rail + " · " + member.latestPayout.status
                          : ko
                            ? "지급 이력 없음"
                            : "No payout"}
                      </p>
                    </div>
                  </div>
                </summary>

                <div className="grid gap-3 border-t border-zinc-200 px-4 py-4 text-xs sm:grid-cols-2">
                  <div>
                    <p className="font-semibold text-zinc-500">{ko ? "연결" : "Identity"}</p>
                    {member.externalAccounts.map((account) => (
                      <p
                        key={account.provider + ":" + account.externalWorkerId}
                        className="mt-1 text-zinc-700"
                      >
                        {account.provider} · {account.externalWorkerId} · {account.mappingStatus}
                      </p>
                    ))}
                    <p className="mt-1 text-zinc-700">
                      {ko ? "수취 지갑" : "Recipient wallet"}: {member.defaultWalletMasked ?? "—"}
                    </p>
                  </div>
                  <div>
                    <p className="font-semibold text-zinc-500">{ko ? "배분" : "Allocation"}</p>
                    <p className="mt-1 text-zinc-700">
                      {member.latestAllocation
                        ? member.latestAllocation.businessDate +
                          " · " +
                          usd(member.latestAllocation.amountUsdCents)
                        : "—"}
                    </p>
                    <p className="mt-1 text-zinc-500">
                      {ko ? "계산자" : "Calculated by"}:{" "}
                      {actorLabel(member.latestAllocation?.calculatedBy ?? null, locale)}
                    </p>
                    <p className="mt-1 text-zinc-500">
                      {ko ? "승인자" : "Approved by"}:{" "}
                      {actorLabel(member.latestAllocation?.approvedBy ?? null, locale)}
                    </p>
                  </div>
                  <div>
                    <p className="font-semibold text-zinc-500">{ko ? "지급" : "Payout"}</p>
                    <p className="mt-1 text-zinc-700">
                      {member.latestPayout
                        ? member.latestPayout.rail + " · " + member.latestPayout.status
                        : "—"}
                    </p>
                    <p className="mt-1 text-zinc-500">
                      {ko ? "서명 지갑" : "Signer wallet"}:{" "}
                      {member.latestPayout?.signerWalletMasked ?? "—"}
                    </p>
                    <p className="mt-1 text-zinc-500">
                      {ko ? "제출 계정" : "Submitted by"}:{" "}
                      {actorLabel(member.latestPayout?.submittedBy ?? null, locale)}
                    </p>
                  </div>
                  <div>
                    <p className="font-semibold text-zinc-500">IncomeEntry</p>
                    <p className="mt-1 text-zinc-700">
                      {member.incomeEntries.count}
                      {ko ? "건" : " entries"}
                    </p>
                    <p className="mt-1 text-zinc-500">
                      {ko ? "최근 재계산자" : "Latest rebuild by"}:{" "}
                      {rebuildActorLabel(data.latestIncomeRebuild, locale)}
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
