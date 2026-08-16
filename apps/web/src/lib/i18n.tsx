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
  "dash.progress.create": { ko: "payout 생성 중…", en: "creating payout…" },
  "dash.progress.build": { ko: "트랜잭션 생성 중…", en: "building transaction…" },
  "dash.progress.sign": { ko: "지갑 서명 대기…", en: "waiting for wallet signature…" },
  "dash.progress.submit": { ko: "제출 중…", en: "submitting…" },
  "dash.progress.onchain": { ko: "온체인", en: "on-chain" },
  "dash.progress.confirmed": {
    ko: "RPC 관측 CONFIRMED · 최종 확정 대기",
    en: "RPC observed CONFIRMED · awaiting finalization",
  },
  "dash.progress.expired": {
    ko: "서명 유효 시간이 만료되었습니다 — USDC 지급을 다시 눌러 새 트랜잭션에 서명하세요",
    en: "The signature expired — click Pay USDC again to sign a fresh transaction",
  },
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
  "me.stat.avg": { ko: "관측 월 기준 평균", en: "Avg per observed month" },
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
  optional: { ko: "(선택)", en: "(optional)" },
  "me.share.private": { ko: "내가 언제든 철회할 수 있어요", en: "You can revoke access anytime" },
  "me.share.forWhat": { ko: "어디에 제출하나요?", en: "What is this for?" },
  "me.share.forWhatHint": {
    ko: "실제 제출처를 고르면 권장 기간과 공개 범위를 함께 설정합니다.",
    en: "Choose a real destination to set its recommended period and disclosure scope.",
  },
  "me.share.supplement.title": {
    ko: "검증 가능한 보조 소득자료입니다.",
    en: "This is verifiable supplemental income evidence.",
  },
  "me.share.supplement.detail": {
    ko: "공식 급여명세서, W-2, 세금신고서 또는 기관 지정 양식을 대체하지 않습니다. 제출 전 담당자에게 인정 여부를 확인하세요.",
    en: "It does not replace official pay stubs, W-2s, tax returns, or agency forms. Confirm acceptance with the recipient before submitting.",
  },
  "me.share.priority": { ko: "우선 사용처", en: "Priority use" },
  "me.share.moreUses": { ko: "다른 제출 목적 보기", en: "See other submission purposes" },
  "me.share.typicalRecipient": { ko: "주요 수신처:", en: "Typical recipient:" },
  "me.share.recommendedSettings": { ko: "권장 설정:", en: "Recommended:" },
  "me.share.purpose": { ko: "공개 목적", en: "Purpose" },
  "me.share.purposePlaceholder": {
    ko: "예: 8월 임대 계약 소득 확인",
    en: "e.g. Income check for an August lease",
  },
  "me.share.chooseScope": { ko: "어디까지 공개할까요?", en: "How much should be shared?" },
  "me.share.chooseScopeHint": {
    ko: "상세 정보가 적은 범위를 우선 선택하세요.",
    en: "Prefer the least detailed scope that meets the request.",
  },
  "me.share.l1.title": { ko: "충족 여부만", en: "Pass/fail only" },
  "me.share.l1.detail": {
    ko: "직접 입력한 월 소득 기준 충족 여부만 공개 · 금액과 근무 내역은 숨김",
    en: "Only whether a custom monthly-income threshold is met · amounts and shifts stay private",
  },
  "me.share.l2.title": { ko: "소득 요약", en: "Income summary" },
  "me.share.l2.detail": {
    ko: "월평균 소득, 지급처 수, 증거 등급 공개 · 시프트 상세는 숨김",
    en: "Monthly average, payer count, and evidence grade · shift details stay private",
  },
  "me.share.l3.title": { ko: "시프트별 상세", en: "Per-shift detail" },
  "me.share.l3.detail": {
    ko: "날짜, 사업장, 배분·지급·신고 금액까지 모두 공개",
    en: "Includes dates, venues, allocations, payments, and reported amounts",
  },
  "me.share.accessSettings": { ko: "기간과 수신자를 정하세요", en: "Set timing and recipient" },
  "me.share.period": { ko: "소득 조회 기간", en: "Income period" },
  "me.share.expiration": { ko: "링크 만료", en: "Link expiration" },
  "me.share.range.1": { ko: "최근 1개월", en: "Last month" },
  "me.share.range.3": { ko: "최근 3개월", en: "Last 3 months" },
  "me.share.range.6": { ko: "최근 6개월", en: "Last 6 months" },
  "me.share.range.12": { ko: "최근 12개월", en: "Last 12 months" },
  "me.share.range.24": { ko: "최근 24개월", en: "Last 24 months" },
  "me.share.range.ytd": { ko: "올해 누적", en: "Year to date" },
  "me.share.range.lastYear": { ko: "지난 역년 전체", en: "Previous calendar year" },
  "me.share.expiresIn": { ko: "{days}일 후 만료", en: "Expires in {days} days" },
  "me.share.recipientLabel": { ko: "수신자 이메일", en: "Recipient email" },
  "me.share.recipientHint": {
    ko: "비워두면 링크만 만들고, 직접 전달할 수 있어요.",
    en: "Leave blank to create a link you can share yourself.",
  },
  "me.share.emailInvalid": {
    ko: "올바른 이메일 주소를 입력해 주세요.",
    en: "Enter a valid email address.",
  },
  "me.share.review": { ko: "공유 전 확인", en: "Review before sharing" },
  "me.share.destination": { ko: "제출처", en: "Destination" },
  "me.share.destinationCustom": { ko: "직접 지정", en: "Custom destination" },
  "me.share.included": { ko: "공개 정보", en: "Information shared" },
  "me.share.threshold": { ko: "월 소득 기준", en: "Monthly income threshold" },
  "me.share.thresholdHint": {
    ko: "임대 신청이라면 해당 커뮤니티의 기준을 확인하세요. 흔히 월세의 2.5~3배를 요구하지만 고정 규칙은 아닙니다.",
    en: "For rentals, check the property's own policy. Many use 2.5–3× monthly rent, but there is no universal rule.",
  },
  "me.share.perMonth": { ko: " /월", en: " /month" },
  "me.share.delivery": { ko: "전달 방법", en: "Delivery" },
  "me.share.deliveryLink": { ko: "링크를 직접 전달", en: "Share the link yourself" },
  "me.share.create": {
    ko: "검증 가능한 보조 소득자료 만들기",
    en: "Create supplemental income evidence",
  },
  "me.share.issuing": { ko: "링크 만드는 중…", en: "Creating link…" },
  "me.share.controlNote": {
    ko: "발급 후에도 만료 전 언제든 접근을 철회할 수 있습니다.",
    en: "You can revoke access anytime before the link expires.",
  },
  "me.share.created": { ko: "공유 링크가 준비됐어요", en: "Your share link is ready" },
  "me.share.copy": { ko: "링크 복사", en: "Copy link" },
  "me.share.copied": { ko: "복사됨 ✓", en: "Copied ✓" },
  "me.share.l1": {
    ko: "LEVEL 1 — 직접 입력한 조건 충족 여부만",
    en: "LEVEL 1 — custom threshold check only",
  },
  "me.share.l2": {
    ko: "LEVEL 2 — 월평균·payer 수·등급",
    en: "LEVEL 2 — monthly avg · payers · grade",
  },
  "me.share.l3": { ko: "LEVEL 3 — 시프트별 상세", en: "LEVEL 3 — per-shift detail" },
  "me.share.issue": { ko: "보조 소득자료 발급", en: "Issue supplemental income evidence" },
  "me.share.linkOnce": {
    ko: "공유 링크 (지금 한 번만 표시됩니다)",
    en: "Share link (shown only once)",
  },
  "me.share.pdf": { ko: "PDF 다운로드", en: "Download PDF" },
  "me.share.expires": { ko: "만료", en: "Expires" },
  "me.share.revoked": { ko: "철회됨", en: "Revoked" },
  "me.share.revoke": { ko: "철회", en: "Revoke" },
  "me.share.pdfFail": { ko: "PDF 다운로드 실패", en: "PDF download failed" },
  "me.share.recipient": { ko: "수신자 이메일 (선택)", en: "Recipient email (optional)" },
  "me.share.emailSent": {
    ko: "검증 링크가 수신자 이메일로 발송되었습니다.",
    en: "The verification link was emailed to the recipient.",
  },
  "me.share.emailFailed": {
    ko: "이메일 발송에 실패했습니다. 아래 링크를 직접 전달하세요.",
    en: "Email delivery failed. Share the link below manually.",
  },
  "me.share.preset.custom": { ko: "용도 프리셋…", en: "Purpose preset…" },
  "me.share.preset.rent": { ko: "아파트·주택 임대", en: "Apartment or home rental" },
  "me.share.preset.rent.hint": {
    ko: "최근 2~3개월 소득·팁 요약",
    en: "2–3 months of income and tip summary",
  },
  "me.share.preset.rent.audience": {
    ko: "landlord · property manager (예: Greystar)",
    en: "Landlord or property manager (e.g. Greystar)",
  },
  "me.share.preset.rent.purpose": {
    ko: "아파트 임대 신청용 보조 소득자료",
    en: "Supplemental income evidence for a rental application",
  },
  "me.share.preset.benefits": { ko: "SNAP·Medicaid", en: "SNAP or Medicaid" },
  "me.share.preset.benefits.hint": {
    ko: "최근 4주 급여·팁 상세",
    en: "4 weeks of wage and tip detail",
  },
  "me.share.preset.benefits.audience": {
    ko: "주·지방 복지기관 담당자 (예: NYC HRA)",
    en: "State or local benefits caseworker (e.g. NYC HRA)",
  },
  "me.share.preset.benefits.purpose": {
    ko: "SNAP·Medicaid 자격 확인용 근로·팁 소득자료",
    en: "Wage and tip income evidence for SNAP or Medicaid eligibility",
  },
  "me.share.preset.housing": { ko: "공공임대 재심사", en: "Public housing recertification" },
  "me.share.preset.housing.hint": {
    ko: "현재 소득과 지급 내역",
    en: "Current income and payment history",
  },
  "me.share.preset.housing.audience": {
    ko: "지역 Public Housing Agency (예: NYCHA)",
    en: "Local Public Housing Agency (e.g. NYCHA)",
  },
  "me.share.preset.housing.purpose": {
    ko: "공공임대·Section 8 재심사용 보조 소득자료",
    en: "Supplemental income evidence for public housing or Section 8 recertification",
  },
  "me.share.preset.auto": { ko: "자동차 대출", en: "Auto loan application" },
  "me.share.preset.auto.hint": {
    ko: "최근 1~3개월 확정 소득 요약",
    en: "1–3 months of confirmed income",
  },
  "me.share.preset.auto.audience": {
    ko: "딜러 제휴 금융사 (예: Capital One Auto)",
    en: "Dealer-affiliated lender (e.g. Capital One Auto)",
  },
  "me.share.preset.auto.purpose": {
    ko: "자동차 대출 신청용 확정 소득 요약",
    en: "Confirmed income summary for an auto loan application",
  },
  "me.share.preset.mortgage": { ko: "모기지 사전심사", en: "Mortgage pre-approval" },
  "me.share.preset.mortgage.hint": {
    ko: "12개월 변동 소득 추세",
    en: "12-month variable-income trend",
  },
  "me.share.preset.mortgage.audience": {
    ko: "모기지 금융사·대출 담당자",
    en: "Mortgage lender or loan officer",
  },
  "me.share.preset.mortgage.purpose": {
    ko: "모기지 사전심사용 변동 소득 보조자료",
    en: "Supplemental variable-income evidence for mortgage pre-approval",
  },
  "me.share.preset.marketplace": {
    ko: "건강보험 Marketplace",
    en: "Health Insurance Marketplace",
  },
  "me.share.preset.marketplace.hint": {
    ko: "올해 누적·예상 소득 보조",
    en: "Year-to-date and projected income support",
  },
  "me.share.preset.marketplace.audience": {
    ko: "HealthCare.gov·주별 Marketplace",
    en: "HealthCare.gov or a state Marketplace",
  },
  "me.share.preset.marketplace.purpose": {
    ko: "건강보험 보조금 확인용 올해 누적 소득자료",
    en: "Year-to-date income evidence for Marketplace savings verification",
  },
  "me.share.preset.immigration": {
    ko: "이민·가족초청 보조",
    en: "Immigration affidavit support",
  },
  "me.share.preset.immigration.hint": {
    ko: "최근 6개월 현재 소득 보조",
    en: "6 months of current income support",
  },
  "me.share.preset.immigration.audience": {
    ko: "USCIS Form I-864 제출 보조",
    en: "USCIS Form I-864 supporting evidence",
  },
  "me.share.preset.immigration.purpose": {
    ko: "가족초청 재정보증용 현재 소득 보조자료",
    en: "Supplemental current-income evidence for an affidavit of support",
  },
  "me.share.preset.tax": { ko: "세무 신고", en: "Tax filing" },
  "me.share.preset.tax.hint": {
    ko: "지난 역년 시프트별 전체 내역",
    en: "Full prior-calendar-year shift detail",
  },
  "me.share.preset.tax.audience": {
    ko: "세무 전문가·본인 기록",
    en: "Tax preparer or personal records",
  },
  "me.share.preset.tax.purpose": {
    ko: "세무 신고용 시프트별 상세",
    en: "Per-shift detail for tax filing",
  },
  "me.share.preset.other": { ko: "기타 소득 확인", en: "Other income verification" },
  "me.share.preset.other.hint": {
    ko: "제출처와 목적을 직접 입력",
    en: "Enter the destination and purpose yourself",
  },
  "me.explorer.title": {
    ko: "Solana Explorer에서 온체인 지급 확인",
    en: "View the on-chain payout on Solana Explorer",
  },
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
  "verify.observedDays": { ko: "관측 근무일수", en: "Observed shift days" },
  "verify.monthly.title": {
    ko: "월별 내역 (관측값, 외삽 없음)",
    en: "Monthly breakdown (observed, not extrapolated)",
  },
  "verify.shortWindow": {
    ko: "관측 기간이 1개월 이하입니다. 월평균 소득 해석에 주의하세요 — 이 보고서는 관측된 값만 담으며 추정하지 않습니다.",
    en: "Observation window is one month or less. Interpret the monthly average with care — this report states observations only, never estimates.",
  },
  "dash.todo.title": { ko: "오늘 할 일", en: "Needs attention" },
  "dash.todo.desc": {
    ko: "이 사업장에서 매니저 처리가 필요한 항목입니다.",
    en: "Items in this venue that still need a manager.",
  },
  "dash.todo.unmapped": { ko: "미매핑 워커", en: "Unmapped workers" },
  "dash.todo.uncalculated": { ko: "미계산 영업일", en: "Uncalculated dates" },
  "dash.todo.approval": { ko: "승인 대기 배치", en: "Batches awaiting approval" },
  "dash.todo.unpaid": { ko: "미지급 배분", en: "Unpaid allocations" },
  "dash.todo.cta.map": { ko: "매핑하러 가기", en: "Go map workers" },
  "dash.todo.cta.calc": { ko: "계산하러 가기", en: "Go calculate" },
  "dash.todo.cta.review": { ko: "검토·승인하기", en: "Review & approve" },
  "dash.todo.cta.pay": { ko: "지급하러 가기", en: "Go pay" },
  "dash.progress.failed": { ko: "실패", en: "Failed" },
  "dash.progress.verifying": {
    ko: "이전 시도를 온체인에서 검증 중 — 기존 서명이 최종 확정되거나 blockhash가 만료될 때까지 재서명을 차단합니다",
    en: "Verifying the previous attempt — re-signing stays blocked until it finalizes or its blockhash expires",
  },
  "dash.payout.refPlaceholder": { ko: "급여 이체 참조번호", en: "Payroll transfer reference" },
  "dash.source.label": { ko: "데이터 소스", en: "Data sources" },
  "dash.source.toast": { ko: "Toast POS (데모 데이터 생성)", en: "Toast POS (demo data)" },
  "dash.source.square": { ko: "Square Sandbox 동기화", en: "Sync Square Sandbox" },
  "dash.source.syncQueued": {
    ko: "동기화 요청됨 — 잠시 후 자동 반영됩니다",
    en: "Sync queued — updates arrive shortly",
  },
  "dash.banner.signerMismatch": {
    ko: "연결된 지갑이 venue 서명 지갑과 다릅니다 — 이 상태로는 USDC 지급 서명이 거부됩니다.",
    en: "Connected wallet differs from the venue signer — USDC payout signing will be rejected.",
  },
  "me.banner.noWallet": {
    ko: "USDC 팁을 받으려면 수령 지갑을 연결해야 합니다. 지갑이 없으면 사업장이 지급을 진행할 수 없습니다.",
    en: "Connect a wallet to receive USDC tips — without one the venue cannot pay you on-chain.",
  },
  "me.banner.goConnect": { ko: "지갑 연결하러 가기", en: "Go connect a wallet" },
  "me.wallet.connect": { ko: "지갑 연결 (Phantom)", en: "Connect wallet (Phantom)" },
  "me.wallet.connectMore": { ko: "다른 지갑 추가", en: "Add another wallet" },
  "dash.payout.refConfirm": { ko: "기록", en: "Record" },
  "dash.payout.refCancel": { ko: "취소", en: "Cancel" },
  "dash.payout.noWallet": {
    ko: "워커 지갑 미등록 — 워커가 내 소득 화면에서 지갑을 연결해야 합니다",
    en: "No worker wallet — the worker must connect one on their income page",
  },
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
