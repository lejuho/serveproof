"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
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
import { connectWallet, signTransactionBase64 } from "@/lib/wallet";
import { useI18n } from "@/lib/i18n";
import { apiStaleTime, fetchApiQuery, invalidateApiQueries } from "@/lib/query";
import {
  AppShell,
  Badge,
  Button,
  Callout,
  Card,
  LoadingState,
  inputClass,
  tableCellClass,
  tableHeadClass,
} from "@/components/ui";
import { WorkerConnections, type WorkerConnectionsResponse } from "@/components/worker-connections";
import { VenueStaffingCard } from "@/components/staffing-cards";

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
  businessDates?: string[];
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
  plannedPayoutRail: string | null;
  provider: string | null;
  externalWorkerId: string | null;
  // null → 보류 배분: 아직 계정을 연결하지 않은 외부 직원의 몫
  worker: { defaultWalletId: string | null; user: { displayName: string } } | null;
}
interface SettlementClose {
  businessDate: string;
  batch: { id: string; status: string } | null;
  cash: {
    workerCount: number;
    totalUsdCents: number;
    remainingUsdCents: number;
    observedUsdCents: number;
    retainedUsdCents: number;
    drawerUsdCents: number;
  };
  payroll: { workerCount: number; totalUsdCents: number; remainingUsdCents: number };
  usdc: {
    workerCount: number;
    totalUsdCents: number;
    remainingUsdCents: number;
    missingWalletCount: number;
  };
  unassigned: { workerCount: number; totalUsdCents: number };
  held: { workerCount: number; totalUsdCents: number };
  treasury: {
    status: "AVAILABLE" | "UNAVAILABLE" | "MISCONFIGURED";
    checkedAt: string;
    vaultAddress: string | null;
    vaultBalanceUsdCents: number | null;
    requiredUsdCents: number;
    differenceUsdCents: number | null;
    signerWallet: string | null;
    signerSolLamports: number | null;
    error?: string;
  };
  testAssetWarning: string;
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
  status:
    | "CREATED"
    | "INITIATED"
    | "SUBMITTED"
    | "CONFIRMED"
    | "FINALIZED"
    | "FAILED"
    | "REVERSED"
    | "CORRECTED";
  txSignature: string | null;
}

const PAYOUT_VERIFICATION_ERRORS = [
  "Payout is CONFIRMED",
  "Payout is SUBMITTED",
  "Settlement already exists on-chain",
  "Previous payout blockhash is still valid",
  "Payout transaction blockhash is still valid",
];
const DEFAULT_BUSINESS_DATE = "2026-08-05";

function isPayoutVerificationError(message: string): boolean {
  return PAYOUT_VERIFICATION_ERRORS.some((fragment) => message.includes(fragment));
}

function isPayoutBlockhashExpiredError(message: string): boolean {
  return message.includes("blockhash expired before submission");
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function tusdc(cents: number): string {
  return `${(cents / 100).toFixed(2)} tUSDC`;
}

export default function DashboardPage() {
  const { locale, t } = useI18n();
  const statusLabel = (value: string) => {
    if (locale !== "ko") return value;
    const labels: Record<string, string> = {
      DRAFT: "작성 중",
      CALCULATED: "계산 완료",
      REVIEW_REQUIRED: "검토 필요",
      APPROVED: "승인 완료",
      UNPAID: "지급 전",
      PENDING: "처리 중",
      PAID: "지급 완료",
      FAILED: "실패",
      CREATED: "요청 생성됨",
      INITIATED: "전송 준비 중",
      SUBMITTED: "전송됨",
      CONFIRMED: "확인됨",
      FINALIZED: "최종 확정",
    };
    return labels[value] ?? value;
  };
  const issueLabel = (issue: Batch["reviewIssues"][number]) => {
    if (locale !== "ko") return `${issue.code} ${JSON.stringify(issue.detail)}`;
    const amount =
      typeof issue.detail.amountUsdCents === "number" ? usd(issue.detail.amountUsdCents) : null;
    switch (issue.code) {
      case "REFUNDED_PAYMENT_EXCLUDED":
        return `${amount ? `${amount}의 ` : ""}환불된 결제는 배분 대상에서 제외했습니다.`;
      case "CANCELED_PAYMENT_EXCLUDED":
        return `${amount ? `${amount}의 ` : ""}취소된 결제는 배분 대상에서 제외했습니다.`;
      case "UNMAPPED_WORKER":
        return `계정에 연결되지 않은 직원(${String(issue.detail.externalWorkerId ?? "정보 없음")})의 근무 기록이 있습니다.`;
      case "NON_POSITIVE_MINUTES":
        return "근무 시간이 올바르지 않은 기록이 있습니다. 근무 시간을 확인해 주세요.";
      case "UNKNOWN_ROLE":
        return `배분 정책에 등록되지 않은 직무(${String(issue.detail.role ?? "정보 없음")})가 있습니다.`;
      case "EMPTY_POOL":
        return "이 영업일에는 배분할 팁이 없습니다.";
      case "NO_ELIGIBLE_SHIFTS":
        return "배분 대상에 포함할 수 있는 근무 기록이 없습니다.";
      default:
        return "배분 전에 확인해야 할 항목이 있습니다.";
    }
  };
  const router = useRouter();
  const queryClient = useQueryClient();
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [venueId, setVenueId] = useState<string>("");
  const [csvText, setCsvText] = useState("");
  const [mappingEmails, setMappingEmails] = useState<Record<string, string>>({});
  const [mappingMessage, setMappingMessage] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteProvider, setInviteProvider] = useState("");
  const [inviteExternalId, setInviteExternalId] = useState("");
  const [setupOrgName, setSetupOrgName] = useState("");
  const [setupVenueName, setSetupVenueName] = useState("");
  const [setupTimezone, setSetupTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York",
  );
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState("MANAGER");
  const [memberMessage, setMemberMessage] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportSummary | null>(null);
  const [unmapped, setUnmapped] = useState<UnmappedResponse | null>(null);
  const [businessDate, setBusinessDate] = useState(DEFAULT_BUSINESS_DATE);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [payoutProgress, setPayoutProgress] = useState<Record<string, string>>({});
  // Legacy 증빙 인라인 입력 — 열려 있는 행 id와 참조번호 입력값
  const [legacyOpenFor, setLegacyOpenFor] = useState<string | null>(null);
  const [legacyRef, setLegacyRef] = useState("");
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [rebuildResult, setRebuildResult] = useState<{
    entriesUpserted: number;
    alerts: number;
  } | null>(null);
  const [actionItems, setActionItems] = useState<{
    unmappedWorkerCount: number;
    uncalculatedDates: string[];
    awaitingApprovalCount: number;
    awaitingApproval?: { id: string; businessDate: string; status: string }[];
    unpaidAllocationCount: number;
    unpaidTotalUsdCents: number;
    unpaidBatches?: { id: string; businessDate: string; status: string; unpaidCount: number }[];
  } | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [venueSigner, setVenueSigner] = useState<string | null>(null);
  const [workerConnections, setWorkerConnections] = useState<WorkerConnectionsResponse | null>(
    null,
  );
  const [settlementClose, setSettlementClose] = useState<SettlementClose | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [workspace, setWorkspace] = useState<"staffing" | "settlement">("settlement");
  const [preparationOpen, setPreparationOpen] = useState(false);
  const [availableModes, setAvailableModes] = useState<AppMode[]>([]);
  // React state does not update synchronously, so `busy` alone cannot stop two
  // clicks in the same render frame from opening parallel wallet-sign flows.
  const payoutLocks = useRef(new Set<string>());

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
    fetchApiQuery<Organization[]>(queryClient, "/organizations/mine", apiStaleTime.organization)
      .then(async (data) => {
        setAvailableModes(getCurrentSession()?.modes ?? []);
        setOrgs(data);
        const firstVenue = data.flatMap((o) => o.venues)[0];
        if (!firstVenue) return;

        setVenueId(firstVenue.id);
        const [unmappedData, actionData, connectionsData, closeData, venueData] = await Promise.all(
          [
            fetchApiQuery<UnmappedResponse>(
              queryClient,
              `/venues/${firstVenue.id}/unmapped-workers`,
              apiStaleTime.connections,
            ),
            fetchApiQuery<typeof actionItems>(
              queryClient,
              `/venues/${firstVenue.id}/action-items`,
              apiStaleTime.actionItems,
            ),
            fetchApiQuery<WorkerConnectionsResponse>(
              queryClient,
              `/venues/${firstVenue.id}/worker-connections`,
              apiStaleTime.connections,
            ),
            fetchApiQuery<SettlementClose>(
              queryClient,
              `/venues/${firstVenue.id}/settlement-close?businessDate=${encodeURIComponent(DEFAULT_BUSINESS_DATE)}`,
              apiStaleTime.settlement,
            ),
            fetchApiQuery<{ payoutSignerWallet: string | null }>(
              queryClient,
              `/venues/${firstVenue.id}`,
              apiStaleTime.organization,
            ),
          ],
        );
        setUnmapped(unmappedData);
        setActionItems(actionData);
        setWorkerConnections(connectionsData);
        setSettlementClose(closeData);
        setVenueSigner(venueData.payoutSignerWallet);
      })
      .catch(guard)
      .finally(() => setInitialLoading(false));
  }, [router, guard, queryClient]);

  const loadVenueConnections = useCallback(() => {
    if (!venueId) return;
    fetchApiQuery<UnmappedResponse>(
      queryClient,
      `/venues/${venueId}/unmapped-workers`,
      apiStaleTime.connections,
    )
      .then(setUnmapped)
      .catch(guard);
    fetchApiQuery<typeof actionItems>(
      queryClient,
      `/venues/${venueId}/action-items`,
      apiStaleTime.actionItems,
    )
      .then(setActionItems)
      .catch(guard);
    fetchApiQuery<WorkerConnectionsResponse>(
      queryClient,
      `/venues/${venueId}/worker-connections`,
      apiStaleTime.connections,
    )
      .then(setWorkerConnections)
      .catch(guard);
  }, [venueId, guard, queryClient]);

  const refreshUnmapped = useCallback(async () => {
    if (!venueId) return;
    await invalidateApiQueries(queryClient, [
      `/venues/${venueId}/unmapped-workers`,
      `/venues/${venueId}/action-items`,
      `/venues/${venueId}/worker-connections`,
    ]);
    loadVenueConnections();
  }, [venueId, queryClient, loadVenueConnections]);

  const loadSettlementClose = useCallback(() => {
    if (!venueId || !businessDate) return;
    fetchApiQuery<SettlementClose>(
      queryClient,
      `/venues/${venueId}/settlement-close?businessDate=${encodeURIComponent(businessDate)}`,
      apiStaleTime.settlement,
    )
      .then(setSettlementClose)
      .catch(guard);
  }, [venueId, businessDate, guard, queryClient]);

  const refreshSettlementClose = useCallback(async () => {
    if (!venueId || !businessDate) return;
    await invalidateApiQueries(queryClient, [
      `/venues/${venueId}/settlement-close?businessDate=${encodeURIComponent(businessDate)}`,
    ]);
    loadSettlementClose();
  }, [venueId, businessDate, queryClient, loadSettlementClose]);

  useEffect(() => {
    loadSettlementClose();
  }, [loadSettlementClose]);

  useEffect(() => {
    loadVenueConnections();
    setBatch(null);
    setImportResult(null);
    setRebuildResult(null);
    if (venueId) {
      fetchApiQuery<{ payoutSignerWallet: string | null }>(
        queryClient,
        `/venues/${venueId}`,
        apiStaleTime.organization,
      )
        .then((venue) => setVenueSigner(venue.payoutSignerWallet))
        .catch(guard);
    }
  }, [venueId, loadVenueConnections, guard, queryClient]);

  const connect = () =>
    run(async () => {
      setWalletAddress(await connectWallet());
    });

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

  const createFirstVenue = () =>
    run(async () => {
      const orgName = setupOrgName.trim();
      const venueName = setupVenueName.trim();
      const timezone = setupTimezone.trim();
      if (!venueName || !timezone) return;
      // 기존 조직이 있으면 사업장만 추가하고, 없으면 조직부터 만든다
      let organizationId = orgs[0]?.id;
      if (!organizationId) {
        if (!orgName) return;
        const org = await api<{ id: string }>("/organizations", {
          method: "POST",
          body: { legalName: orgName, displayName: orgName, country: "US", timezone },
        });
        organizationId = org.id;
      }
      await api("/venues", {
        method: "POST",
        body: { organizationId, name: venueName, timezone },
      });
      await invalidateApiQueries(queryClient, ["/organizations/mine"]);
      // 세션 모드(staff)와 초기 로딩 흐름을 다시 타도록 전체 리로드
      window.location.reload();
    });

  const inviteOrgMember = () =>
    run(async () => {
      const organizationId = orgs[0]?.id;
      const email = memberEmail.trim();
      if (!organizationId || !email) return;
      await api(`/organizations/${organizationId}/members`, {
        method: "POST",
        body: { email, role: memberRole },
      });
      setMemberEmail("");
      setMemberMessage(
        locale === "ko"
          ? `${email}을(를) ${memberRole} 역할로 추가했습니다.`
          : `${email} was added as ${memberRole}.`,
      );
    });

  const refreshBatch = useCallback(async () => {
    if (!batch) return;
    const refreshed = await api<Batch>(`/allocation-batches/${batch.id}`);
    setBatch(refreshed);
  }, [batch]);

  /** 데모용 Toast POS 데이터 — 오늘 영업일 기준으로 임의 금액 CSV를 생성해 채운다. */
  const fillToastDemoCsv = () => {
    const today = new Date().toISOString().slice(0, 10);
    const rnd = (min: number, max: number) => (Math.random() * (max - min) + min).toFixed(2);
    setCsvText(
      [
        "provider,venue_external_id,worker_external_id,shift_external_id,tip_type,gross_tip,clock_in,clock_out,role,payout_route,payroll_status",
        `toast_mock,venue_demo,smoke.a,${today}_s1,CARD_TIP,${rnd(90, 180)},${today}T17:00:00Z,${today}T22:00:00Z,SERVER,PAYROLL,PROVIDER_CONFIRMED`,
        `toast_mock,venue_demo,smoke.b,${today}_s2,CARD_TIP,${rnd(60, 150)},${today}T17:30:00Z,${today}T23:00:00Z,SERVER,USDC,PENDING`,
        `toast_mock,venue_demo,demo.b,${today}_s3,CARD_TIP,${rnd(50, 120)},${today}T18:00:00Z,${today}T23:30:00Z,SERVER,USDC,PENDING`,
        `toast_mock,venue_demo,demo.b,${today}_s3,CASH_TIP,${rnd(10, 40)},${today}T18:00:00Z,${today}T23:30:00Z,SERVER,USDC,PENDING`,
      ].join("\n"),
    );
    setSyncMessage(null);
  };

  /** Square Sandbox에서 최근 14일 증거를 실제로 동기화 (worker가 처리). */
  const syncSquare = () =>
    run(async () => {
      const end = new Date().toISOString().slice(0, 10);
      const start = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
      const res = await api<{ jobId: string; status: string }>("/evidence/sync", {
        method: "POST",
        body: { venueId, provider: "square", startDate: start, endDate: end },
      });
      setSyncMessage(`${t("dash.source.syncQueued")} (job ${res.jobId})`);
      setTimeout(refreshUnmapped, 5000);
    });

  const importCsv = () =>
    run(async () => {
      const result = await api<ImportSummary>("/providers/csv/import", {
        method: "POST",
        body: { venueId, csvText },
      });
      setImportResult(result);
      // 임포트된 CSV의 최신 영업일을 계산 날짜로 자동 선택
      const latest = result.businessDates?.at(-1);
      if (latest) setBusinessDate(latest);
      refreshUnmapped();
    });

  const sendMappingRequest = async (
    provider: string,
    externalWorkerId: string,
    workerEmail: string,
  ) => {
    const result = await api<{ invitationEmailSent: boolean; accountCreated: boolean }>(
      "/worker-mappings",
      {
        method: "POST",
        body: { venueId, provider, externalWorkerId, workerEmail },
      },
    );
    setMappingMessage(
      result.accountCreated
        ? result.invitationEmailSent
          ? locale === "ko"
            ? `${workerEmail}은 아직 계정이 없어 새로 만들어 두고 로그인 안내를 보냈습니다. 직원이 첫 로그인 후 수락하면 연결됩니다.`
            : `${workerEmail} had no account yet — one was created and a sign-in email was sent. The connection completes once they log in and accept.`
          : locale === "ko"
            ? `${workerEmail} 계정을 새로 만들어 연결 요청을 걸어두었습니다. 직원에게 이 이메일로 로그인해 수락하라고 알려주세요.`
            : `An account was created for ${workerEmail} with the request waiting. Ask them to sign in with this email and accept.`
        : result.invitationEmailSent
          ? locale === "ko"
            ? `${workerEmail}로 연결 요청을 보냈습니다.`
            : `Connection request sent to ${workerEmail}.`
          : locale === "ko"
            ? "연결 요청을 만들었습니다. 직원이 ServeProof 근무 탭에서 수락해야 합니다."
            : "Connection request created. The worker must accept it from their Work tab.",
    );
    refreshUnmapped();
  };

  const requestWorkerMapping = (provider: string, externalWorkerId: string) =>
    run(async () => {
      const key = `${provider}:${externalWorkerId}`;
      const workerEmail = mappingEmails[key]?.trim();
      if (!workerEmail) return;
      await sendMappingRequest(provider, externalWorkerId, workerEmail);
      setMappingEmails((current) => ({ ...current, [key]: "" }));
    });

  const inviteNewWorker = () =>
    run(async () => {
      const workerEmail = inviteEmail.trim();
      const provider = inviteProvider.trim();
      const externalWorkerId = inviteExternalId.trim();
      if (!workerEmail || !provider || !externalWorkerId) return;
      await sendMappingRequest(provider, externalWorkerId, workerEmail);
      setInviteEmail("");
      setInviteExternalId("");
    });

  const calculate = () =>
    run(async () => {
      const result = await api<Batch>("/allocation-batches/calculate", {
        method: "POST",
        body: { venueId, businessDate },
      });
      setBatch(result);
      refreshSettlementClose();
    });

  const approve = () =>
    run(async () => {
      if (!batch) return;
      await api(`/allocation-batches/${batch.id}/approve`, { method: "POST", body: {} });
      await refreshBatch();
      refreshUnmapped();
      refreshSettlementClose();
    });

  const scrollToCard = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  const openPreparation = () => {
    setPreparationOpen(true);
    window.setTimeout(() => scrollToCard("card-mapping"), 0);
  };

  // 오늘 할 일 타일 클릭 → 해당 배치를 3단계 카드에 로드하고 이동
  const openBatch = (b: { id: string; businessDate: string }) =>
    run(async () => {
      setBusinessDate(b.businessDate);
      setBatch(await api<Batch>(`/allocation-batches/${b.id}`));
      scrollToCard("card-alloc");
    });

  const setProgress = (allocationId: string, message: string) =>
    setPayoutProgress((prev) => ({ ...prev, [allocationId]: message }));

  /** Spec §29.4 flow: create → unsigned tx → wallet signs → submit → poll. */
  const payUsdc = async (allocationId: string) => {
    if (payoutLocks.current.has(allocationId)) return;
    payoutLocks.current.add(allocationId);
    setBusy(true);
    setError(null);
    try {
      await payUsdcInner(allocationId);
    } catch (e) {
      // 실패를 그 행에 그대로 표시 — "생성 중…"으로 고착되지 않게
      const message = e instanceof Error ? e.message : String(e);
      if (isPayoutVerificationError(message)) {
        // §29.7 가드는 정상적인 안전 상태다. 행에는 안내문을 표시하되
        // 같은 409 영어 원문을 전역 오류 Callout에 다시 노출하지 않는다.
        setProgress(allocationId, t("dash.progress.verifying"));
        await refreshBatch().catch(guard);
      } else if (isPayoutBlockhashExpiredError(message)) {
        setProgress(allocationId, t("dash.progress.expired"));
        await refreshBatch().catch(guard);
      } else {
        setProgress(allocationId, `${t("dash.progress.failed")}: ${message}`);
        guard(e);
      }
    } finally {
      payoutLocks.current.delete(allocationId);
      setBusy(false);
    }
  };

  const payUsdcInner = async (allocationId: string) => {
    {
      setProgress(allocationId, t("dash.progress.create"));
      const payout = await api<Payout>("/payouts", { method: "POST", body: { allocationId } });

      // POST /payouts is idempotent and may return an existing attempt. Never
      // rebuild or request another signature while that attempt is resolving.
      if (["SUBMITTED", "CONFIRMED"].includes(payout.status)) {
        setProgress(allocationId, t("dash.progress.verifying"));
        await refreshBatch();
        refreshUnmapped();
        return;
      }
      if (payout.status === "FINALIZED") {
        setProgress(allocationId, `${t("dash.progress.onchain")} FINALIZED`);
        await refreshBatch();
        refreshUnmapped();
        return;
      }

      setProgress(allocationId, t("dash.progress.build"));
      const tx = await api<{ transactionBase64: string; signer: string }>(
        `/payouts/${payout.id}/transaction`,
      );

      setProgress(allocationId, t("dash.progress.sign"));
      const signed = await signTransactionBase64(tx.transactionBase64, tx.signer);

      setProgress(allocationId, t("dash.progress.submit"));
      await api(`/payouts/${payout.id}/submit`, {
        method: "POST",
        body: { signedTransactionBase64: signed },
      });

      let terminal = false;
      for (let i = 0; i < 30; i++) {
        const current = await api<Payout>(`/payouts/${payout.id}`);
        setProgress(
          allocationId,
          current.status === "CONFIRMED"
            ? t("dash.progress.confirmed")
            : `${t("dash.progress.onchain")} ${statusLabel(current.status)}`,
        );
        if (["FINALIZED", "FAILED"].includes(current.status)) {
          terminal = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (!terminal) setProgress(allocationId, t("dash.progress.verifying"));
      await refreshBatch();
      refreshUnmapped();
      refreshSettlementClose();
    }
  };

  const payLegacy = (allocation: Allocation, reference: string) =>
    run(async () => {
      try {
        await api("/payouts/legacy-evidence", {
          method: "POST",
          body: {
            allocationId: allocation.id,
            rail:
              allocation.plannedPayoutRail && allocation.plannedPayoutRail !== "USDC"
                ? allocation.plannedPayoutRail
                : "PAYROLL",
            externalReference: reference,
          },
        });
        setProgress(allocation.id, t("dash.progress.legacyDone"));
        setLegacyOpenFor(null);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setProgress(allocation.id, `${t("dash.progress.failed")}: ${message}`);
        throw e;
      }
      await refreshBatch();
      refreshUnmapped();
      refreshSettlementClose();
    });

  const setPlannedRail = (allocationId: string, rail: string) =>
    run(async () => {
      await api(`/allocation-batches/allocations/${allocationId}/planned-rail`, {
        method: "PATCH",
        body: { rail },
      });
      await refreshBatch();
      refreshSettlementClose();
    });

  const exportPayroll = () =>
    run(async () => {
      const result = await api<{ filename: string; csv: string }>(
        `/venues/${venueId}/payroll-export?businessDate=${encodeURIComponent(businessDate)}`,
      );
      const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    });

  const rebuildIncome = () =>
    run(async () => {
      const result = await api<{ entriesUpserted: number; alerts: number }>(
        `/venues/${venueId}/income/rebuild`,
        { method: "POST", body: {} },
      );
      setRebuildResult(result);
      refreshUnmapped();
    });

  const payable = batch && ["PAYABLE", "PARTIALLY_PAID", "PAID"].includes(batch.status);

  if (initialLoading) {
    return (
      <LoadingState fullScreen title={t("loading.dashboard")} description={t("loading.wait")} />
    );
  }

  if (!orgs.some((org) => org.venues.length > 0)) {
    return (
      <AppShell
        title={locale === "ko" ? "사업장 관리" : "Venue Dashboard"}
        subtitle={
          locale === "ko"
            ? "아직 등록된 사업장이 없습니다."
            : "No venue is registered for this account yet."
        }
        right={
          <span className="flex items-center gap-4">
            <a
              href="/login?switch=1"
              className="text-sm font-medium text-zinc-500 hover:text-zinc-700"
            >
              {t("auth.switch")}
            </a>
            <button
              onClick={async () => {
                await logoutSession();
                router.push("/login?switch=1");
              }}
              className="text-sm font-medium text-zinc-500 hover:text-zinc-700"
            >
              {t("logout")}
            </button>
          </span>
        }
      >
        {error && <Callout tone="red">{error}</Callout>}
        <Card
          title={locale === "ko" ? "새 사업장 열기" : "Open your venue"}
          description={
            locale === "ko"
              ? "조직과 사업장을 만들면 기본 배분 정책(SERVER 1.0 · BUSSER 0.7 · BARTENDER 1.0)이 함께 준비되어 바로 팁 증빙을 모으고 배분을 계산할 수 있습니다."
              : "Creating your organization and venue also sets up a default allocation policy (SERVER 1.0 · BUSSER 0.7 · BARTENDER 1.0), so you can collect tip evidence and calculate allocations right away."
          }
        >
          <div className="grid max-w-xl gap-4">
            {!orgs[0] && (
              <label className="block text-sm font-medium text-zinc-700">
                {locale === "ko" ? "조직(브랜드) 이름" : "Organization (brand) name"}
                <input
                  className={`${inputClass} mt-1.5`}
                  value={setupOrgName}
                  onChange={(event) => setSetupOrgName(event.target.value)}
                  placeholder={locale === "ko" ? "예: 한강 다이닝 그룹" : "e.g. Riverside Dining Group"}
                />
              </label>
            )}
            <label className="block text-sm font-medium text-zinc-700">
              {locale === "ko" ? "사업장 이름" : "Venue name"}
              <input
                className={`${inputClass} mt-1.5`}
                value={setupVenueName}
                onChange={(event) => setSetupVenueName(event.target.value)}
                placeholder={locale === "ko" ? "예: 한강 다이너 성수점" : "e.g. Riverside Diner"}
              />
            </label>
            <label className="block text-sm font-medium text-zinc-700">
              {locale === "ko" ? "영업 타임존" : "Business timezone"}
              <input
                className={`${inputClass} mt-1.5`}
                list="setup-timezone-options"
                value={setupTimezone}
                onChange={(event) => setSetupTimezone(event.target.value)}
              />
              <datalist id="setup-timezone-options">
                {[
                  "America/New_York",
                  "America/Chicago",
                  "America/Denver",
                  "America/Los_Angeles",
                  "Asia/Seoul",
                  "UTC",
                ].map((timezone) => (
                  <option key={timezone} value={timezone} />
                ))}
              </datalist>
              <span className="mt-1.5 block text-xs text-zinc-500">
                {locale === "ko"
                  ? "영업일(정산 날짜)이 이 타임존 기준으로 계산됩니다."
                  : "Business dates for settlement are computed in this timezone."}
              </span>
            </label>
            <div>
              <Button
                onClick={createFirstVenue}
                disabled={
                  busy ||
                  !setupVenueName.trim() ||
                  !setupTimezone.trim() ||
                  (!orgs[0] && !setupOrgName.trim())
                }
              >
                {locale === "ko" ? "사업장 만들기" : "Create venue"}
              </Button>
            </div>
          </div>
          <p className="mt-5 rounded-xl bg-zinc-50 px-4 py-3 text-xs leading-relaxed text-zinc-600">
            {locale === "ko"
              ? "만든 직후부터 POS 동기화·CSV 임포트, 직원 연결, 배분 계산, 증빙 지급, 소득 증명이 모두 사용 가능합니다. USDC 온체인 지급만 운영팀의 온체인 사업장 등록(금고 개설) 후 활성화됩니다 — 마감 화면의 금고 상태에서 진행 상황을 확인할 수 있습니다."
              : "POS sync, CSV import, worker connections, allocation, attested payouts, and income proofs work immediately. Only on-chain USDC payouts wait for the operations team to register the venue on-chain (vault setup) — the settlement close screen shows that status."}
          </p>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell
      wide
      title={locale === "ko" ? "사업장 관리" : "Venue Dashboard"}
      subtitle={t("dash.subtitle")}
      right={
        <>
          <select
            className="max-w-64 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 shadow-sm outline-none focus:border-emerald-500"
            value={venueId}
            onChange={(e) => setVenueId(e.target.value)}
          >
            {orgs.flatMap((org) =>
              org.venues.map((v) => (
                <option key={v.id} value={v.id}>
                  {org.displayName} / {v.name}
                </option>
              )),
            )}
          </select>
          {availableModes.includes("worker") && (
            <button
              type="button"
              onClick={() => {
                const destination = switchAppMode("worker");
                if (destination) router.push(destination);
              }}
              className="text-sm font-medium text-emerald-700 hover:text-emerald-800"
            >
              {t("auth.viewAsWorker")}
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
        </>
      }
    >
      {error && <Callout tone="red">{error}</Callout>}

      {walletAddress && venueSigner && walletAddress !== venueSigner && (
        <Callout tone="amber">
          {t("dash.banner.signerMismatch")}{" "}
          <code className="font-mono text-xs">
            {walletAddress.slice(0, 8)}…{walletAddress.slice(-6)}
          </code>{" "}
          ≠{" "}
          <code className="font-mono text-xs">
            {venueSigner.slice(0, 8)}…{venueSigner.slice(-6)}
          </code>
        </Callout>
      )}

      {actionItems && (
        <Card title={t("dash.todo.title")} description={t("dash.todo.desc")}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                label: t("dash.todo.unmapped"),
                value: String(actionItems.unmappedWorkerCount),
                urgent: actionItems.unmappedWorkerCount > 0,
                action: actionItems.unmappedWorkerCount > 0 ? openPreparation : undefined,
                cta: t("dash.todo.cta.map"),
              },
              {
                label: t("dash.todo.uncalculated"),
                value: String(actionItems.uncalculatedDates.length),
                detail: actionItems.uncalculatedDates.slice(0, 3).join(", "),
                urgent: actionItems.uncalculatedDates.length > 0,
                action: actionItems.uncalculatedDates.length
                  ? () => {
                      setBusinessDate(actionItems.uncalculatedDates[0] ?? businessDate);
                      scrollToCard("card-alloc");
                    }
                  : undefined,
                cta: t("dash.todo.cta.calc"),
              },
              {
                label: t("dash.todo.approval"),
                value: String(actionItems.awaitingApprovalCount),
                detail: actionItems.awaitingApproval
                  ?.slice(0, 2)
                  .map((b) => b.businessDate)
                  .join(", "),
                urgent: actionItems.awaitingApprovalCount > 0,
                action: (() => {
                  const target = actionItems.awaitingApproval?.[0];
                  return target ? () => openBatch(target) : undefined;
                })(),
                cta: t("dash.todo.cta.review"),
              },
              {
                label: t("dash.todo.unpaid"),
                value: `${actionItems.unpaidAllocationCount}`,
                detail:
                  actionItems.unpaidAllocationCount > 0
                    ? usd(actionItems.unpaidTotalUsdCents)
                    : undefined,
                urgent: actionItems.unpaidAllocationCount > 0,
                action: (() => {
                  const target = actionItems.unpaidBatches?.[0];
                  return target ? () => openBatch(target) : undefined;
                })(),
                cta: t("dash.todo.cta.pay"),
              },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={item.action}
                disabled={!item.action}
                className={`rounded-xl border p-4 text-left transition ${
                  item.urgent
                    ? "cursor-pointer border-amber-300 bg-amber-50/70 hover:border-amber-400 hover:shadow-sm"
                    : "cursor-default border-zinc-200 bg-zinc-50/60"
                }`}
              >
                <p className="text-xs font-medium text-zinc-500">{item.label}</p>
                <p
                  className={`mt-1 text-2xl font-bold tabular-nums ${
                    item.urgent ? "text-amber-700" : "text-zinc-400"
                  }`}
                >
                  {item.value}
                </p>
                {item.detail && <p className="mt-0.5 text-xs text-zinc-500">{item.detail}</p>}
                {item.action && (
                  <p className="mt-2 text-xs font-semibold text-amber-700">{item.cta} →</p>
                )}
              </button>
            ))}
          </div>
        </Card>
      )}

      <div
        role="tablist"
        aria-label={locale === "ko" ? "사업장 작업공간" : "Venue workspace"}
        className="grid grid-cols-2 gap-2 rounded-2xl border border-zinc-200 bg-zinc-100 p-1.5"
      >
        {[
          {
            value: "staffing" as const,
            title: locale === "ko" ? "인력 운영" : "Staffing",
            detail:
              locale === "ko"
                ? "모집 · 초대 · 출퇴근 · 근무 승인"
                : "Recruit · invite · attendance · approval",
          },
          {
            value: "settlement" as const,
            title: locale === "ko" ? "정산 · 소득" : "Settlement & income",
            detail:
              locale === "ko"
                ? "증거 · 배분 · 지급 · 소득원장"
                : "Evidence · allocation · payout · ledger",
          },
        ].map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={workspace === tab.value}
            onClick={() => setWorkspace(tab.value)}
            className={`rounded-xl px-4 py-3 text-left transition ${
              workspace === tab.value
                ? "bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200"
                : "text-zinc-500 hover:bg-white/60"
            }`}
          >
            <span className="block text-sm font-semibold">{tab.title}</span>
            <span className="mt-0.5 block text-xs">{tab.detail}</span>
          </button>
        ))}
      </div>

      {workspace === "staffing" && venueId && (
        <VenueStaffingCard
          venueId={venueId}
          connections={workerConnections}
          locale={locale}
          onGoToSettlement={() => setWorkspace("settlement")}
        />
      )}

      {workspace === "settlement" && (
        <>
          <details
            open={preparationOpen}
            onToggle={(event) => setPreparationOpen(event.currentTarget.open)}
            className="group rounded-2xl border border-zinc-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
          >
            <summary className="flex cursor-pointer list-none items-center gap-3 px-6 py-5 [&::-webkit-details-marker]:hidden">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-sm font-bold text-zinc-500">
                {actionItems?.unmappedWorkerCount ? "!" : "✓"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold text-zinc-900">
                  {locale === "ko" ? "데이터 및 직원 준비" : "Data and worker setup"}
                </span>
                <span className="mt-0.5 block text-sm text-zinc-500">
                  {actionItems?.unmappedWorkerCount
                    ? locale === "ko"
                      ? `계정 연결 작업이 남은 직원 ${actionItems.unmappedWorkerCount}명이 있습니다.`
                      : `${actionItems.unmappedWorkerCount} workers need account connection.`
                    : locale === "ko"
                      ? "기록 가져오기와 직원 연결은 필요할 때만 펼쳐서 처리합니다."
                      : "Open only when importing records or connecting workers."}
                </span>
              </span>
              <span className="text-sm font-semibold text-zinc-500 group-open:hidden">
                {locale === "ko" ? "펼치기" : "Open"} ↓
              </span>
              <span className="hidden text-sm font-semibold text-zinc-500 group-open:inline">
                {locale === "ko" ? "접기" : "Close"} ↑
              </span>
            </summary>

            <div className="flex flex-col gap-4 border-t border-zinc-100 p-4 sm:p-6">
              {workerConnections && <WorkerConnections data={workerConnections} locale={locale} />}

              <Card
                title={locale === "ko" ? "팁 및 근무 기록 가져오기" : "CSV Import"}
                description={t("dash.csv.desc")}
              >
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                    {t("dash.source.label")}
                  </span>
                  <Button size="sm" variant="secondary" onClick={fillToastDemoCsv} disabled={busy}>
                    🍞 {t("dash.source.toast")}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={syncSquare}
                    disabled={busy || !venueId}
                  >
                    ⬛ {t("dash.source.square")}
                  </Button>
                  {syncMessage && <span className="text-sm text-emerald-700">{syncMessage}</span>}
                </div>
                <textarea
                  className={`${inputClass} h-32 font-mono text-xs leading-relaxed`}
                  placeholder="provider,venue_external_id,worker_external_id,..."
                  value={csvText}
                  onChange={(e) => setCsvText(e.target.value)}
                />
                <div className="mt-3 flex items-center gap-4">
                  <Button
                    variant="dark"
                    onClick={importCsv}
                    disabled={busy || !csvText || !venueId}
                  >
                    {locale === "ko" ? "가져오기" : "Import"}
                  </Button>
                  {importResult && (
                    <p className="text-sm text-zinc-500">
                      {locale === "ko" ? (
                        <>
                          팁 <b className="text-zinc-800">{importResult.tipsUpserted}건</b>, 근무
                          기록 <b className="text-zinc-800">{importResult.shiftsUpserted}건</b>{" "}
                          (매핑 {importResult.mappedShifts} / 연결 필요{" "}
                          {importResult.unmappedShifts})
                          {importResult.errors.length > 0 && (
                            <span className="text-red-600">
                              . 오류 {importResult.errors.length}건
                            </span>
                          )}
                          {!!importResult.businessDates?.length && (
                            <span className="text-emerald-700">
                              {" "}
                              . 영업일 {importResult.businessDates.join(", ")}을 확인해 계산 날짜로
                              자동 선택했습니다.
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          <b className="text-zinc-800">{importResult.tipsUpserted}</b> tips,{" "}
                          <b className="text-zinc-800">{importResult.shiftsUpserted}</b> shifts (
                          {importResult.mappedShifts} mapped / {importResult.unmappedShifts}{" "}
                          unmapped)
                          {importResult.errors.length > 0 && (
                            <span className="text-red-600">
                              . {importResult.errors.length} errors
                            </span>
                          )}
                          {!!importResult.businessDates?.length && (
                            <span className="text-emerald-700">
                              {" "}
                              . Detected {importResult.businessDates.join(", ")}; calculation date
                              was selected automatically.
                            </span>
                          )}
                        </>
                      )}
                    </p>
                  )}
                </div>
              </Card>

              <div id="card-mapping" className="scroll-mt-6" />
              <Card
                title={locale === "ko" ? "직원 계정 연결 요청" : "Worker account requests"}
                description={
                  locale === "ko"
                    ? "POS의 외부 직원 ID에 ServeProof 이메일 계정을 지정하세요. 직원이 직접 수락해야 연결됩니다."
                    : "Choose a ServeProof email for each POS worker ID. The worker must accept the request."
                }
              >
                {mappingMessage && <Callout tone="emerald">{mappingMessage}</Callout>}
                <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50/40 p-4">
                  <p className="text-sm font-semibold text-zinc-900">
                    {locale === "ko" ? "새 직원 연결" : "Connect a new hire"}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-600">
                    {locale === "ko"
                      ? "근무 데이터가 들어오기 전에도 고용 시점에 바로 연결을 시작할 수 있습니다. 계정이 없는 이메일이면 자동으로 만들어지고 로그인 안내 메일이 발송됩니다."
                      : "Start the connection at hiring time, before any work data arrives. If the email has no account yet, one is created and a sign-in email goes out."}
                  </p>
                  <div className="mt-3 grid gap-3 md:grid-cols-[1.3fr_1fr_1fr_auto] md:items-end">
                    <label className="block text-xs font-medium text-zinc-600">
                      {locale === "ko" ? "직원 이메일" : "Worker email"}
                      <input
                        type="email"
                        className={`${inputClass} mt-1`}
                        value={inviteEmail}
                        onChange={(event) => setInviteEmail(event.target.value)}
                        placeholder="name@example.com"
                      />
                    </label>
                    <label className="block text-xs font-medium text-zinc-600">
                      {locale === "ko" ? "데이터 소스 (POS)" : "Data source (POS)"}
                      <input
                        className={`${inputClass} mt-1`}
                        list="invite-provider-options"
                        value={inviteProvider}
                        onChange={(event) => setInviteProvider(event.target.value)}
                        placeholder="toast_mock"
                      />
                      <datalist id="invite-provider-options">
                        {[
                          ...new Set([
                            ...(unmapped?.unmappedShiftWorkers.map((w) => w.provider) ?? []),
                            ...(unmapped?.pendingMappings.map((m) => m.provider) ?? []),
                            "toast_mock",
                            "square",
                          ]),
                        ].map((provider) => (
                          <option key={provider} value={provider} />
                        ))}
                      </datalist>
                    </label>
                    <label className="block text-xs font-medium text-zinc-600">
                      {locale === "ko" ? "외부 직원 ID" : "External worker ID"}
                      <input
                        className={`${inputClass} mt-1`}
                        value={inviteExternalId}
                        onChange={(event) => setInviteExternalId(event.target.value)}
                        placeholder="worker_001"
                      />
                    </label>
                    <Button
                      variant="dark"
                      onClick={inviteNewWorker}
                      disabled={
                        busy ||
                        !inviteEmail.trim() ||
                        !inviteProvider.trim() ||
                        !inviteExternalId.trim()
                      }
                    >
                      {locale === "ko" ? "연결 요청" : "Send request"}
                    </Button>
                  </div>
                  <p className="mt-2 text-xs text-zinc-500">
                    {locale === "ko"
                      ? "데이터 소스와 외부 직원 ID는 POS/CSV에서 쓰는 값과 같아야 이후 근무 기록이 자동으로 이 직원에게 연결됩니다."
                      : "Use the same provider and worker ID as your POS/CSV so future work records attach to this worker automatically."}
                  </p>
                </div>
                {unmapped &&
                unmapped.unmappedShiftWorkers.length === 0 &&
                unmapped.pendingMappings.length === 0 ? (
                  <p className="text-sm text-zinc-400">
                    {locale === "ko"
                      ? "계정 연결이 필요한 직원이 없습니다."
                      : "No workers need account connection."}
                  </p>
                ) : (
                  <div className="space-y-4">
                    {unmapped && unmapped.unmappedShiftWorkers.length > 0 && (
                      <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
                          {locale === "ko" ? "계정 미매칭" : "Account not matched"}
                        </p>
                        <ul className="flex flex-col gap-2">
                          {unmapped.unmappedShiftWorkers.map((worker) => {
                            const key = `${worker.provider}:${worker.externalWorkerId}`;
                            return (
                              <li
                                key={key}
                                className="grid gap-3 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 md:grid-cols-[1fr_1.4fr_auto] md:items-center"
                              >
                                <span>
                                  <b className="font-mono text-sm">{worker.externalWorkerId}</b>
                                  <span className="ml-2 text-xs text-zinc-400">
                                    {worker.provider}
                                  </span>
                                </span>
                                <input
                                  type="email"
                                  className={inputClass}
                                  value={mappingEmails[key] ?? ""}
                                  onChange={(event) =>
                                    setMappingEmails((current) => ({
                                      ...current,
                                      [key]: event.target.value,
                                    }))
                                  }
                                  placeholder={
                                    locale === "ko"
                                      ? "직원의 ServeProof 로그인 이메일"
                                      : "Worker’s ServeProof login email"
                                  }
                                />
                                <Button
                                  size="sm"
                                  variant="dark"
                                  onClick={() =>
                                    requestWorkerMapping(worker.provider, worker.externalWorkerId)
                                  }
                                  disabled={busy || !mappingEmails[key]?.trim()}
                                >
                                  {locale === "ko" ? "연결 요청" : "Send request"}
                                </Button>
                              </li>
                            );
                          })}
                        </ul>
                        <p className="mt-2 text-xs text-zinc-500">
                          {locale === "ko"
                            ? "계정이 없는 이메일이면 자동으로 만들어지고, 직원이 이 이메일로 로그인해 수락하면 연결됩니다."
                            : "If the email has no account yet, one is created automatically; the worker signs in with it and accepts."}
                        </p>
                      </div>
                    )}
                    {unmapped && unmapped.pendingMappings.length > 0 && (
                      <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
                          {locale === "ko" ? "직원 수락 대기" : "Waiting for worker acceptance"}
                        </p>
                        <ul className="flex flex-col gap-2">
                          {unmapped.pendingMappings.map((m) => (
                            <li
                              key={m.id}
                              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-200 bg-blue-50/50 px-4 py-3"
                            >
                              <span className="text-[15px]">
                                <b className="font-mono text-sm">{m.externalWorkerId}</b>
                                <span className="text-zinc-400"> ({m.provider})</span>
                                <span className="mx-2 text-zinc-400">→</span>
                                {m.worker.user.displayName} · {m.worker.user.email}
                              </span>
                              <Badge tone="PENDING">
                                {locale === "ko" ? "직원 수락 대기" : "Awaiting worker"}
                              </Badge>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </Card>

              <Card
                title={locale === "ko" ? "조직 멤버" : "Organization members"}
                description={
                  locale === "ko"
                    ? "매니저·급여 담당자에게 이 대시보드 접근 권한을 부여합니다. 초대할 사람은 해당 이메일로 ServeProof에 한 번 로그인한 상태여야 합니다."
                    : "Grant dashboard access to managers and payroll staff. The invitee must have signed in to ServeProof once with this email."
                }
              >
                {memberMessage && <Callout tone="emerald">{memberMessage}</Callout>}
                <div className="mt-3 grid gap-3 md:grid-cols-[1.4fr_1fr_auto] md:items-end">
                  <label className="block text-xs font-medium text-zinc-600">
                    {locale === "ko" ? "이메일" : "Email"}
                    <input
                      type="email"
                      className={`${inputClass} mt-1`}
                      value={memberEmail}
                      onChange={(event) => setMemberEmail(event.target.value)}
                      placeholder="manager@example.com"
                    />
                  </label>
                  <label className="block text-xs font-medium text-zinc-600">
                    {locale === "ko" ? "역할" : "Role"}
                    <select
                      className={`${inputClass} mt-1`}
                      value={memberRole}
                      onChange={(event) => setMemberRole(event.target.value)}
                    >
                      <option value="MANAGER">MANAGER</option>
                      <option value="PAYROLL_ADMIN">PAYROLL_ADMIN</option>
                      <option value="VIEWER">VIEWER</option>
                      <option value="OWNER">OWNER</option>
                    </select>
                  </label>
                  <Button
                    variant="dark"
                    onClick={inviteOrgMember}
                    disabled={busy || !memberEmail.trim()}
                  >
                    {locale === "ko" ? "추가" : "Add"}
                  </Button>
                </div>
              </Card>
            </div>
          </details>

          <div className="px-1 pt-2">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
              {locale === "ko" ? "오늘의 마감" : "Today’s close"}
            </p>
            <h2 className="mt-1 text-xl font-semibold text-zinc-900">
              {locale === "ko" ? "계산부터 지급까지" : "From calculation to payout"}
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
              {locale === "ko"
                ? "영업일을 선택해 배분을 승인하고, 경로별 준비 상태를 확인한 뒤 지급을 완료합니다."
                : "Choose a business date, approve allocations, review each rail, and complete payouts."}
            </p>
          </div>

          <div id="card-alloc" className="scroll-mt-6" />
          <Card step={1} title={t("dash.alloc.title")} description={t("dash.alloc.desc")}>
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="date"
                className={`${inputClass} w-auto`}
                value={businessDate}
                onChange={(e) => setBusinessDate(e.target.value)}
              />
              <Button variant="dark" onClick={calculate} disabled={busy || !venueId}>
                {t("dash.calc")}
              </Button>
              <Button onClick={approve} disabled={busy || batch?.status !== "CALCULATED"}>
                {t("dash.approve")}
              </Button>
            </div>

            {batch && (
              <div className="mt-5 flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-3 rounded-xl bg-zinc-50 px-4 py-3">
                  <Badge tone={batch.status}>{statusLabel(batch.status)}</Badge>
                  <span className="text-sm text-zinc-500">
                    {batch.businessDate} · {t("dash.policy")} v{batch.policyVersion}
                  </span>
                  <span className="ml-auto text-sm text-zinc-500">
                    {t("dash.pool")}{" "}
                    <b className="text-lg font-bold tracking-tight text-zinc-900 tabular-nums">
                      {usd(batch.tipPoolAmountUsdCents)}
                    </b>
                  </span>
                </div>

                {batch.reviewIssues.length > 0 && (
                  <ul className="flex flex-col gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    {batch.reviewIssues.map((issue, i) => (
                      <li key={i} className="text-xs leading-relaxed">
                        {issue.blocking ? "확인 필요:" : "안내:"} {issueLabel(issue)}
                      </li>
                    ))}
                  </ul>
                )}

                {!payable && batch.allocations.length > 0 && (
                  <table className="w-full">
                    <thead>
                      <tr>
                        <th className={tableHeadClass}>{t("worker")}</th>
                        <th className={`${tableHeadClass} text-right`}>{t("amount")}</th>
                        <th className={tableHeadClass}>
                          {locale === "ko" ? "정산 경로" : "Settlement route"}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {batch.allocations.map((a) => (
                        <tr key={a.id}>
                          <td className={tableCellClass}>
                            {a.worker ? (
                              a.worker.user.displayName
                            ) : (
                              <span className="inline-flex flex-wrap items-center gap-2">
                                <code className="font-mono text-sm">{a.externalWorkerId}</code>
                                <Badge tone="REVIEW_REQUIRED">
                                  {locale === "ko" ? "연결 대기" : "Awaiting connection"}
                                </Badge>
                              </span>
                            )}
                          </td>
                          <td className={`${tableCellClass} text-right font-semibold tabular-nums`}>
                            {usd(a.netAllocatedUsdCents)}
                          </td>
                          <td className={tableCellClass}>
                            <select
                              className={`${inputClass} py-1.5 text-sm`}
                              value={a.plannedPayoutRail ?? ""}
                              onChange={(e) => setPlannedRail(a.id, e.target.value)}
                              disabled={busy || !a.worker}
                            >
                              <option value="" disabled>
                                {locale === "ko" ? "미지정" : "Unassigned"}
                              </option>
                              <option value="CASH_RETAINED">CASH_RETAINED</option>
                              <option value="CASH_DRAWER">CASH_DRAWER</option>
                              <option value="PAYROLL">PAYROLL</option>
                              <option value="USDC">USDC</option>
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </Card>

          {settlementClose && (
            <Card
              step={2}
              title={locale === "ko" ? "정산 경로별 마감" : "Settlement close by route"}
              description={
                locale === "ko"
                  ? "현금·급여·USDC마다 필요한 마감 작업과 준비 상태를 분리해서 확인합니다."
                  : "Review close tasks and readiness separately for cash, payroll, and USDC."
              }
            >
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-xl border border-zinc-200 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                    Cash
                  </p>
                  <p className="mt-2 text-2xl font-bold tabular-nums">
                    {usd(settlementClose.cash.observedUsdCents)}
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {locale === "ko" ? "관측 현금 팁" : "Observed cash tips"} ·{" "}
                    {settlementClose.cash.workerCount}
                    {locale === "ko" ? "명" : " workers"}
                  </p>
                  <p className="mt-3 text-xs text-zinc-500">
                    {locale === "ko" ? "직원 보유" : "Retained"}{" "}
                    {usd(settlementClose.cash.retainedUsdCents)} ·{" "}
                    {locale === "ko" ? "금고/서랍" : "Drawer"}{" "}
                    {usd(settlementClose.cash.drawerUsdCents)}
                  </p>
                  <p className="mt-2 text-xs font-medium text-emerald-700">
                    {locale === "ko"
                      ? "직원 보유분은 추가 지급 없이 신고만 확인합니다."
                      : "Retained cash needs reporting confirmation, not another payout."}
                  </p>
                </div>
                <div className="rounded-xl border border-zinc-200 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                    Payroll
                  </p>
                  <p className="mt-2 text-2xl font-bold tabular-nums">
                    {usd(settlementClose.payroll.remainingUsdCents)}
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {settlementClose.payroll.workerCount}
                    {locale === "ko" ? "명 · 급여 반영 필요" : " workers · remaining"}
                  </p>
                  <Button
                    className="mt-3"
                    size="sm"
                    variant="secondary"
                    onClick={exportPayroll}
                    disabled={busy || !settlementClose.batch}
                  >
                    {locale === "ko" ? "급여 CSV 내보내기" : "Export payroll CSV"}
                  </Button>
                </div>
                <div className="rounded-xl border border-violet-200 bg-violet-50/40 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-violet-500">
                    USDC · Devnet
                  </p>
                  <p className="mt-2 text-2xl font-bold tabular-nums">
                    {usd(settlementClose.usdc.remainingUsdCents)}
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {settlementClose.usdc.workerCount}
                    {locale === "ko" ? "명" : " workers"} ·{" "}
                    {locale === "ko" ? "지갑 누락" : "missing wallets"}{" "}
                    {settlementClose.usdc.missingWalletCount}
                  </p>
                  <div className="mt-3 space-y-1 text-xs text-zinc-600">
                    <p>
                      {locale === "ko" ? "vault tUSDC" : "Vault tUSDC"}:{" "}
                      {settlementClose.treasury.vaultBalanceUsdCents === null
                        ? "—"
                        : tusdc(settlementClose.treasury.vaultBalanceUsdCents)}
                    </p>
                    <p>
                      {locale === "ko" ? "이번 마감 필요" : "Required for close"}:{" "}
                      {tusdc(settlementClose.treasury.requiredUsdCents)}
                    </p>
                    <p>
                      {locale === "ko" ? "부족/여유" : "Shortfall/surplus"}:{" "}
                      {settlementClose.treasury.differenceUsdCents === null
                        ? "—"
                        : `${settlementClose.treasury.differenceUsdCents >= 0 ? "+" : ""}${tusdc(settlementClose.treasury.differenceUsdCents)}`}
                    </p>
                    <p>
                      {locale === "ko" ? "Signer SOL" : "Signer SOL"}:{" "}
                      {settlementClose.treasury.signerSolLamports === null
                        ? "—"
                        : `${(settlementClose.treasury.signerSolLamports / 1_000_000_000).toFixed(4)} SOL`}
                    </p>
                    <p>
                      {locale === "ko" ? "마지막 RPC 확인" : "Last RPC check"}:{" "}
                      {new Date(settlementClose.treasury.checkedAt).toLocaleString()}
                    </p>
                  </div>
                </div>
              </div>
              {settlementClose.unassigned.workerCount > 0 && (
                <Callout tone="amber">
                  {locale === "ko"
                    ? `정산 경로 미지정 ${settlementClose.unassigned.workerCount}명 · ${usd(settlementClose.unassigned.totalUsdCents)}`
                    : `${settlementClose.unassigned.workerCount} workers (${usd(settlementClose.unassigned.totalUsdCents)}) have no settlement route.`}
                </Callout>
              )}
              {(settlementClose.held?.workerCount ?? 0) > 0 && (
                <Callout tone="amber">
                  {locale === "ko"
                    ? `계정 연결 대기 몫 ${settlementClose.held.workerCount}건 · ${usd(settlementClose.held.totalUsdCents)} — 직원이 연결을 수락하면 지급 가능해집니다.`
                    : `${settlementClose.held.workerCount} held share(s) totaling ${usd(settlementClose.held.totalUsdCents)} await account connection before payout.`}
                </Callout>
              )}
              <Callout tone="amber">
                {locale === "ko"
                  ? "Devnet tUSDC는 금전 가치가 없는 테스트 자산입니다."
                  : settlementClose.testAssetWarning}
                {settlementClose.treasury.error ? ` · ${settlementClose.treasury.error}` : ""}
              </Callout>
            </Card>
          )}

          {batch && payable && (
            <Card step={3} title={t("dash.payout.title")} description={t("dash.payout.desc")}>
              <Callout tone="amber">{t("dash.payout.callout")}</Callout>
              <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-zinc-50 px-4 py-3">
                {walletAddress ? (
                  <>
                    <Badge tone={walletAddress === venueSigner ? "CONFIRMED" : "FAILED"}>
                      {t("dash.wallet.connected")} ·{" "}
                      {walletAddress === venueSigner
                        ? t("dash.wallet.match")
                        : t("dash.wallet.mismatch")}
                    </Badge>
                    <code className="text-xs text-zinc-500">
                      {walletAddress.slice(0, 8)}…{walletAddress.slice(-6)}
                    </code>
                  </>
                ) : (
                  <Button size="sm" variant="secondary" onClick={connect} disabled={busy}>
                    {t("dash.wallet.connect")}
                  </Button>
                )}
                {venueSigner && (
                  <span className="ml-auto text-xs text-zinc-400">
                    {t("dash.wallet.expectedSigner")}:{" "}
                    <code>
                      {venueSigner.slice(0, 8)}…{venueSigner.slice(-6)}
                    </code>
                  </span>
                )}
              </div>
              <table className="mt-4 w-full">
                <thead>
                  <tr>
                    <th className={tableHeadClass}>{t("worker")}</th>
                    <th className={`${tableHeadClass} text-right`}>{t("amount")}</th>
                    <th className={tableHeadClass}>{t("status")}</th>
                    <th className={tableHeadClass}>{t("actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.allocations.map((a) => (
                    <tr key={a.id}>
                      <td className={`${tableCellClass} font-medium text-zinc-900`}>
                        {a.worker ? (
                          a.worker.user.displayName
                        ) : (
                          <span className="inline-flex flex-wrap items-center gap-2">
                            <code className="font-mono text-sm">{a.externalWorkerId}</code>
                            <Badge tone="REVIEW_REQUIRED">
                              {locale === "ko" ? "연결 대기" : "Awaiting connection"}
                            </Badge>
                          </span>
                        )}
                      </td>
                      <td className={`${tableCellClass} text-right font-semibold tabular-nums`}>
                        {usd(a.netAllocatedUsdCents)}
                      </td>
                      <td className={tableCellClass}>
                        <Badge tone={a.payoutStatus}>
                          {statusLabel(a.payoutStatus)}
                          {a.payoutRail
                            ? ` · ${a.payoutRail}`
                            : a.plannedPayoutRail
                              ? ` · ${locale === "ko" ? "예정" : "planned"} ${a.plannedPayoutRail}`
                              : ""}
                        </Badge>
                        {payoutProgress[a.id] && (
                          <span className="ml-2 text-xs text-zinc-400">{payoutProgress[a.id]}</span>
                        )}
                        {a.payoutStatus !== "PAID" && a.worker && (
                          <select
                            aria-label={
                              locale === "ko" ? "예정 정산 경로" : "Planned settlement route"
                            }
                            className="mt-2 block rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-600"
                            value={a.plannedPayoutRail ?? ""}
                            onChange={(e) => setPlannedRail(a.id, e.target.value)}
                            disabled={busy}
                          >
                            <option value="" disabled>
                              {locale === "ko" ? "경로 미지정" : "Unassigned"}
                            </option>
                            <option value="CASH_RETAINED">CASH_RETAINED</option>
                            <option value="CASH_DRAWER">CASH_DRAWER</option>
                            <option value="PAYROLL">PAYROLL</option>
                            <option value="USDC">USDC</option>
                          </select>
                        )}
                      </td>
                      <td className={tableCellClass}>
                        {a.payoutStatus !== "PAID" && !a.worker && (
                          <span className="text-xs leading-relaxed text-zinc-500">
                            {locale === "ko"
                              ? "직원이 계정을 연결하면 지급할 수 있습니다."
                              : "Payable once the worker connects an account."}
                          </span>
                        )}
                        {a.payoutStatus !== "PAID" && a.worker && (
                          <span className="flex gap-2">
                            <Button
                              size="sm"
                              variant="violet"
                              onClick={() => payUsdc(a.id)}
                              disabled={busy || !a.worker.defaultWalletId}
                              title={
                                a.worker.defaultWalletId ? undefined : t("dash.payout.noWallet")
                              }
                            >
                              {t("dash.payout.usdc")}
                            </Button>
                            {!a.worker.defaultWalletId && (
                              <span className="self-center text-xs text-zinc-400">
                                {t("dash.payout.noWallet")}
                              </span>
                            )}
                            {legacyOpenFor === a.id ? (
                              <span className="flex items-center gap-1.5">
                                <input
                                  autoFocus
                                  className={`${inputClass} w-44 px-2.5 py-1.5 text-sm`}
                                  value={legacyRef}
                                  onChange={(e) => setLegacyRef(e.target.value)}
                                  placeholder={t("dash.payout.refPlaceholder")}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && legacyRef.trim())
                                      payLegacy(a, legacyRef.trim());
                                    if (e.key === "Escape") setLegacyOpenFor(null);
                                  }}
                                />
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => payLegacy(a, legacyRef.trim())}
                                  disabled={busy || !legacyRef.trim()}
                                >
                                  {t("dash.payout.refConfirm")}
                                </Button>
                                <button
                                  type="button"
                                  onClick={() => setLegacyOpenFor(null)}
                                  className="text-xs text-zinc-400 hover:text-zinc-600"
                                >
                                  {t("dash.payout.refCancel")}
                                </button>
                              </span>
                            ) : (
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => {
                                  setLegacyRef("");
                                  setLegacyOpenFor(a.id);
                                }}
                                disabled={busy}
                              >
                                {t("dash.payout.legacy")}
                              </Button>
                            )}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <details className="group rounded-2xl border border-zinc-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <summary className="flex cursor-pointer list-none items-center gap-3 px-6 py-5 [&::-webkit-details-marker]:hidden">
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold text-zinc-900">
                  {locale === "ko" ? "검증 및 이력" : "Verification and history"}
                </span>
                <span className="mt-0.5 block text-sm text-zinc-500">
                  {locale === "ko"
                    ? "지급 내역을 변경했거나 소득 상태가 맞지 않을 때 확인합니다."
                    : "Review after payout changes or when income status needs reconciliation."}
                </span>
              </span>
              <span className="text-sm font-semibold text-zinc-500 group-open:hidden">
                {locale === "ko" ? "펼치기" : "Open"} ↓
              </span>
              <span className="hidden text-sm font-semibold text-zinc-500 group-open:inline">
                {locale === "ko" ? "접기" : "Close"} ↑
              </span>
            </summary>
            <div className="border-t border-zinc-100 px-6 py-5">
              <h3 className="font-semibold text-zinc-900">
                {locale === "ko" ? "소득 상태 확인" : "Income status"}
              </h3>
              <p className="mt-1 text-sm text-zinc-500">{t("dash.income.desc")}</p>
              <div className="mt-4 flex flex-wrap items-center gap-4">
                <Button variant="dark" onClick={rebuildIncome} disabled={busy || !venueId}>
                  {t("dash.income.rebuild")}
                </Button>
                {rebuildResult && (
                  <span className="text-sm text-zinc-500">
                    {locale === "ko"
                      ? `소득 내역 ${rebuildResult.entriesUpserted}건을 새로고침했습니다. 확인 필요 항목은 ${rebuildResult.alerts}건입니다.`
                      : `${rebuildResult.entriesUpserted} income entries refreshed. ${rebuildResult.alerts} items require review.`}
                  </span>
                )}
              </div>
              <p className="mt-3 text-sm text-zinc-400">
                {t("dash.income.note1")}{" "}
                <b className="text-zinc-600">{t("dash.income.myIncome")}</b>{" "}
                {t("dash.income.note2")}
              </p>
            </div>
          </details>
        </>
      )}
    </AppShell>
  );
}
