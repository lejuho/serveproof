"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Locale = "ko" | "en";

/** Flat dictionary — default locale is Korean (E2E asserts Korean labels). */
const dict: Record<string, { ko: string; en: string }> = {
  // common
  logout: { ko: "로그아웃", en: "Log out" },
  worker: { ko: "직원", en: "Worker" },
  amount: { ko: "배분액", en: "Amount" },
  status: { ko: "상태", en: "Status" },
  actions: { ko: "처리", en: "Actions" },

  // landing
  "landing.badge": {
    ko: "Income & Tax Observability · Solana Devnet POC",
    en: "Income & Tax Observability · Solana Devnet POC",
  },
  "landing.desc": {
    ko: "흩어진 팁·근무·지급·Payroll 증거를 시프트 단위로 연결하고, 승인된 배분을 검증 가능한 지급과 휴대 가능한 소득증명으로 바꿉니다.",
    en: "Connects tip, shift, payout, and payroll records to create verifiable payouts and portable income proof.",
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
  "login.requesting": { ko: "인증 코드를 보내는 중…", en: "Sending code…" },
  "login.sentTo": { ko: "로 전송된 코드를 입력해 주세요.", en: ". Enter the code we sent." },
  "login.devCode": { ko: "로컬 개발 코드", en: "Local dev code" },
  "login.submit": { ko: "로그인", en: "Sign in" },
  "login.verifying": { ko: "계정 정보를 불러오는 중…", en: "Loading your account…" },
  "login.back": { ko: "이메일 다시 입력", en: "Use a different email" },
  "login.demo": { ko: "데모 계정", en: "Demo accounts" },
  "login.savedAccounts": { ko: "저장된 계정", en: "Saved accounts" },
  "login.savedAccount": { ko: "저장된 계정", en: "Saved account" },
  "login.workerAccount": { ko: "노동자 화면", en: "Worker view" },
  "login.staffAccount": { ko: "사업장 관리", en: "Venue management" },
  "login.continue": { ko: "계속", en: "Continue" },
  "auth.restoring": { ko: "로그인 상태를 확인하고 있습니다…", en: "Restoring your session…" },
  "loading.wait": { ko: "잠시만 기다려 주세요.", en: "Please wait a moment." },
  "loading.dashboard": { ko: "사업장 정보를 불러오는 중…", en: "Loading venue data…" },
  "loading.income": { ko: "소득 정보를 불러오는 중…", en: "Loading income data…" },
  "loading.report": { ko: "소득증명을 확인하는 중…", en: "Checking income proof…" },
  "loading.shifts": { ko: "근무 목록을 불러오는 중…", en: "Loading shifts…" },
  "auth.switch": { ko: "계정 전환", en: "Switch account" },
  "auth.viewAsWorker": { ko: "노동자로 보기", en: "Worker view" },
  "auth.viewAsStaff": { ko: "사업장 관리자로 보기", en: "Venue manager view" },

  // dashboard
  "dash.subtitle": {
    ko: "팁과 근무 기록을 가져온 뒤 배분 승인과 지급까지 처리할 수 있습니다.",
    en: "From tip evidence to allocation approval and USDC settlement, in one flow.",
  },
  "dash.csv.desc": {
    ko: "정해진 형식의 팁과 근무 데이터를 붙여넣어 가져오세요. 같은 데이터를 다시 가져와도 중복으로 저장되지 않습니다.",
    en: "Paste tip & shift data in the §7.3 common format. Re-imports are idempotent.",
  },
  "dash.tips": { ko: "팁", en: "tips" },
  "dash.shifts": { ko: "근무 기록", en: "shifts" },
  "dash.rows": { ko: "건", en: "" },
  "dash.mapped": { ko: "연결됨", en: "mapped" },
  "dash.unmapped": { ko: "연결 필요", en: "unmapped" },
  "dash.errors": { ko: "오류", en: "errors" },
  "dash.mapping.desc": {
    ko: "외부 서비스의 직원 정보를 ServeProof 노동자 계정에 연결해 주세요.",
    en: "Link external worker IDs to ServeProof worker profiles.",
  },
  "dash.mapping.empty": {
    ko: "연결을 확인할 직원이 없습니다.",
    en: "No mappings awaiting confirmation.",
  },
  "dash.mapping.confirm": { ko: "직원 연결", en: "Confirm mapping" },
  "dash.alloc.title": { ko: "팁 배분 계산 및 승인", en: "Calculate & Approve" },
  "dash.alloc.desc": {
    ko: "정책 기반으로 배분을 계산하고, 검토 후 승인하면 지급 가능한 상태가 됩니다.",
    en: "Calculate policy-based allocations; approval makes them payable.",
  },
  "dash.calc": { ko: "계산", en: "Calculate" },
  "dash.approve": { ko: "승인", en: "Approve" },
  "dash.policy": { ko: "정책", en: "policy" },
  "dash.pool": { ko: "팁 풀", en: "Tip pool" },
  "dash.payout.title": { ko: "지급", en: "Payouts" },
  "dash.payout.desc": {
    ko: "USDC는 사업장 지급 지갑으로 서명해 전송합니다. 급여 이체 등 다른 방법으로 지급했다면 참조번호를 등록하세요.",
    en: "USDC settles on-chain with the venue signer wallet; other rails register evidence.",
  },
  "dash.payout.callout": {
    ko: "현재 USDC 지급에는 화폐 가치가 없는 Devnet 테스트 토큰(tUSDC)을 사용합니다. 등록된 사업장 지급 지갑으로 서명해 주세요.",
    en: "USDC payouts use Devnet test tokens (tUSDC) with no monetary value. Sign with the venue signer wallet.",
  },
  "dash.wallet.connect": { ko: "지갑 연결", en: "Connect wallet" },
  "dash.wallet.connected": { ko: "연결됨", en: "Connected" },
  "dash.wallet.match": { ko: "사업장 지급 지갑과 일치", en: "matches venue signer" },
  "dash.wallet.mismatch": { ko: "사업장 지급 지갑과 다름", en: "does not match venue signer" },
  "dash.wallet.expectedSigner": { ko: "필요한 서명자", en: "Required signer" },
  "dash.payout.usdc": { ko: "USDC 지급 (지갑 서명)", en: "Pay USDC (wallet sign)" },
  "dash.payout.legacy": { ko: "급여 이체 기록", en: "Payroll transfer record" },
  "dash.progress.create": { ko: "지급 요청 만드는 중…", en: "creating payout…" },
  "dash.progress.build": { ko: "트랜잭션 생성 중…", en: "building transaction…" },
  "dash.progress.sign": { ko: "지갑 서명 대기…", en: "waiting for wallet signature…" },
  "dash.progress.submit": { ko: "제출 중…", en: "submitting…" },
  "dash.progress.onchain": { ko: "온체인", en: "on-chain" },
  "dash.progress.confirmed": {
    ko: "블록체인에서 확인되었습니다. 최종 확정을 기다리고 있습니다.",
    en: "RPC observed CONFIRMED · awaiting finalization",
  },
  "dash.progress.expired": {
    ko: "서명 유효 시간이 만료되었습니다. USDC 지급 버튼을 다시 눌러 새 거래에 서명해 주세요.",
    en: "The signature expired. Click Pay USDC again to sign a new transaction.",
  },
  "dash.progress.legacyDone": {
    ko: "급여 이체 기록이 등록되었습니다.",
    en: "The payroll transfer record was registered.",
  },
  "dash.income.desc": {
    ko: "지급 또는 급여 신고 내역을 변경한 뒤 실행하면 근무별 소득 상태와 확인 항목이 갱신됩니다.",
    en: "Run after payout/payroll changes to refresh per-shift status and discrepancy alerts.",
  },
  "dash.income.rebuild": { ko: "소득 상태 새로고침", en: "Refresh income status" },
  "dash.income.note1": { ko: "노동자는", en: "Workers see their own status on the" },
  "dash.income.myIncome": { ko: "내 소득", en: "My income" },
  "dash.income.note2": {
    ko: "화면에서 지급 상태를 확인할 수 있습니다.",
    en: "screen.",
  },
  "dash.rebuilt": { ko: "재계산", en: "rebuilt" },
  "dash.alertsCount": { ko: "확인 필요 항목", en: "items requiring review" },

  // me
  "me.title": { ko: "내 소득", en: "My income" },
  "me.stat.allocated": { ko: "확정 배분 총액", en: "Total allocated" },
  "me.stat.paid": { ko: "실지급 총액", en: "Total paid" },
  "me.stat.avg": { ko: "기록된 월평균 소득", en: "Avg per observed month" },
  "me.stat.payers": { ko: "사업장 수 및 근무 건수", en: "Venues and shifts" },
  "me.alerts.title": { ko: "확인이 필요한 항목", en: "Items requiring review" },
  "me.alerts.desc": {
    ko: "배분, 지급 또는 급여 신고 내역 중 확인이 필요한 항목입니다.",
    en: "Review issues found in allocation, payment, or payroll records.",
  },
  "me.alerts.empty": { ko: "현재 확인할 항목이 없습니다.", en: "There are no items to review." },
  "me.alerts.workerAction": {
    ko: "내가 할 일 · 수취 지갑을 연결한 뒤 사업장에 지급을 요청하세요.",
    en: "Your action · Connect a payout wallet, then ask the venue to complete payment.",
  },
  "me.alerts.venueAction": {
    ko: "처리 주체 · 사업장 또는 급여 담당자의 확인이 필요합니다.",
    en: "Owner · The venue or payroll administrator needs to review this item.",
  },
  "me.alerts.checkWallet": { ko: "수취 지갑 확인", en: "Check payout wallet" },
  "me.alerts.viewIncome": { ko: "근무 내역 보기", en: "View income entry" },
  "me.alerts.copyInquiry": { ko: "사업장 문의 문구 복사", en: "Copy venue inquiry" },
  "me.alerts.inquiryCopied": { ko: "문의 문구 복사됨 ✓", en: "Inquiry copied ✓" },
  "me.alerts.copyFailed": {
    ko: "문의 문구를 복사하지 못했습니다. 브라우저의 클립보드 권한을 확인해 주세요.",
    en: "Could not copy the inquiry. Check the browser clipboard permission.",
  },
  "me.timeline.title": { ko: "근무별 소득 내역", en: "Income by shift" },
  "me.timeline.desc": {
    ko: "근무일별 팁 배분, 지급, 급여 신고 및 원천징수 상태를 확인할 수 있습니다.",
    en: "Review allocation, payment, payroll, and withholding status for each shift.",
  },
  "me.col.date": { ko: "날짜", en: "Date" },
  "me.col.venue": { ko: "사업장", en: "Venue" },
  "me.col.allocated": { ko: "배분", en: "Allocated" },
  "me.col.paid": { ko: "지급", en: "Paid" },
  "me.col.payroll": { ko: "급여 신고", en: "Payroll" },
  "me.col.withholding": { ko: "원천징수", en: "Withholding" },
  "me.col.rail": { ko: "지급 방법", en: "Payment method" },
  "me.col.source": { ko: "출처", en: "Source" },
  "me.source.pos": { ko: "POS 연동", en: "POS-verified" },
  "me.source.staffing": { ko: "사업장 승인 근무", en: "Venue-approved shift" },
  "me.source.self": { ko: "직접 등록", en: "Self-reported" },
  "me.col.grade": { ko: "확인 등급", en: "Verification grade" },
  "me.corrected": { ko: "정정", en: "Corrected" },
  "me.share.title": { ko: "소득증명 공유", en: "Share income proof" },
  "me.share.desc": {
    ko: "필요한 정보만 선택해 원하는 기간 동안 공유할 수 있습니다.",
    en: "Choose only the information needed and how long to share it.",
  },
  optional: { ko: "(선택)", en: "(optional)" },
  "me.share.private": {
    ko: "언제든 공유를 철회할 수 있습니다",
    en: "You can revoke access anytime",
  },
  "me.share.forWhat": { ko: "어디에 제출하나요?", en: "What is this for?" },
  "me.share.forWhatHint": {
    ko: "제출 목적을 선택하면 권장 기간과 공개 범위가 함께 설정됩니다.",
    en: "Choose a real destination to set its recommended period and disclosure scope.",
  },
  "me.share.supplement.title": {
    ko: "제출용 소득 확인 자료를 만들 수 있습니다.",
    en: "This is verifiable supplemental income evidence.",
  },
  "me.share.supplement.detail": {
    ko: "공식 급여명세서, W-2, 세금신고서 또는 기관 지정 양식을 대체하지 않습니다. 제출 전에 담당자에게 인정 여부를 확인해 주세요.",
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
    ko: "직접 입력한 월 소득 기준의 충족 여부만 공개합니다. 금액과 근무 내역은 공개하지 않습니다.",
    en: "Share only whether the custom monthly income threshold is met. Amounts and shifts remain private.",
  },
  "me.share.l2.title": { ko: "소득 요약", en: "Income summary" },
  "me.share.l2.detail": {
    ko: "월평균 소득, 지급 사업장 수, 확인 등급을 공개합니다. 근무별 상세 내역은 공개하지 않습니다.",
    en: "Share monthly average, payer count, and verification grade. Shift details remain private.",
  },
  "me.share.l3.title": { ko: "근무별 상세 내역", en: "Per-shift detail" },
  "me.share.l3.detail": {
    ko: "근무일, 사업장, 배분액, 지급액 및 급여 신고액을 공개합니다.",
    en: "Includes dates, venues, allocations, payments, and reported amounts",
  },
  "me.share.accessSettings": { ko: "기간과 수신자를 정하세요", en: "Set timing and recipient" },
  "me.share.accessRecipient": { ko: "지정 이메일만 열람", en: "Recipient email only" },
  "me.share.accessRecipientHint": {
    ko: "수신자가 이메일 OTP를 인증해야 소득 내용을 볼 수 있습니다. 권장 방식입니다.",
    en: "The recipient must verify an email OTP before income details appear. Recommended.",
  },
  "me.share.accessLink": { ko: "링크를 가진 누구나", en: "Anyone with the link" },
  "me.share.accessLinkHint": {
    ko: "로그인 없이 열립니다. 전달되거나 잘못 발송되면 다른 사람이 볼 수 있습니다.",
    en: "No sign-in is required. Forwarded or misdirected links can be viewed by others.",
  },
  "me.share.accessRecipientShort": { ko: "이메일 OTP", en: "Email OTP" },
  "me.share.accessLinkShort": { ko: "공개 링크", en: "Public link" },
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
    ko: "입력하지 않으면 공유 링크만 만들어 직접 전달할 수 있습니다.",
    en: "Leave blank to create a link you can share yourself.",
  },
  "me.share.emailInvalid": {
    ko: "올바른 이메일 주소를 입력해 주세요.",
    en: "Enter a valid email address.",
  },
  "me.share.emailRequired": {
    ko: "지정 이메일 열람에는 수신자 이메일이 필요합니다.",
    en: "A recipient email is required for recipient-only access.",
  },
  "me.share.recipientSecureHint": {
    ko: "이 주소로 링크와 열람 OTP가 발송됩니다.",
    en: "The share link and access OTP will be sent to this address.",
  },
  "me.share.recipientConfirm": { ko: "수신자 이메일 다시 입력", en: "Confirm recipient email" },
  "me.share.recipientConfirmHint": {
    ko: "잘못된 사람에게 전송되지 않도록 주소를 한 번 더 확인합니다.",
    en: "Enter it again to reduce accidental delivery to the wrong person.",
  },
  "me.share.recipientMismatch": {
    ko: "두 이메일 주소가 일치하지 않습니다.",
    en: "The recipient email addresses do not match.",
  },
  "me.share.accessHistory": { ko: "최근 열람 기록", en: "Recent access history" },
  "me.share.noAccess": { ko: "아직 확인된 열람이 없습니다.", en: "No verified views yet." },
  "me.share.unknownIp": { ko: "IP 정보 없음", en: "IP unavailable" },
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
    ko: "소득 확인 자료 만들기",
    en: "Create supplemental income evidence",
  },
  "me.share.issuing": { ko: "링크 만드는 중…", en: "Creating link…" },
  "me.share.controlNote": {
    ko: "발급 후에도 만료 전 언제든 접근을 철회할 수 있습니다.",
    en: "You can revoke access anytime before the link expires.",
  },
  "me.share.created": { ko: "공유 링크가 준비되었습니다", en: "Your share link is ready" },
  "me.share.copy": { ko: "링크 복사", en: "Copy link" },
  "me.share.copied": { ko: "복사됨 ✓", en: "Copied ✓" },
  "me.share.l1": {
    ko: "1단계: 직접 입력한 조건의 충족 여부만 공개",
    en: "Level 1: custom threshold check only",
  },
  "me.share.l2": {
    ko: "2단계: 월평균 소득, 지급 사업장 수 및 확인 등급 공개",
    en: "Level 2: monthly average, payers, and grade",
  },
  "me.share.l3": { ko: "3단계: 근무별 상세 내역 공개", en: "Level 3: per-shift detail" },
  "me.share.issue": { ko: "소득 확인 자료 발급", en: "Issue supplemental income evidence" },
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
  "me.share.emailFailedSecure": {
    ko: "이메일 발송에 실패했습니다. 주소를 확인한 뒤 이 공유를 철회하고 다시 발급하세요.",
    en: "Email delivery failed. Check the address, revoke this share, and issue a new one.",
  },
  "me.share.preset.custom": { ko: "용도 프리셋…", en: "Purpose preset…" },
  "me.share.preset.rent": { ko: "아파트·주택 임대", en: "Apartment or home rental" },
  "me.share.preset.rent.hint": {
    ko: "최근 2~3개월 소득·팁 요약",
    en: "2–3 months of income and tip summary",
  },
  "me.share.preset.rent.audience": {
    ko: "임대인 또는 부동산 관리자(예: Greystar)",
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
    ko: "지난해 근무별 전체 내역",
    en: "Full prior-calendar-year shift detail",
  },
  "me.share.preset.tax.audience": {
    ko: "세무 전문가·본인 기록",
    en: "Tax preparer or personal records",
  },
  "me.share.preset.tax.purpose": {
    ko: "세무 신고용 근무별 상세 내역",
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
    ko: "배분 내역을 확인해 주세요. 근무 기록은 있지만 배분 내역이 없습니다.",
    en: "Review the allocation. A shift is recorded, but no allocation was found.",
  },
  "alert.PAYOUT_GAP": {
    ko: "지급 내역을 확인해 주세요. 승인된 배분의 지급 내역이 아직 확인되지 않았습니다.",
    en: "Review the payment. An approved allocation has not been recorded as paid yet.",
  },
  "alert.PAYROLL_GAP": {
    ko: "급여 신고 내역을 확인해 주세요. 지급 내역이 아직 급여 신고에 반영되지 않았습니다.",
    en: "Review the payroll record. The payment has not been reported to payroll yet.",
  },
  "alert.WITHHOLDING_UNKNOWN": {
    ko: "원천징수 내역을 확인해 주세요. 급여 신고에는 반영되었지만 원천징수 여부가 확인되지 않았습니다.",
    en: "Review withholding. Payroll was reported, but withholding has not been confirmed.",
  },
  "alert.REFUND_ADJUSTMENT_REQUIRED": {
    ko: "환불 반영 내역을 확인해 주세요.",
    en: "Review the refund adjustment.",
  },
  "alert.UNMAPPED_WORKER": {
    ko: "직원 계정 연결 상태를 확인해 주세요.",
    en: "Review the worker account connection.",
  },
  "alert.label.ALLOCATION_GAP": { ko: "배분 확인", en: "Allocation review" },
  "alert.label.PAYOUT_GAP": { ko: "지급 확인", en: "Payment review" },
  "alert.label.PAYROLL_GAP": { ko: "급여 신고 확인", en: "Payroll review" },
  "alert.label.WITHHOLDING_UNKNOWN": { ko: "원천징수 확인", en: "Withholding review" },
  "alert.label.REFUND_ADJUSTMENT_REQUIRED": { ko: "환불 반영 확인", en: "Refund review" },
  "alert.label.UNMAPPED_WORKER": { ko: "직원 연결 확인", en: "Worker connection review" },

  // verify
  "verify.header": { ko: "소득증명 검증", en: "Income verification" },
  "verify.msg.VALID": { ko: "이 보고서는 유효합니다.", en: "This report is valid." },
  "verify.msg.EXPIRED": {
    ko: "이 보고서는 만료되었습니다. 소득 정보는 표시되지 않습니다.",
    en: "This report has expired. No income data is shown.",
  },
  "verify.msg.REVOKED": {
    ko: "이 공유 링크는 노동자에 의해 철회되었습니다. 소득 정보는 표시되지 않습니다.",
    en: "This link was revoked by the worker. No income data is shown.",
  },
  "verify.msg.CORRECTED": {
    ko: "원본 기록에 정정이 발생해 소득 정보가 차단되었습니다. 최신 보고서를 요청하세요.",
    en: "Income data is blocked because the underlying records changed. Request an up-to-date report.",
  },
  "verify.msg.NOT_ISSUED": {
    ko: "아직 보고서가 발급되지 않았습니다.",
    en: "No report has been issued yet.",
  },
  "verify.info.title": { ko: "보고서 정보", en: "Report details" },
  "verify.auth.title": { ko: "수신자 이메일 확인", en: "Verify recipient email" },
  "verify.auth.description": {
    ko: "소득 정보는 지정된 수신자만 볼 수 있습니다. {email}로 일회용 코드를 받으세요.",
    en: "Only the designated recipient can view the income details. Request a one-time code at {email}.",
  },
  "verify.auth.send": { ko: "이메일로 코드 받기", en: "Send email code" },
  "verify.auth.sending": { ko: "코드 보내는 중…", en: "Sending code…" },
  "verify.auth.code": { ko: "6자리 열람 코드", en: "6-digit access code" },
  "verify.auth.verify": { ko: "확인하고 열람", en: "Verify and view" },
  "verify.auth.checking": { ko: "확인 중…", en: "Verifying…" },
  "verify.auth.resend": { ko: "코드 다시 받기", en: "Resend code" },
  "verify.auth.notice": {
    ko: "인증된 열람은 소득 제공자에게 시각, 마스킹된 IP 및 브라우저 정보로 기록됩니다.",
    en: "Verified access is logged for the income owner with time, masked IP, and browser information.",
  },
  "verify.auth.devCode": {
    ko: "로컬·데모 코드: {code}",
    en: "Local/demo code: {code}",
  },
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
  "verify.payers": { ko: "지급 사업장 수", en: "Payer count" },
  "verify.bestGrade": { ko: "최고 확인 등급", en: "Best verification grade" },
  "verify.corrections": { ko: "정정 이력", en: "Corrections" },
  "verify.posShare": { ko: "POS로 확인된 자료 비율", en: "POS-verified evidence" },
  "verify.observedDays": { ko: "확인된 근무일 수", en: "Observed shift days" },
  "verify.monthly.title": {
    ko: "월별 내역(확인된 값만 표시)",
    en: "Monthly breakdown (observed, not extrapolated)",
  },
  "verify.shortWindow": {
    ko: "확인된 기간이 1개월 이하이므로 월평균 소득을 해석할 때 주의해 주세요. 이 보고서에는 확인된 값만 포함되며 추정값은 포함되지 않습니다.",
    en: "The observation window is one month or less. Interpret the monthly average with care. This report includes observed values only and does not estimate missing periods.",
  },
  "dash.todo.title": { ko: "오늘 할 일", en: "Needs attention" },
  "dash.todo.desc": {
    ko: "사업장 관리자가 확인하거나 처리해야 하는 항목입니다.",
    en: "Items in this venue that still need a manager.",
  },
  "dash.todo.unmapped": { ko: "연결되지 않은 직원", en: "Unmapped workers" },
  "dash.todo.uncalculated": { ko: "배분 계산 전 영업일", en: "Uncalculated dates" },
  "dash.todo.approval": { ko: "승인 대기 중인 배분", en: "Batches awaiting approval" },
  "dash.todo.unpaid": { ko: "지급 전 배분", en: "Unpaid allocations" },
  "dash.todo.cta.map": { ko: "직원 연결", en: "Go map workers" },
  "dash.todo.cta.calc": { ko: "배분 계산", en: "Go calculate" },
  "dash.todo.cta.review": { ko: "검토 및 승인", en: "Review & approve" },
  "dash.todo.cta.pay": { ko: "지급 처리", en: "Go pay" },
  "dash.progress.failed": { ko: "실패", en: "Failed" },
  "dash.progress.verifying": {
    ko: "이전 지급 요청을 블록체인에서 확인하고 있습니다. 거래가 최종 확정되거나 서명 유효 시간이 만료될 때까지 다시 서명할 수 없습니다.",
    en: "The previous attempt is being verified on-chain. Re-signing is blocked until it finalizes or the blockhash expires.",
  },
  "dash.payout.refPlaceholder": { ko: "급여 이체 참조번호", en: "Payroll transfer reference" },
  "dash.source.label": { ko: "데이터 소스", en: "Data sources" },
  "dash.source.toast": { ko: "Toast POS (데모 데이터 생성)", en: "Toast POS (demo data)" },
  "dash.source.square": { ko: "Square Sandbox 동기화", en: "Sync Square Sandbox" },
  "dash.source.syncQueued": {
    ko: "동기화를 요청했습니다. 잠시 후 자동으로 반영됩니다.",
    en: "Sync was queued. Updates will appear shortly.",
  },
  "dash.banner.signerMismatch": {
    ko: "연결된 지갑이 등록된 사업장 지급 지갑과 다릅니다. 이 지갑으로는 USDC 지급에 서명할 수 없습니다.",
    en: "The connected wallet differs from the venue signer. It cannot sign this USDC payout.",
  },
  "me.banner.noWallet": {
    ko: "USDC 팁을 받으려면 수령 지갑을 연결해야 합니다. 지갑이 없으면 사업장이 지급을 진행할 수 없습니다.",
    en: "Connect a wallet to receive USDC tips. Without one, the venue cannot pay you on-chain.",
  },
  "me.banner.goConnect": { ko: "지갑 연결하러 가기", en: "Go connect a wallet" },
  "me.wallet.connect": { ko: "지갑 연결 (Phantom)", en: "Connect wallet (Phantom)" },
  "me.wallet.connectMore": { ko: "다른 지갑 추가", en: "Add another wallet" },
  "dash.payout.refConfirm": { ko: "기록", en: "Record" },
  "dash.payout.refCancel": { ko: "취소", en: "Cancel" },
  "dash.payout.noWallet": {
    ko: "직원의 수취 지갑이 등록되지 않았습니다. 직원이 내 소득 화면에서 지갑을 연결해야 합니다.",
    en: "No worker wallet is registered. The worker must connect one on their income page.",
  },
  "verify.yes": { ko: "있음", en: "Yes" },
  "verify.no": { ko: "없음", en: "No" },
  "verify.footer": {
    ko: "원본 소득 데이터와 PDF는 공개되지 않습니다. Devnet 테스트 토큰은 화폐 가치가 없습니다.",
    en: "Raw income data and the PDF are never exposed. Devnet test tokens have no monetary value.",
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
