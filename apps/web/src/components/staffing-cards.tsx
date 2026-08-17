"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Badge, Button, Callout, Card, inputClass, LoadingState } from "@/components/ui";
import type { WorkerConnectionsResponse } from "@/components/worker-connections";

interface StaffingAssignment {
  id: string;
  workerId: string;
  status: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  approvedAt: string | null;
  shiftEvidenceId: string | null;
  worker?: { user: { displayName: string; email: string } };
}

interface StaffingShift {
  id: string;
  role: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  hourlyRateUsdCents: number;
  expectedTipUsdCents: number;
  headcount: number;
  status: string;
  venue?: { id: string; name: string; timezone: string };
  assignments: StaffingAssignment[];
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const localInput = (date: Date) => {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
};
const twoDigits = (value: number) => String(value).padStart(2, "0");

function LocalDateTimeField({
  label,
  value,
  locale,
  onChange,
}: {
  label: string;
  value: string;
  locale: "ko" | "en";
  onChange: (value: string) => void;
}) {
  const [datePart = "", timePart = ""] = value.split("T");
  const [yearValue, monthValue, dayValue] = datePart.split("-").map(Number);
  const [hourValue, minuteValue] = timePart.split(":").map(Number);
  const now = new Date();
  const validPart = (part: number | undefined, fallback: number) =>
    typeof part === "number" && Number.isFinite(part) ? part : fallback;
  const year = validPart(yearValue, now.getFullYear());
  const month = validPart(monthValue, now.getMonth() + 1);
  const day = validPart(dayValue, now.getDate());
  const hour = validPart(hourValue, 0);
  const minute = validPart(minuteValue, 0);
  const years = Array.from(
    new Set([year, ...Array.from({ length: 5 }, (_, index) => now.getFullYear() - 1 + index)]),
  ).sort((a, b) => a - b);
  const daysInMonth = new Date(year, month, 0).getDate();
  const minutes = Array.from(
    new Set([minute, ...Array.from({ length: 12 }, (_, i) => i * 5)]),
  ).sort((a, b) => a - b);

  const update = (
    next: Partial<{ year: number; month: number; day: number; hour: number; minute: number }>,
  ) => {
    const nextYear = next.year ?? year;
    const nextMonth = next.month ?? month;
    const maxDay = new Date(nextYear, nextMonth, 0).getDate();
    const nextDay = Math.min(next.day ?? day, maxDay);
    onChange(
      `${nextYear}-${twoDigits(nextMonth)}-${twoDigits(nextDay)}T${twoDigits(next.hour ?? hour)}:${twoDigits(next.minute ?? minute)}`,
    );
  };

  const selectClass = `${inputClass} min-w-0 px-2.5 py-2.5 text-sm tabular-nums`;
  return (
    <fieldset className="min-w-0 md:col-span-4">
      <legend className="text-xs font-medium text-zinc-600">{label}</legend>
      <div className="mt-1 grid grid-cols-3 gap-1.5 rounded-xl border border-zinc-200 bg-white p-2 sm:grid-cols-[1.35fr_1fr_1fr_1fr_1fr]">
        <select
          aria-label={locale === "ko" ? `${label} 연도` : `${label} year`}
          className={selectClass}
          value={year}
          onChange={(event) => update({ year: Number(event.target.value) })}
        >
          {years.map((item) => (
            <option key={item} value={item}>
              {item}
              {locale === "ko" ? "년" : ""}
            </option>
          ))}
        </select>
        <select
          aria-label={locale === "ko" ? `${label} 월` : `${label} month`}
          className={selectClass}
          value={month}
          onChange={(event) => update({ month: Number(event.target.value) })}
        >
          {Array.from({ length: 12 }, (_, index) => index + 1).map((item) => (
            <option key={item} value={item}>
              {twoDigits(item)}
              {locale === "ko" ? "월" : ""}
            </option>
          ))}
        </select>
        <select
          aria-label={locale === "ko" ? `${label} 일` : `${label} day`}
          className={selectClass}
          value={Math.min(day, daysInMonth)}
          onChange={(event) => update({ day: Number(event.target.value) })}
        >
          {Array.from({ length: daysInMonth }, (_, index) => index + 1).map((item) => (
            <option key={item} value={item}>
              {twoDigits(item)}
              {locale === "ko" ? "일" : ""}
            </option>
          ))}
        </select>
        <select
          aria-label={locale === "ko" ? `${label} 시` : `${label} hour`}
          className={selectClass}
          value={hour}
          onChange={(event) => update({ hour: Number(event.target.value) })}
        >
          {Array.from({ length: 24 }, (_, item) => item).map((item) => (
            <option key={item} value={item}>
              {twoDigits(item)}
            </option>
          ))}
        </select>
        <select
          aria-label={locale === "ko" ? `${label} 분` : `${label} minute`}
          className={selectClass}
          value={minute}
          onChange={(event) => update({ minute: Number(event.target.value) })}
        >
          {minutes.map((item) => (
            <option key={item} value={item}>
              {twoDigits(item)}
            </option>
          ))}
        </select>
      </div>
      <p className="mt-1 text-[11px] text-zinc-400">
        {locale === "ko"
          ? "연 · 월 · 일 · 시 · 분 (24시간제)"
          : "Year · month · day · hour · minute (24-hour)"}
      </p>
    </fieldset>
  );
}
const statusTone = (status: string) =>
  ["OPEN", "ACCEPTED", "APPROVED", "COMPLETED"].includes(status)
    ? "CONFIRMED"
    : ["FILLED", "CLOCKED_IN", "CLOCKED_OUT", "INVITED"].includes(status)
      ? "PENDING"
      : ["CANCELLED", "DECLINED", "NO_SHOW"].includes(status)
        ? "FAILED"
        : "UNKNOWN";

function staffingStatus(status: string, ko: boolean) {
  if (!ko) return status.replaceAll("_", " ");
  return (
    {
      DRAFT: "작성 중",
      OPEN: "모집 중",
      FILLED: "모집 완료",
      IN_PROGRESS: "근무 중",
      COMPLETED: "완료",
      CANCELLED: "취소",
      INVITED: "초대됨",
      ACCEPTED: "수락",
      DECLINED: "거절",
      CLOCKED_IN: "출근",
      CLOCKED_OUT: "퇴근",
      APPROVED: "근무 승인",
      NO_SHOW: "노쇼",
    }[status] ?? status
  );
}

export function VenueStaffingCard({
  venueId,
  connections,
  locale,
  onGoToSettlement,
}: {
  venueId: string;
  connections: WorkerConnectionsResponse | null;
  locale: "ko" | "en";
  onGoToSettlement: () => void;
}) {
  const ko = locale === "ko";
  const startDefault = useMemo(() => {
    const date = new Date();
    date.setHours(date.getHours() + 2, 0, 0, 0);
    return localInput(date);
  }, []);
  const endDefault = useMemo(() => {
    const date = new Date();
    date.setHours(date.getHours() + 7, 0, 0, 0);
    return localInput(date);
  }, []);
  const [shifts, setShifts] = useState<StaffingShift[]>([]);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState("SERVER");
  const [description, setDescription] = useState("");
  const [startsAt, setStartsAt] = useState(startDefault);
  const [endsAt, setEndsAt] = useState(endDefault);
  const [hourlyRate, setHourlyRate] = useState("18.00");
  const [expectedTips, setExpectedTips] = useState("30.00");
  const [headcount, setHeadcount] = useState("1");
  const [inviteWorker, setInviteWorker] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(() => {
    if (!venueId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    api<StaffingShift[]>(`/staffing/venues/${venueId}/shifts`)
      .then(setShifts)
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setLoading(false));
  }, [venueId]);

  useEffect(() => refresh(), [refresh]);

  async function mutate(
    action: () => Promise<unknown>,
    successMessage = ko ? "변경사항을 저장했습니다." : "Changes saved.",
    after?: () => void,
  ) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setSuccess(successMessage);
      window.setTimeout(() => setSuccess(null), 3500);
      after?.();
      refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const connectedWorkers =
    connections?.members.filter(
      (member) => member.workerId && ["CONNECTED", "PAYOUT_READY"].includes(member.connectionStage),
    ) ?? [];

  return (
    <Card
      title={ko ? "직원 모집 및 근무 승인" : "Staffing and work approval"}
      description={
        ko
          ? "연결된 노동자를 모집하고 실제 출퇴근이 승인되면 기존 배분·소득 흐름에 근무 증거로 연결합니다."
          : "Staff connected workers, then turn approved attendance into evidence for allocation and income workflows."
      }
    >
      {success && (
        <div className="fixed right-6 top-6 z-50 rounded-xl bg-emerald-700 px-4 py-3 text-sm font-semibold text-white shadow-lg">
          {success}
        </div>
      )}
      {error && <Callout tone="red">{error}</Callout>}
      <ol className="mb-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {(ko
          ? ["1. 근무 조건", "2. 모집·초대", "3. 출퇴근 확인", "4. 근무 승인"]
          : ["1. Shift details", "2. Recruit", "3. Attendance", "4. Approval"]
        ).map((step) => (
          <li key={step} className="rounded-lg bg-zinc-100 px-3 py-2 font-medium text-zinc-600">
            {step}
          </li>
        ))}
      </ol>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-500">
          {ko
            ? "현재 단계에 필요한 기본 버튼만 따라가면 됩니다."
            : "Follow the primary action shown for each shift state."}
        </p>
        <Button variant="dark" onClick={() => setShowCreate((current) => !current)}>
          {showCreate
            ? ko
              ? "입력 닫기"
              : "Close form"
            : ko
              ? "+ 새 시프트 만들기"
              : "+ New shift"}
        </Button>
      </div>
      {showCreate && (
        <div className="grid gap-3 rounded-xl border border-zinc-200 bg-zinc-50/60 p-4 md:grid-cols-4">
          <label className="text-xs font-medium text-zinc-600">
            {ko ? "역할" : "Role"}
            <select
              className={`${inputClass} mt-1`}
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              <option value="SERVER">{ko ? "서버" : "Server"}</option>
              <option value="BARTENDER">{ko ? "바텐더" : "Bartender"}</option>
              <option value="BUSSER">{ko ? "버서" : "Busser"}</option>
              <option value="KITCHEN">{ko ? "주방" : "Kitchen"}</option>
              <option value="EVENT_STAFF">{ko ? "이벤트 스태프" : "Event staff"}</option>
              <option value="OTHER">{ko ? "기타" : "Other"}</option>
            </select>
          </label>
          <label className="text-xs font-medium text-zinc-600 md:col-span-3">
            {ko ? "업무 설명" : "Description"}
            <input
              className={`${inputClass} mt-1`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={ko ? "복장, 담당 구역, 필요한 경험" : "Attire, station, or experience"}
            />
          </label>
          <LocalDateTimeField
            label={ko ? "시작" : "Starts"}
            value={startsAt}
            locale={locale}
            onChange={setStartsAt}
          />
          <LocalDateTimeField
            label={ko ? "종료" : "Ends"}
            value={endsAt}
            locale={locale}
            onChange={setEndsAt}
          />
          <label className="text-xs font-medium text-zinc-600">
            {ko ? "시급 USD" : "Hourly USD"}
            <input
              inputMode="decimal"
              className={`${inputClass} mt-1`}
              value={hourlyRate}
              onChange={(event) => setHourlyRate(event.target.value)}
            />
          </label>
          <label className="text-xs font-medium text-zinc-600">
            {ko ? "노동자 1인 예상 팁 USD" : "Expected tips per worker USD"}
            <input
              inputMode="decimal"
              className={`${inputClass} mt-1`}
              value={expectedTips}
              onChange={(event) => setExpectedTips(event.target.value)}
            />
          </label>
          <label className="text-xs font-medium text-zinc-600">
            {ko ? "모집 인원" : "Headcount"}
            <input
              type="number"
              min="1"
              max="100"
              className={`${inputClass} mt-1`}
              value={headcount}
              onChange={(event) => setHeadcount(event.target.value)}
            />
          </label>
          <div className="flex items-end md:col-span-3">
            <Button
              variant="dark"
              disabled={busy || !venueId || !role.trim() || !startsAt || !endsAt}
              onClick={() =>
                mutate(
                  () =>
                    api(`/staffing/venues/${venueId}/shifts`, {
                      method: "POST",
                      body: {
                        role: role.trim(),
                        description: description.trim() || undefined,
                        startsAt: new Date(startsAt).toISOString(),
                        endsAt: new Date(endsAt).toISOString(),
                        hourlyRateUsdCents: Math.round(Number(hourlyRate) * 100),
                        expectedTipUsdCents: Math.round(Number(expectedTips) * 100),
                        headcount: Number(headcount),
                      },
                    }),
                  ko
                    ? "시프트 초안을 만들었습니다. 다음으로 모집을 시작하세요."
                    : "Draft created. Publish it next.",
                  () => setShowCreate(false),
                )
              }
            >
              {ko ? "초안 만들기" : "Create draft"}
            </Button>
          </div>
        </div>
      )}

      {connections !== null && connectedWorkers.length === 0 && (
        <Callout tone="amber">
          {ko
            ? "초대할 노동자가 아직 없습니다. 정산·소득 탭의 직원 계정 연결을 먼저 완료하세요."
            : "No workers are ready to invite. Complete worker mapping in Settlement & income first."}{" "}
          <button type="button" className="font-semibold underline" onClick={onGoToSettlement}>
            {ko ? "직원 연결로 이동 →" : "Go to worker mapping →"}
          </button>
        </Callout>
      )}

      <div className="mt-4 grid gap-3">
        {loading && (
          <LoadingState compact title={ko ? "근무 목록을 불러오는 중…" : "Loading shifts…"} />
        )}
        {!loading && shifts.length === 0 && (
          <p className="text-sm text-zinc-400">
            {ko ? "아직 등록된 시프트가 없습니다." : "No staffing shifts yet."}
          </p>
        )}
        {shifts.map((shift) => {
          const accepted = shift.assignments.filter((assignment) =>
            ["ACCEPTED", "CLOCKED_IN", "CLOCKED_OUT", "APPROVED"].includes(assignment.status),
          ).length;
          return (
            <details
              key={shift.id}
              open={shift.status !== "COMPLETED" && shift.status !== "CANCELLED"}
              className="rounded-xl border border-zinc-200 bg-white"
            >
              <summary className="cursor-pointer list-none p-4 [&::-webkit-details-marker]:hidden">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-zinc-900">{shift.role}</span>
                      <Badge tone={statusTone(shift.status)}>
                        {staffingStatus(shift.status, ko)}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-zinc-500">
                      {new Date(shift.startsAt).toLocaleString()} –{" "}
                      {new Date(shift.endsAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                    {shift.description && (
                      <p className="mt-1 text-xs text-zinc-400">{shift.description}</p>
                    )}
                  </div>
                  <div className="text-right text-sm text-zinc-600">
                    <p>
                      <b>{usd(shift.hourlyRateUsdCents)}</b>/{ko ? "시간" : "hr"} ·{" "}
                      {ko ? "예상 팁" : "est. tips"} {usd(shift.expectedTipUsdCents)}
                    </p>
                    <p className="mt-1 text-xs">
                      {accepted}/{shift.headcount} {ko ? "확정" : "confirmed"}
                    </p>
                  </div>
                </div>
              </summary>
              <div className="border-t border-zinc-100 p-4">
                <div className="flex flex-wrap gap-2">
                  {shift.status === "DRAFT" && (
                    <Button
                      size="sm"
                      onClick={() =>
                        mutate(
                          () =>
                            api(`/staffing/shifts/${shift.id}/publish`, {
                              method: "POST",
                              body: {},
                            }),
                          ko
                            ? "모집을 시작했습니다. 이제 연결된 노동자를 초대할 수 있습니다."
                            : "Recruiting started. Invite a connected worker next.",
                        )
                      }
                      disabled={busy}
                    >
                      {ko ? "모집 시작" : "Publish"}
                    </Button>
                  )}
                  {!["DRAFT", "CANCELLED", "COMPLETED"].includes(shift.status) && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        mutate(() =>
                          api(`/staffing/shifts/${shift.id}/cancel`, {
                            method: "POST",
                            body: { reason: "Cancelled by venue" },
                          }),
                        )
                      }
                      disabled={busy}
                    >
                      {ko ? "시프트 취소" : "Cancel shift"}
                    </Button>
                  )}
                </div>
                {["OPEN", "FILLED"].includes(shift.status) && connectedWorkers.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <select
                      className={`${inputClass} max-w-72 py-1.5 text-sm`}
                      value={inviteWorker[shift.id] ?? ""}
                      onChange={(event) =>
                        setInviteWorker((current) => ({
                          ...current,
                          [shift.id]: event.target.value,
                        }))
                      }
                    >
                      <option value="">
                        {ko ? "연결된 노동자 선택" : "Choose a connected worker"}
                      </option>
                      {connectedWorkers.map((worker) => (
                        <option key={worker.workerId!} value={worker.workerId!}>
                          {worker.displayName} · {worker.emailMasked}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy || !inviteWorker[shift.id]}
                      onClick={() =>
                        mutate(() =>
                          api(`/staffing/shifts/${shift.id}/invitations`, {
                            method: "POST",
                            body: { workerId: inviteWorker[shift.id] },
                          }),
                        )
                      }
                    >
                      {ko ? "초대" : "Invite"}
                    </Button>
                  </div>
                )}
                <div className="mt-3 grid gap-2">
                  {shift.assignments.length === 0 && (
                    <p className="text-xs text-zinc-400">
                      {ko ? "아직 지원·초대 기록이 없습니다." : "No responses or invitations yet."}
                    </p>
                  )}
                  {shift.assignments.map((assignment) => (
                    <div
                      key={assignment.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-sm"
                    >
                      <span className="font-medium text-zinc-800">
                        {assignment.worker?.user.displayName ?? assignment.workerId}
                      </span>
                      <Badge tone={statusTone(assignment.status)}>
                        {staffingStatus(assignment.status, ko)}
                      </Badge>
                      {assignment.checkInAt && (
                        <span className="text-xs text-zinc-400">
                          {new Date(assignment.checkInAt).toLocaleTimeString()} →{" "}
                          {assignment.checkOutAt
                            ? new Date(assignment.checkOutAt).toLocaleTimeString()
                            : "…"}
                        </span>
                      )}
                      <span className="ml-auto flex gap-2">
                        {assignment.status === "CLOCKED_OUT" && (
                          <Button
                            size="sm"
                            onClick={() =>
                              mutate(
                                () =>
                                  api(`/staffing/assignments/${assignment.id}/approve`, {
                                    method: "POST",
                                    body: {},
                                  }),
                                ko
                                  ? "근무를 승인하고 검증된 근무 기록을 만들었습니다."
                                  : "Work approved and verified shift evidence created.",
                              )
                            }
                            disabled={busy}
                          >
                            {ko ? "근무 승인" : "Approve work"}
                          </Button>
                        )}
                        {["INVITED", "ACCEPTED"].includes(assignment.status) && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              mutate(() =>
                                api(`/staffing/assignments/${assignment.id}/no-show`, {
                                  method: "POST",
                                  body: {},
                                }),
                              )
                            }
                            disabled={busy}
                          >
                            {ko ? "노쇼" : "No-show"}
                          </Button>
                        )}
                        {assignment.status === "APPROVED" && (
                          <Button size="sm" variant="secondary" onClick={onGoToSettlement}>
                            {ko ? "팁 배분·정산으로 이동 →" : "Continue to allocation →"}
                          </Button>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </details>
          );
        })}
      </div>
    </Card>
  );
}

export function WorkerStaffingCard({
  locale,
  onGoToIncome,
}: {
  locale: "ko" | "en";
  onGoToIncome: () => void;
}) {
  const ko = locale === "ko";
  const [shifts, setShifts] = useState<StaffingShift[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [view, setView] = useState<"available" | "mine">("available");
  const refresh = useCallback(() => {
    setLoading(true);
    api<StaffingShift[]>("/staffing/workers/me/shifts")
      .then(setShifts)
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => refresh(), [refresh]);

  async function mutate(
    action: () => Promise<unknown>,
    successMessage = ko ? "변경사항을 저장했습니다." : "Changes saved.",
    after?: () => void,
  ) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setSuccess(successMessage);
      window.setTimeout(() => setSuccess(null), 3500);
      after?.();
      refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={ko ? "연결된 사업장 시프트" : "Shifts from connected venues"}
      description={
        ko
          ? "모집 중인 근무를 수락하고 출퇴근하세요. 사업장 승인 후 검증된 근무 이력으로 연결됩니다."
          : "Accept work and clock in/out. Venue approval turns attendance into verified shift evidence."
      }
    >
      {success && (
        <div className="fixed right-6 top-6 z-50 rounded-xl bg-emerald-700 px-4 py-3 text-sm font-semibold text-white shadow-lg">
          {success}
        </div>
      )}
      {error && <Callout tone="red">{error}</Callout>}
      <ol className="mb-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {(ko
          ? ["1. 근무 선택", "2. 참여 수락", "3. 출근·퇴근", "4. 사업장 승인"]
          : ["1. Choose", "2. Accept", "3. Clock in/out", "4. Venue approval"]
        ).map((step) => (
          <li key={step} className="rounded-lg bg-zinc-100 px-3 py-2 font-medium text-zinc-600">
            {step}
          </li>
        ))}
      </ol>
      <div
        role="tablist"
        aria-label={ko ? "근무 목록" : "Shift list"}
        className="mb-4 inline-flex rounded-lg bg-zinc-100 p-1 text-sm"
      >
        <button
          type="button"
          role="tab"
          aria-selected={view === "available"}
          onClick={() => setView("available")}
          className={`rounded-md px-3 py-1.5 font-medium ${view === "available" ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500"}`}
        >
          {ko ? "모집 중" : "Available"}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "mine"}
          onClick={() => setView("mine")}
          className={`rounded-md px-3 py-1.5 font-medium ${view === "mine" ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500"}`}
        >
          {ko ? "내 근무" : "My shifts"}
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {loading && (
          <div className="md:col-span-2">
            <LoadingState compact title={ko ? "근무 목록을 불러오는 중…" : "Loading shifts…"} />
          </div>
        )}
        {!loading &&
          shifts.filter((shift) =>
            view === "available"
              ? !shift.assignments[0] && shift.status === "OPEN"
              : Boolean(shift.assignments[0]),
          ).length === 0 && (
            <p className="text-sm text-zinc-400">
              {view === "available"
                ? ko
                  ? "현재 모집 중인 시프트가 없습니다."
                  : "No shifts are currently recruiting."
                : ko
                  ? "아직 수락하거나 초대받은 근무가 없습니다."
                  : "No assigned shifts yet."}
            </p>
          )}
        {shifts
          .filter((shift) =>
            view === "available"
              ? !shift.assignments[0] && shift.status === "OPEN"
              : Boolean(shift.assignments[0]),
          )
          .map((shift) => {
            const assignment = shift.assignments[0];
            const durationHours =
              (new Date(shift.endsAt).getTime() - new Date(shift.startsAt).getTime()) / 3_600_000;
            const expected =
              Math.round(durationHours * shift.hourlyRateUsdCents) + shift.expectedTipUsdCents;
            return (
              <div key={shift.id} className="rounded-xl border border-zinc-200 bg-white p-4">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-emerald-700">{shift.venue?.name}</p>
                    <h3 className="mt-1 font-semibold text-zinc-900">{shift.role}</h3>
                    <p className="mt-1 text-sm text-zinc-500">
                      {new Date(shift.startsAt).toLocaleString()} –{" "}
                      {new Date(shift.endsAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                  <Badge tone={statusTone(assignment?.status ?? shift.status)}>
                    {staffingStatus(assignment?.status ?? shift.status, ko)}
                  </Badge>
                </div>
                {shift.description && (
                  <p className="mt-3 text-sm text-zinc-600">{shift.description}</p>
                )}
                <div className="mt-3 rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
                  {usd(shift.hourlyRateUsdCents)}/{ko ? "시간" : "hr"} ·{" "}
                  {ko ? "예상 팁" : "est. tips"} {usd(shift.expectedTipUsdCents)} ·{" "}
                  <b>
                    {ko ? "예상 합계" : "est. total"} {usd(expected)}
                  </b>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(!assignment ||
                    ["INVITED", "DECLINED", "CANCELLED"].includes(assignment.status)) &&
                    shift.status === "OPEN" && (
                      <>
                        <Button
                          size="sm"
                          onClick={() =>
                            mutate(
                              () =>
                                api(`/staffing/shifts/${shift.id}/respond`, {
                                  method: "POST",
                                  body: { response: "ACCEPT" },
                                }),
                              ko
                                ? "근무를 수락했습니다. 내 근무에서 확인하세요."
                                : "Shift accepted. See it under My shifts.",
                              () => setView("mine"),
                            )
                          }
                          disabled={busy}
                        >
                          {ko ? "수락" : "Accept"}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            mutate(() =>
                              api(`/staffing/shifts/${shift.id}/respond`, {
                                method: "POST",
                                body: { response: "DECLINE" },
                              }),
                            )
                          }
                          disabled={busy}
                        >
                          {ko ? "거절" : "Decline"}
                        </Button>
                      </>
                    )}
                  {assignment?.status === "ACCEPTED" && (
                    <>
                      <Button
                        size="sm"
                        onClick={() =>
                          mutate(() =>
                            api(`/staffing/assignments/${assignment.id}/clock-in`, {
                              method: "POST",
                              body: {},
                            }),
                          )
                        }
                        disabled={busy}
                      >
                        {ko ? "출근" : "Clock in"}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          mutate(() =>
                            api(`/staffing/assignments/${assignment.id}/cancel`, {
                              method: "POST",
                              body: { reason: "Cancelled by worker" },
                            }),
                          )
                        }
                        disabled={busy}
                      >
                        {ko ? "참여 취소" : "Cancel"}
                      </Button>
                    </>
                  )}
                  {assignment?.status === "CLOCKED_IN" && (
                    <Button
                      size="sm"
                      variant="dark"
                      onClick={() =>
                        mutate(() =>
                          api(`/staffing/assignments/${assignment.id}/clock-out`, {
                            method: "POST",
                            body: {},
                          }),
                        )
                      }
                      disabled={busy}
                    >
                      {ko ? "퇴근" : "Clock out"}
                    </Button>
                  )}
                  {assignment?.status === "CLOCKED_OUT" && (
                    <span className="text-sm font-medium text-amber-700">
                      {ko ? "사업장 근무 승인 대기" : "Waiting for venue approval"}
                    </span>
                  )}
                  {assignment?.status === "APPROVED" && (
                    <>
                      <span className="text-sm font-medium text-emerald-700">
                        {ko ? "검증된 근무 기록 생성됨" : "Verified shift evidence created"}
                      </span>
                      <Button size="sm" variant="secondary" onClick={onGoToIncome}>
                        {ko ? "소득 내역에서 확인 →" : "View income →"}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
      </div>
      <p className="mt-3 text-xs text-zinc-400">
        {ko
          ? "표시된 금액은 예상치입니다. 실제 급여와 팁은 승인된 근무 기록 및 사업장 정산 자료로 확정됩니다."
          : "Displayed earnings are estimates. Approved attendance and venue settlement records determine final wages and tips."}
      </p>
    </Card>
  );
}
