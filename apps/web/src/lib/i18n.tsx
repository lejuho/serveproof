"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Locale = "ko" | "en";

/** Flat dictionary — default locale is Korean (E2E asserts Korean labels). */
const dict: Record<string, { ko: string; en: string }> = {
  // common
  logout: { ko: "로그아웃", en: "Log out" },
  worker: { ko: "Worker", en: "Worker" },
  amount: { ko: "배분액", en: "Amount" },
  status: { ko: "상태", en: "Status" },
  actions: { ko: "액션", en: "Actions" },

  // landing
  "landing.badge": {
    ko: "Income & Tax Observability · Solana Devnet POC",
    en: "Income & Tax Observability · Solana Devnet POC",
  },
  "landing.desc": {
    ko: "흩어진 팁·근무·지급·Payroll 증거를 시프트 단위로 연결하고, 승인된 배분을 검증 가능한 지급과 휴대 가능한 소득증명으로 바꿉니다.",
    en: "Connects scattered tip, shift, payout, and payroll evidence per shift — turning approved allocations into verifiable payouts and portable income proof.",
  },
  "landing.cta": { ko: "시작하기", en: "Get started" },
  "landing.login": { ko: "로그인", en: "Sign in" },
  "landing.f1.title": { ko: "증거 수집", en: "Evidence intake" },
  "landing.f1.body": {
    ko: "Square·CSV에서 팁과 근무 기록을 정규화",
    en: "Normalize tips and shifts from Square & CSV",
  },
  "landing.f2.title": { ko: "승인·지급", en: "Approve & pay" },
  "landing.f2.body": {
    ko: "정책 기반 배분 승인 후 온체인 USDC 정산",
    en: "Policy-based allocation approval, settled in on-chain USDC",
  },
  "landing.f3.title": { ko: "선택적 공개", en: "Selective disclosure" },
  "landing.f3.body": {
    ko: "노동자가 범위를 정하는 PDF·QR 소득증명",
    en: "Worker-scoped PDF & QR income proof",
  },
  "landing.footer": {
    ko: "Devnet 테스트 토큰은 화폐 가치가 없습니다 · ServeProof POC",
    en: "Devnet test tokens have no monetary value · ServeProof POC",
  },

  // login
  "login.title": { ko: "로그인", en: "Sign in" },
  "login.subtitle": {
    ko: "이메일로 6자리 인증 코드를 보내드립니다.",
    en: "We'll send a 6-digit verification code to your email.",
  },
  "login.email": { ko: "이메일", en: "Email" },
  "login.request": { ko: "인증 코드 받기", en: "Send code" },
  "login.sentTo": { ko: "로 전송된 코드를 입력하세요.", en: " — enter the code we sent." },
  "login.devCode": { ko: "로컬 개발 코드", en: "Local dev code" },
  "login.submit": { ko: "로그인", en: "Sign in" },
  "login.back": { ko: "이메일 다시 입력", en: "Use a different email" },
  "login.demo": { ko: "데모 계정", en: "Demo accounts" },

  // dashboard
  "dash.subtitle": {
    ko: "팁 증거 수집부터 배분 승인, USDC 정산까지 한 흐름으로 처리합니다.",
    en: "From tip evidence to allocation approval and USDC settlement, in one flow.",
  },
  "dash.csv.desc": {
    ko: "§7.3 공통 포맷의 팁·근무 데이터를 붙여넣어 가져옵니다. 재실행해도 중복되지 않습니다.",
    en: "Paste tip & shift data in the §7.3 common format. Re-imports are idempotent.",
  },
  "dash.tips": { ko: "팁", en: "tips" },
  "dash.shifts": { ko: "시프트", en: "shifts" },
  "dash.rows": { ko: "건", en: "" },
  "dash.mapped": { ko: "매핑", en: "mapped" },
  "dash.unmapped": { ko: "미매핑", en: "unmapped" },
  "dash.errors": { ko: "오류", en: "errors" },
  "dash.mapping.desc": {
    ko: "외부 직원 ID를 ServeProof 노동자 프로필에 연결합니다.",
    en: "Link external worker IDs to ServeProof worker profiles.",
  },
  "dash.mapping.empty": {
    ko: "확인 대기 중인 매핑이 없습니다.",
    en: "No mappings awaiting confirmation.",
  },
  "dash.mapping.confirm": { ko: "매핑 확정", en: "Confirm mapping" },
  "dash.alloc.title": { ko: "배분 계산 · 승인", en: "Calculate & Approve" },
  "dash.alloc.desc": {
    ko: "정책 기반으로 배분을 계산하고, 검토 후 승인하면 지급 가능한 상태가 됩니다.",
    en: "Calculate policy-based allocations; approval makes them payable.",
  },
  "dash.calc": { ko: "계산", en: "Calculate" },
  "dash.approve": { ko: "승인", en: "Approve" },
  "dash.policy": { ko: "정책", en: "policy" },
  "dash.pool": { ko: "팁 풀", en: "Tip pool" },
  "dash.payout.title": { ko: "지급 (Payout)", en: "Payouts" },
  "dash.payout.desc": {
    ko: "USDC는 venue signer 지갑 서명으로 온체인 정산, 그 외 경로는 증빙으로 등록합니다.",
    en: "USDC settles on-chain with the venue signer wallet; other rails register evidence.",
  },
  "dash.payout.callout": {
    ko: "USDC 지급은 Devnet 테스트 토큰(tUSDC)이며 화폐 가치가 없습니다. venue signer 지갑으로 서명해야 합니다.",
    en: "USDC payouts use Devnet test tokens (tUSDC) with no monetary value. Sign with the venue signer wallet.",
  },
  "dash.wallet.connect": { ko: "지갑 연결", en: "Connect wallet" },
  "dash.wallet.connected": { ko: "연결됨", en: "Connected" },
  "dash.wallet.match": { ko: "venue signer 일치", en: "matches venue signer" },
  "dash.wallet.mismatch": { ko: "venue signer 불일치", en: "does not match venue signer" },
  "dash.wallet.expectedSigner": { ko: "필요한 서명자", en: "Required signer" },
  "dash.payout.usdc": { ko: "USDC 지급 (지갑 서명)", en: "Pay USDC (wallet sign)" },
  "dash.payout.legacy": { ko: "Legacy 증빙", en: "Legacy evidence" },
  "dash.payout.prompt": {
    ko: "지급 증빙 reference (예: payroll run ID)",
    en: "Payout evidence reference (e.g. payroll run ID)",
  },
  "dash.progress.create": { ko: "payout 생성 중…", en: "creating payout…" },
  "dash.progress.build": { ko: "트랜잭션 생성 중…", en: "building transaction…" },
  "dash.progress.sign": { ko: "지갑 서명 대기…", en: "waiting for wallet signature…" },
  "dash.progress.submit": { ko: "제출 중…", en: "submitting…" },
  "dash.progress.onchain": { ko: "온체인", en: "on-chain" },
  "dash.progress.legacyDone": {
    ko: "legacy 증빙 등록됨 (PAYROLL)",
    en: "legacy evidence registered (PAYROLL)",
  },
  "dash.income.desc": {
    ko: "지급·payroll 변경 후 실행하면 시프트별 상태와 discrepancy 경고가 갱신됩니다.",
    en: "Run after payout/payroll changes to refresh per-shift status and discrepancy alerts.",
  },
  "dash.income.rebuild": { ko: "IncomeEntry 재계산", en: "Rebuild income entries" },
  "dash.income.note1": { ko: "노동자는", en: "Workers see their own status on the" },
  "dash.income.myIncome": { ko: "내 소득", en: "My income" },
  "dash.income.note2": {
    ko: "화면에서 자기 상태를 확인합니다.",
    en: "screen.",
  },
  "dash.rebuilt": { ko: "재계산", en: "rebuilt" },
  "dash.alertsCount": { ko: "discrepancy 경고", en: "discrepancy alerts" },

  // me
  "me.title": { ko: "내 소득", en: "My income" },
  "me.stat.allocated": { ko: "확정 배분 총액", en: "Total allocated" },
  "me.stat.paid": { ko: "실지급 총액", en: "Total paid" },
  "me.stat.avg": { ko: "월평균 배분", en: "Avg monthly" },
  "me.stat.payers": { ko: "사업장 · 시프트", en: "Venues · Shifts" },
  "me.alerts.title": { ko: "알림 (Discrepancy)", en: "Alerts (Discrepancy)" },
  "me.alerts.desc": {
    ko: "소득 생명주기에서 어긋난 상태를 알려드립니다.",
    en: "Flags where your income lifecycle is out of sync.",
  },
  "me.alerts.empty": { ko: "모든 상태가 정상입니다.", en: "Everything looks good." },
  "me.timeline.title": { ko: "시프트 타임라인", en: "Shift timeline" },
  "me.timeline.desc": {
    ko: "earned → allocated → paid → payroll → withheld 생명주기를 시프트 단위로 추적합니다.",
    en: "Tracks the earned → allocated → paid → payroll → withheld lifecycle per shift.",
  },
  "me.col.date": { ko: "날짜", en: "Date" },
  "me.col.venue": { ko: "사업장", en: "Venue" },
  "me.col.allocated": { ko: "배분", en: "Allocated" },
  "me.col.paid": { ko: "지급", en: "Paid" },
  "me.col.payroll": { ko: "Payroll 신고", en: "Payroll" },
  "me.col.withholding": { ko: "원천징수", en: "Withholding" },
  "me.col.rail": { ko: "경로", en: "Rail" },
  "me.col.source": { ko: "출처", en: "Source" },
  "me.source.pos": { ko: "POS 연동", en: "POS-verified" },
  "me.source.self": { ko: "자기신고", en: "Self-reported" },
  "me.col.grade": { ko: "등급", en: "Grade" },
  "me.corrected": { ko: "정정", en: "Corrected" },
  "me.share.title": { ko: "소득증명 공유", en: "Share income proof" },
  "me.share.desc": {
    ko: "공개 범위는 내가 정합니다 — 필요한 사람에게, 필요한 기간만.",
    en: "You decide the scope — only what's needed, only for who needs it.",
  },
  "me.share.purpose": { ko: "공개 목적", en: "Purpose" },
  "me.share.l1": {
    ko: "LEVEL 1 — 조건 충족 여부만 (월 $3,000 이상)",
    en: "LEVEL 1 — threshold check only (≥ $3,000/mo)",
  },
  "me.share.l2": {
    ko: "LEVEL 2 — 월평균·payer 수·등급",
    en: "LEVEL 2 — monthly avg · payers · grade",
  },
  "me.share.l3": { ko: "LEVEL 3 — 시프트별 상세", en: "LEVEL 3 — per-shift detail" },
  "me.share.issue": { ko: "최근 3개월 보고서 발급", en: "Issue 3-month report" },
  "me.share.linkOnce": {
    ko: "공유 링크 (지금 한 번만 표시됩니다)",
    en: "Share link (shown only once)",
  },
  "me.share.pdf": { ko: "PDF 다운로드", en: "Download PDF" },
  "me.share.expires": { ko: "만료", en: "Expires" },
  "me.share.revoked": { ko: "철회됨", en: "Revoked" },
  "me.share.revoke": { ko: "철회", en: "Revoke" },
  "me.share.pdfFail": { ko: "PDF 다운로드 실패", en: "PDF download failed" },
  "me.wallet.title": { ko: "수취 지갑", en: "Payout wallets" },
  "me.wallet.desc": {
    ko: "지급받을 Solana 지갑입니다. 기본 지갑 하나만 활성화됩니다.",
    en: "Solana wallets for receiving payouts. Only one default is active.",
  },
  "me.wallet.empty": { ko: "연결된 지갑이 없습니다.", en: "No wallets connected." },
  "me.wallet.default": { ko: "기본", en: "Default" },
  "alert.ALLOCATION_GAP": {
    ko: "배분 누락 — 근무는 있는데 배분이 없습니다",
    en: "Allocation gap — you worked but have no allocation",
  },
  "alert.PAYOUT_GAP": {
    ko: "지급 대기 — 승인된 배분이 아직 지급되지 않았습니다",
    en: "Payout pending — an approved allocation hasn't been paid yet",
  },
  "alert.PAYROLL_GAP": {
    ko: "Payroll 미신고 — 지급은 됐지만 payroll에 반영되지 않았습니다",
    en: "Payroll gap — paid, but not yet reported to payroll",
  },
  "alert.WITHHOLDING_UNKNOWN": { ko: "원천징수 미확인", en: "Withholding unknown" },
  "alert.REFUND_ADJUSTMENT_REQUIRED": { ko: "환불 반영 필요", en: "Refund adjustment required" },
  "alert.UNMAPPED_WORKER": { ko: "외부 계정 미매핑", en: "External account unmapped" },

  // verify
  "verify.header": { ko: "소득증명 검증", en: "Income verification" },
  "verify.msg.VALID": { ko: "이 보고서는 유효합니다.", en: "This report is valid." },
  "verify.msg.EXPIRED": { ko: "이 보고서는 만료되었습니다.", en: "This report has expired." },
  "verify.msg.REVOKED": {
    ko: "이 공유 링크는 노동자에 의해 철회되었습니다. 소득 정보는 표시되지 않습니다.",
    en: "This link was revoked by the worker. No income data is shown.",
  },
  "verify.msg.CORRECTED": {
    ko: "원본 기록에 정정이 발생했습니다. 최신 보고서를 요청하세요.",
    en: "The underlying records were corrected. Request an up-to-date report.",
  },
  "verify.msg.NOT_ISSUED": {
    ko: "아직 보고서가 발급되지 않았습니다.",
    en: "No report has been issued yet.",
  },
  "verify.info.title": { ko: "보고서 정보", en: "Report details" },
  "verify.issuer": { ko: "발급자", en: "Issuer" },
  "verify.subject": { ko: "대상", en: "Subject" },
  "verify.purpose": { ko: "목적", en: "Purpose" },
  "verify.level": { ko: "공개 수준", en: "Disclosure level" },
  "verify.issuedAt": { ko: "발급 시각", en: "Issued at" },
  "verify.expiresAt": { ko: "만료 시각", en: "Expires at" },
  "verify.disclosed.title": { ko: "공개 허용된 필드", en: "Disclosed fields" },
  "verify.totalIncome": { ko: "검증된 소득 총액", en: "Total verified income" },
  "verify.avgMonthly": { ko: "월평균 소득", en: "Avg monthly income" },
  "verify.months": { ko: "포함 개월 수", en: "Months covered" },
  "verify.payers": { ko: "Payer 수", en: "Payer count" },
  "verify.bestGrade": { ko: "최고 증거 등급", en: "Best evidence grade" },
  "verify.corrections": { ko: "정정 이력", en: "Corrections" },
  "verify.posShare": { ko: "POS 연동 증거 비율", en: "POS-verified evidence" },
  "verify.yes": { ko: "있음", en: "Yes" },
  "verify.no": { ko: "없음", en: "No" },
  "verify.footer": {
    ko: "원본 소득 데이터와 PDF는 공개되지 않습니다 · Devnet 테스트 토큰은 화폐 가치가 없습니다",
    en: "Raw income data and the PDF are never exposed · Devnet test tokens have no monetary value",
  },
};

interface I18nContext {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string) => string;
}

const Ctx = createContext<I18nContext>({
  locale: "ko",
  setLocale: () => {},
  t: (key) => dict[key]?.ko ?? key,
});

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("ko");
  useEffect(() => {
    if (localStorage.getItem("sp_locale") === "en") setLocaleState("en");
  }, []);
  const setLocale = (next: Locale) => {
    localStorage.setItem("sp_locale", next);
    setLocaleState(next);
  };
  const t = (key: string) => dict[key]?.[locale] ?? key;
  return <Ctx.Provider value={{ locale, setLocale, t }}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
