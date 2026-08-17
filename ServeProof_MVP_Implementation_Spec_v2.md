# ServeProof MVP 구현 명세서

## 0. 문서 목적

이 문서는 ServeProof POC의 전체 플로우, 외부 데이터 접근성 제약, Solana 기반 USDC 정산, 시프트 단위 소득·세금 observability, 선택적 소득 공개 요구를 하나의 구현 기준으로 정리한다.

MVP의 핵심 목표는 다음과 같다.

1. 외부 팁·근무 데이터를 수집하거나 CSV/Mock으로 대체한다.
2. 외부 직원 식별자를 ServeProof 노동자 프로필에 연결한다.
3. 버전이 있는 팁 배분 정책으로 노동자별 배분액을 계산한다.
4. 사업장 관리자가 배분 결과를 검토·승인한다.
5. 승인된 배분 중 일부를 Solana USDC로 실제 지급한다.
6. 시프트별로 `earned → allocated → paid → payroll_reported → withheld` 상태를 추적한다.
7. 원본을 삭제하지 않는 정정·철회 원장을 유지한다.
8. 노동자가 선택한 범위만 PDF·QR로 공개한다.
9. 소득 원문은 오프체인에 두고, 온체인에는 지급과 무결성 검증에 필요한 최소 정보만 기록한다.

---

# 1. 제품 정의

ServeProof는 팁 노동자의 소득을 단순히 기록하는 앱이 아니다.

> **ServeProof는 분산된 팁·근무·지급·Payroll·원천징수 증거를 시프트 단위로 연결하고, 승인된 배분을 검증 가능한 지급과 휴대 가능한 소득증명으로 변환하는 income and tax observability layer다.**

MVP에서는 세금 신고, W-2 제출, 법률 자문, 원천징수 금액 확정 계산을 직접 제공하지 않는다.

ServeProof가 추적하는 상태는 다음과 같다.

```text
earned
→ allocated
→ approved
→ paid
→ payroll_reported
→ withheld
```

각 상태는 별도 이벤트이며, 뒤 상태가 앞 상태를 덮어쓰지 않는다.

---

# 2. MVP 범위

## 2.1 반드시 구현할 기능

- Web2 기반 사업장·노동자 로그인
- 사업장 조직 및 관리자 권한
- 노동자 프로필과 외부 직원 ID 매핑
- CSV/JSON 데이터 가져오기
- Mock Toast·Payroll·Payout Provider
- Square Sandbox Adapter
- 팁·근무 데이터 정규화
- 팁 종류 분류
- 시프트 관리
- 버전형 팁 배분 정책
- 노동자별 배분 계산
- 사업장 승인
- 레거시 지급 증거 등록
- Solana native USDC 지급
- Settlement 중복 지급 방지
- 온체인 이벤트 인덱싱
- 시프트별 income/tax observability
- 증거 등급
- 정정·반전 원장
- 선택적 공개
- PDF·인쇄·QR 검증

## 2.2 선택 구현

- Gusto Demo Adapter
- embedded wallet
- gas sponsorship
- worker ATA 자동 생성
- 보고서 hash 온체인 등록
- 이메일 수신자 제한 공유
- 공유 링크 만료·철회

## 2.3 MVP 제외

- Toast 실제 프로덕션 연결
- ADP 실제 연동
- Branch·DailyPay 실제 지급
- Stripe fiat-to-USDC payout
- 자동 W-2 수정
- 세금 신고서 작성
- 확정 세액 계산
- 대출 심사 API
- ZK 소득증명
- 카드 결제 금액의 자동 USDC 전환
- 스테이블코인 수탁·환전 사업

---

# 3. 사용자와 액터

## 3.1 Worker

- 자신의 프로필 확인
- 사업장별 외부 직원 계정 연결 확인
- 수취 지갑 확인·교체
- 시프트별 earned/allocated/paid 상태 확인
- Payroll·원천징수 미확인 경고 확인
- 공개할 기록과 범위 선택
- PDF 또는 QR 보고서 발급
- 공유 링크 철회

노동자는 지급 수취 시 매번 온체인 서명을 하지 않아도 된다.

## 3.2 Venue Owner / Manager

- 사업장 생성
- 사업장 구성원 초대
- 외부 데이터 소스 연결
- 직원 ID 매핑 확인
- 팁 정책 설정
- 배분 계산 실행
- 배분 검토 및 승인
- 지급 경로 선택
- USDC 지급 트랜잭션 서명
- 정정·분쟁 처리
- Payroll·지급 확인 데이터 등록

## 3.3 External Provider

- Square
- Toast Mock
- CSV
- Payroll Mock
- Payout Provider Mock
- 향후 Gusto·Toast·ADP·Branch·DailyPay

## 3.4 Verifier

- 임대인
- 고용주
- 대출기관
- 세무사
- Staffing platform

Verifier는 기본적으로 별도 계정 없이 QR·검증 링크로 문서 유효성을 확인할 수 있다.

---

# 4. 인증과 지갑 구조

## 4.1 인증 원칙

ServeProof는 wallet-only 앱으로 만들지 않는다.

```text
로그인 수단
≠
ServeProof 사용자 신원
≠
지급 지갑
```

## 4.2 Worker 인증

권장 방식:

- 이메일 OTP
- Google 로그인
- Apple 로그인
- 선택적 embedded Solana wallet
- 기존 Phantom/Solflare 연결 옵션

내부 구조:

```text
ServeProof Worker
├─ auth_user_id
├─ external_worker_accounts[]
└─ wallets[]
```

## 4.3 Venue 인증

- 회사 이메일 또는 Google/Microsoft 로그인
- 조직 단위 RBAC
- 역할: OWNER, MANAGER, PAYROLL_ADMIN, VIEWER
- 지급 시 연결된 Solana signer wallet 사용

## 4.4 Wallet 원칙

- worker_id가 중심 식별자
- wallet address는 교체 가능한 지급 계정
- 한 노동자에게 여러 지갑 연결 가능
- 기본 수취 지갑은 하나만 활성화
- 과거 지급 기록은 당시 수취 지갑을 보존

---

# 5. 기술 스택

## 5.1 Frontend

- Next.js 15
- TypeScript
- React
- Tailwind CSS
- shadcn/ui
- TanStack Query
- React Hook Form
- Zod
- Solana Wallet Adapter 또는 Wallet Standard
- PDF viewer / QR renderer

## 5.2 Backend

- NestJS
- TypeScript
- REST API
- Swagger/OpenAPI
- Prisma ORM
- PostgreSQL
- Redis
- BullMQ
- JWT/session 기반 인증
- S3 호환 Object Storage

## 5.3 Blockchain

- Solana
- Anchor
- Rust
- SPL Token Program
- Associated Token Program
- USDC-compatible SPL mint
- Devnet에서는 테스트 mint 사용
- Anchor IDL 기반 TypeScript client
- 향후 Kora fee sponsorship 검토

## 5.4 Infrastructure

POC 권장:

- Vercel: frontend
- Railway/Fly.io/Render: backend
- Supabase/Neon: PostgreSQL
- Upstash/Redis Cloud: Redis
- Cloudflare R2 또는 Supabase Storage: PDF·snapshot
- Helius/QuickNode/Triton 등 RPC
- Devnet 우선

## 5.5 Testing

- Jest
- Supertest
- Playwright
- Anchor test
- Solana local validator
- Contract integration test
- CSV fixture test
- E2E demo scenario test

---

# 6. 시스템 컴포넌트

```text
Frontend
├─ Worker App
├─ Venue Dashboard
└─ Public Verification Page

Backend
├─ Auth Module
├─ Organization Module
├─ Worker Identity Module
├─ Evidence Adapter Module
├─ Evidence Normalization Module
├─ Shift Module
├─ Allocation Module
├─ Approval Module
├─ Settlement Orchestrator
├─ Solana Adapter
├─ Legacy Payout Evidence Module
├─ Payroll Observability Module
├─ Evidence Grade Module
├─ Correction Ledger Module
├─ Income Ledger Module
├─ Disclosure Module
└─ Report Generator

On-chain
├─ ServeProof Program
├─ Global Config PDA
├─ Venue PDA
├─ Vault Authority PDA
├─ Venue USDC Token Account
├─ Settlement Record PDA
├─ Worker USDC Token Account
└─ SPL Token Program
```

---

# 7. 데이터 유입 모델

## 7.1 Tip Inflow와 Worker Payout 분리

Tip inflow:

- CASH_TIP
- CARD_TIP
- QR_TIP
- AUTOMATIC_GRATUITY
- SERVICE_CHARGE

Worker payout:

- CASH_RETAINED
- CASH_DRAWER
- PAYROLL
- PAYOUT_PROVIDER
- BANK_REFERENCE
- USDC

카드 팁이 발생했다고 특정 노동자에게 지급된 것은 아니다.

## 7.2 Square Sandbox Adapter

실제 구현한다.

수집 대상:

- Payment
- tip_money
- Order
- total_tip_money
- team_member_id
- Timecard
- declared_cash_tip_money
- refund/cancel status

Square는 final pooled allocation을 제공하지 않는 것으로 가정한다.

## 7.3 CSV Adapter

CSV는 모든 외부 공급자의 공통 fallback이다.

```csv
provider,venue_external_id,worker_external_id,shift_external_id,tip_type,gross_tip,clock_in,clock_out,role,payout_route,payroll_status
toast_mock,venue_001,worker_001,shift_001,CARD_TIP,120.00,2026-08-05T17:00:00Z,2026-08-05T22:00:00Z,SERVER,PAYROLL,PROVIDER_CONFIRMED
```

## 7.4 Mock Adapter

- MockToastEvidenceProvider
- MockGustoPayrollProvider
- MockBranchPayoutProvider
- MockStripeStablecoinPayoutProvider

Mock는 실제 provider와 같은 공통 인터페이스를 구현한다.

---

# 8. 공통 어댑터 인터페이스

```ts
export interface EvidenceProvider {
  readonly provider: string;

  fetchTipEvidence(
    venueId: string,
    period: DateRange,
  ): Promise<TipEvidence[]>;

  fetchShiftEvidence(
    venueId: string,
    period: DateRange,
  ): Promise<ShiftEvidence[]>;

  healthCheck(): Promise<ProviderHealth>;
}
```

```ts
export interface PayrollProvider {
  fetchPayrollRecords(
    venueId: string,
    period: DateRange,
  ): Promise<PayrollRecord[]>;

  verifyPayrollReference(
    reference: string,
  ): Promise<PayrollVerificationResult>;
}
```

```ts
export interface SettlementProvider {
  readonly rail: SettlementRail;

  createPayout(
    request: PayoutRequest,
  ): Promise<PayoutResult>;

  verifyPayout(
    reference: string,
  ): Promise<PayoutStatus>;
}
```

구현 상태:

```text
SquareSandboxEvidenceProvider      LIVE
CsvEvidenceProvider                LIVE
MockToastEvidenceProvider          MOCK
MockGustoPayrollProvider           MOCK
MockBranchPayoutProvider           MOCK

SolanaVaultSettlementProvider      LIVE
LegacyReferenceSettlementProvider  LIVE
StripeStablecoinPayoutProvider     FUTURE
```

---

# 9. 핵심 데이터 모델

## 9.1 User

```ts
type UserRole =
  | "WORKER"
  | "VENUE_OWNER"
  | "VENUE_MANAGER"
  | "PAYROLL_ADMIN"
  | "VIEWER";
```

필드:

- id
- authUserId
- email
- displayName
- role
- createdAt
- updatedAt

## 9.2 Organization

- id
- legalName
- displayName
- status
- country
- timezone
- createdAt

## 9.3 Venue

- id
- organizationId
- externalIds
- name
- timezone
- status
- solanaVenuePda
- vaultTokenAccount
- payoutSignerWallet

## 9.4 Worker

- id
- userId
- status
- defaultWalletId
- verificationStatus

## 9.5 ExternalWorkerAccount

- id
- workerId
- venueId
- provider
- externalWorkerId
- mappingStatus
- verifiedBy
- verifiedAt

## 9.6 WorkerWallet

- id
- workerId
- chain
- address
- walletType
- status
- isDefault
- linkedAt

## 9.7 TipEvidence

- id
- provider
- venueId
- externalPaymentId
- externalOrderId
- tipType
- grossAmountUsd
- paymentStatus
- refundStatus
- businessDate
- sourcePayloadUri
- sourceHash
- observedAt

## 9.8 ShiftEvidence

- id
- provider
- venueId
- externalShiftId
- externalWorkerId
- mappedWorkerId
- role
- clockIn
- clockOut
- workedMinutes
- shiftStatus
- sourceHash

## 9.9 AllocationPolicy

- id
- venueId
- version
- status
- allocationType
- roleWeights
- tipOutRules
- effectiveFrom
- effectiveTo
- createdBy

## 9.10 AllocationBatch

- id
- venueId
- businessDate
- tipPoolAmountUsd
- policyId
- policyVersion
- status
- evidenceHash
- allocationHash
- calculatedAt
- approvedAt
- approvedBy

상태:

```text
DRAFT
CALCULATED
REVIEW_REQUIRED
APPROVED
PAYABLE
PARTIALLY_PAID
PAID
CORRECTED
REVERSED
```

## 9.11 WorkerAllocation

- id
- batchId
- workerId
- grossTipUsd
- pooledTipUsd
- tipOutGivenUsd
- tipOutReceivedUsd
- netAllocatedUsd
- payoutRail
- payoutStatus

## 9.12 Payout

- id
- paymentId
- allocationId
- workerId
- venueId
- rail
- asset
- amount
- amountUsd
- status
- externalReference
- txSignature
- settlementPda
- initiatedAt
- settledAt
- failedReason

상태:

```text
CREATED
INITIATED
SUBMITTED
CONFIRMED
FINALIZED
FAILED
REVERSED
```

## 9.13 PayrollRecord

- id
- workerId
- venueId
- periodStart
- periodEnd
- reportedTipUsd
- federalWithholdingUsd
- stateWithholdingUsd
- socialSecurityUsd
- medicareUsd
- status
- providerReference

## 9.14 IncomeEntry

- id
- workerId
- venueId
- shiftId
- earnedUsd
- allocatedUsd
- paidUsd
- payrollReportedUsd
- withholdingStatus
- payoutRail
- evidenceGrade
- effectiveStatus
- originalEntryId
- correctionOfId

## 9.15 DisclosureGrant

- id
- workerId
- recipientEmail
- purpose
- fieldScope
- venueScope
- dateRange
- expiresAt
- allowDownload
- revokedAt
- accessTokenHash

## 9.16 VerificationReport

- id
- workerId
- disclosureGrantId
- reportHash
- reportUri
- status
- issuedAt
- expiresAt
- revokedAt
- previousReportId
- onchainRecordReference

---

# 10. 팁 배분 엔진

## 10.1 입력

- TipEvidence[]
- ShiftEvidence[]
- Worker mappings
- AllocationPolicy
- business date
- venue timezone

## 10.2 기본 알고리즘

```text
worker_score = worked_minutes × role_weight
allocation = total_pool × worker_score / total_score
```

## 10.3 계산 규칙

- shift status가 COMPLETED 또는 APPROVED인 근무만 포함
- manager/supervisor 제외 규칙 지원
- tip type별 pool 포함 여부 설정
- CASH_RETAINED는 중복 배분되지 않도록 분리
- tip-out given/received를 별도 필드로 저장
- 반올림 오차는 마지막 노동자 또는 remainder account에 배정
- 계산 결과 합계는 tip pool 총액과 일치해야 함

## 10.4 버전 관리

정책 수정 시 기존 version을 변경하지 않는다.

새 버전을 생성한다.

과거 AllocationBatch는 계산 당시 policyVersion을 유지한다.

---

# 11. 사업장 승인

## 11.1 승인 전 검사

- 누락된 worker mapping
- workedMinutes 음수·0
- 유효하지 않은 역할
- 팁 풀 합계 불일치
- 중복 payment evidence
- refund 완료 결제 포함
- 이미 승인된 batch
- 다른 timezone business date 혼입

## 11.2 승인 데이터

- approvedBy
- approvedAt
- allocationHash
- evidenceSnapshotHash
- batch status = APPROVED → PAYABLE

## 11.3 승인 권한

- OWNER
- MANAGER

Payroll admin은 조회·Payroll 상태 수정만 가능하게 시작한다.

---

# 12. 지급 경로

## 12.1 Legacy Reference

MVP에서는 다음 증거를 수동 또는 Mock으로 등록한다.

- cash retained
- cash drawer payout
- payroll confirmation
- bank reference
- payout provider transaction ID

## 12.2 Native USDC

전제:

- Worker allocation = PAYABLE
- Worker wallet verified
- Worker USDC token account 존재 또는 생성 가능
- Venue vault balance 충분
- paymentId 미사용
- venue signer 권한 유효

---

# 13. 온체인 계정 구조

## 13.1 GlobalConfig PDA

Seed:

```text
["config"]
```

필드:

- admin
- usdcMint
- paused
- version
- bump

## 13.2 Venue PDA

Seed:

```text
["venue", venueIdHash]
```

필드:

- venueIdHash
- venueAuthority
- vaultAuthority
- active
- createdAt
- bump

## 13.3 VaultAuthority PDA

Seed:

```text
["vault_authority", venuePda]
```

역할:

- Venue USDC Token Account authority
- ServeProof Program이 invoke_signed로 사용

## 13.4 Venue USDC Token Account

- mint = config.usdcMint
- authority = VaultAuthority PDA
- amount = venue-funded balance

## 13.5 Worker USDC Token Account

- mint = config.usdcMint
- owner = Worker Wallet

권장: ATA 사용.

## 13.6 SettlementRecord PDA

Seed:

```text
["settlement", paymentIdHash]
```

필드:

- paymentIdHash
- allocationHash
- venue
- workerWallet
- amount
- status
- settledAt
- correctionReference
- bump

---

# 14. Anchor Program instruction

## 14.1 initialize_config

입력:

- usdcMint

권한:

- deploy/admin signer

결과:

- GlobalConfig PDA 생성

## 14.2 register_venue

입력:

- venueIdHash
- venueAuthority

결과:

- Venue PDA 생성
- VaultAuthority PDA 파생

## 14.3 initialize_venue_vault

결과:

- Venue USDC ATA 또는 PDA-owned token account 생성
- authority = VaultAuthority PDA

## 14.4 settle_payout

입력:

- paymentIdHash
- allocationHash
- amount

계정:

- venueAuthority signer
- globalConfig
- venuePda
- vaultAuthorityPda
- venueVaultTokenAccount
- workerWallet
- workerUsdcTokenAccount
- settlementRecordPda
- usdcMint
- tokenProgram
- systemProgram
- associatedTokenProgram

검사:

1. protocol not paused
2. venue active
3. signer == venue authority
4. venue vault authority == VaultAuthority PDA
5. source and destination mint == USDC mint
6. worker token account owner == worker wallet
7. settlement record 미생성 또는 미정산
8. vault balance >= amount
9. allocationHash != zero
10. amount > 0

동작:

1. 필요 시 worker ATA 생성
2. SPL Token Program `transfer_checked` CPI
3. SettlementRecord 생성
4. status = SETTLED
5. PayoutSettled event 발생

## 14.5 mark_corrected

입력:

- settlement payment ID
- correction hash

동작:

- 원본 삭제 금지
- status = CORRECTED 또는 DISPUTED
- correction reference 기록

## 14.6 pause / unpause

관리자 전용.

---

# 15. Solana 이벤트

```rust
pub struct PayoutSettled {
    pub payment_id_hash: [u8; 32],
    pub allocation_hash: [u8; 32],
    pub venue: Pubkey,
    pub worker_wallet: Pubkey,
    pub amount: u64,
}
```

추가 이벤트:

- VenueRegistered
- VaultInitialized
- SettlementCorrected
- ProgramPaused

---

# 16. Settlement Orchestrator

## 16.1 트랜잭션 생성

1. DB transaction으로 Payout 생성
2. idempotency key = paymentId
3. on-chain account 파생
4. worker ATA 확인
5. transaction 생성
6. venue signer 서명 요청
7. RPC 제출
8. status = SUBMITTED
9. confirmation job enqueue

## 16.2 confirmation

- `confirmed` 시 UI에 처리중 완료 표시 가능
- `finalized` 시 Payout FINALIZED
- tx signature 저장
- slot, blockTime 저장
- SettlementRecord 조회 검증
- token balance 또는 event 검증

## 16.3 실패 처리

- blockhash expired
- user rejected
- insufficient vault
- duplicate settlement
- RPC unavailable
- ATA creation failure

실패 시 같은 paymentId로 무조건 재전송하지 않는다.

SettlementRecord 존재 여부를 먼저 조회한다.

---

# 17. Income and Tax Observability

각 시프트마다 다음 값을 유지한다.

```text
earnedUsd
allocatedUsd
paidUsd
payrollReportedUsd
withholdingStatus
```

## 17.1 discrepancy 규칙

```text
earned != allocated
allocated != paid
paid != payrollReported
payrollReported exists && withholding unknown
payout confirmed && payroll not sent
refund exists && paid amount unchanged
```

## 17.2 경고 타입

- ALLOCATION_GAP
- PAYOUT_GAP
- PAYROLL_GAP
- WITHHOLDING_UNKNOWN
- REFUND_ADJUSTMENT_REQUIRED
- DUPLICATE_EVIDENCE
- UNMAPPED_WORKER
- STALE_PROVIDER_DATA

---

# 18. 증거 등급

## Grade A

- tip evidence
- shift evidence
- approved allocation
- payout confirmation
- payroll confirmation

## Grade B

- tip evidence
- shift evidence
- approved allocation
- native USDC settlement

## Grade C

- tip evidence
- shift evidence
- venue-attested payout

## Grade D

- venue manual input 또는 CSV
- 일부 evidence 누락

## Grade E

- worker self-report only

USDC는 지급을 강하게 증명하지만 Payroll 신고나 실제 시프트를 단독으로 증명하지 않는다.

---

# 19. 정정·반전 원장

원본 record는 삭제하지 않는다.

```text
Original IncomeEntry
→ CorrectionEntry
→ Effective Value
```

정정 사유:

- refund
- void
- chargeback
- tip edit
- shift correction
- worker mapping correction
- policy recalculation
- duplicate payout
- payroll correction

온체인 USDC 전송은 삭제할 수 없다.

이미 지급된 금액은 별도 adjustment payout, 다음 지급에서의 보정, dispute 상태, venue loss 처리 중 하나로 처리한다.

---

# 20. 선택적 공개

## 20.1 원칙

- 소득정보 기본 비공개
- 노동자가 공개 범위를 결정
- 필요한 사람에게 필요한 기간만 공개
- 공개 이력과 접근 로그 저장
- 노동자가 언제든 철회

## 20.2 공개 수준

### LEVEL_1

조건 충족 여부만 공개.

```text
최근 6개월 평균 소득 ≥ $3,000
결과: TRUE
```

### LEVEL_2

- 월평균 소득
- 소득 지속성
- payer 수
- verification grade

### LEVEL_3

- 사업장별
- 시프트별
- 지급 경로별
- Payroll 상태
- 원천징수 상태

## 20.3 공유 링크

- 랜덤 토큰
- 토큰 hash DB 저장
- 만료 시간
- 특정 이메일 제한
- OTP 검증 선택
- 다운로드 허용 여부
- 철회
- 조회 로그

---

# 21. PDF·QR 보고서

## 21.1 PDF 내용

- worker display name 또는 masked identity
- 기간
- 총 verified income
- 평균 월소득
- payer count
- 지급 경로 구성
- evidence grade
- correction status
- report ID
- issuer
- QR verification URL

민감 필드:

- 지갑 주소 전체 숨김
- 시프트 세부사항 선택적 포함
- withholding 상세 선택적 포함

## 21.2 QR verification

Verifier 화면:

- VALID / EXPIRED / REVOKED / CORRECTED
- report hash match
- issuer status
- issuedAt
- expiresAt
- disclosed fields
- 원본 raw income 비공개

## 21.3 온체인 앵커

MVP에서는 선택.

온체인 저장 시:

- reportHash
- issuer
- issuedAt
- status
- previousReportHash

상세 PDF 원문은 오프체인 저장.

---

# 22. API 설계

## Auth

```text
POST /auth/otp/request
POST /auth/otp/verify
POST /auth/social/callback
```

## Organizations / Venues

```text
POST /organizations
POST /organizations/:id/members
POST /venues
GET  /venues/:id
POST /venues/:id/wallet
```

## Provider Connections

```text
POST /providers/square/connect
GET  /providers/square/callback
POST /providers/csv/import
GET  /providers/:provider/health
```

## Worker Mapping

```text
GET  /venues/:venueId/unmapped-workers
POST /worker-mappings
PATCH /worker-mappings/:id/respond
```

## Evidence

```text
POST /evidence/sync
GET  /venues/:venueId/tip-evidence
GET  /venues/:venueId/shift-evidence
```

## Policies

```text
POST /venues/:venueId/allocation-policies
GET  /venues/:venueId/allocation-policies
POST /allocation-policies/:id/new-version
```

## Allocations

```text
POST /allocation-batches/calculate
GET  /allocation-batches/:id
POST /allocation-batches/:id/approve
POST /allocation-batches/:id/reject
```

## Payouts

```text
POST /payouts
POST /payouts/:id/submit
GET  /payouts/:id
POST /payouts/:id/legacy-evidence
```

## Payroll

```text
POST /payroll/import
GET  /workers/:workerId/payroll-status
```

## Income

```text
GET /workers/me/income-timeline
GET /workers/me/discrepancies
GET /workers/me/income-summary
```

## Disclosure

```text
POST   /disclosures
GET    /disclosures/:id
DELETE /disclosures/:id
POST   /reports
GET    /verify/:token
```

---

# 23. 주요 화면

## Worker

1. 로그인
2. 내 프로필
3. 지갑 설정
4. 시프트 타임라인
5. 소득 상태
6. discrepancy alerts
7. 공유 범위 선택
8. PDF·QR 생성
9. 공유 내역·철회

## Venue

1. 조직·사업장 생성
2. provider 연결
3. 데이터 import
4. worker mapping
5. allocation policy
6. 계산 결과
7. 승인
8. payout route 선택
9. USDC 지급 서명
10. reconciliation
11. corrections

## Public Verifier

1. QR 접근
2. 유효성 상태
3. 공개 허용된 필드
4. issuer·report status
5. 만료·철회 여부

---

# 24. 보안 요구사항

## Backend

- 모든 provider token 암호화 저장
- refresh token rotation
- 조직별 tenant isolation
- RBAC
- audit log
- signed URL
- access token hash 저장
- PDF object 비공개 bucket
- rate limiting
- PII 로그 금지

## On-chain

- signer 검증
- PDA seed 충돌 방지
- USDC mint 고정
- token account owner 검증
- duplicate payment 방지
- amount > 0
- pause authority
- upgrade authority 관리
- checked transfer
- integer overflow 방지
- arbitrary CPI 금지

## 개인정보

온체인 금지:

- 실명
- 이메일
- SSN
- 사업장별 상세 소득
- Payroll raw data
- 원천징수 원문
- W-2
- PDF 원문

---

# 25. 상태 머신

## Allocation

```text
DRAFT
→ CALCULATED
→ REVIEW_REQUIRED
→ APPROVED
→ PAYABLE
→ PARTIALLY_PAID
→ PAID
```

예외:

```text
CORRECTED
REVERSED
DISPUTED
```

## Payout

```text
CREATED
→ INITIATED
→ SUBMITTED
→ CONFIRMED
→ FINALIZED
```

예외:

```text
FAILED
REVERSED
CORRECTED
```

## Report

```text
DRAFT
→ ISSUED
→ EXPIRED
```

예외:

```text
CORRECTED
REVOKED
```

---

# 26. 데모 시나리오

1. Venue Manager 로그인
2. Square Sandbox 연결 또는 CSV 업로드
3. 카드 팁 $120 생성
4. 직원 3명 Timecard import
5. 1명의 외부 ID 미매핑 상태 표시
6. 관리자 매핑 완료
7. 팁 정책 선택
8. Allocation Engine 계산
9. 관리자 승인
10. Worker A는 Payroll route
11. Worker B는 USDC route
12. Venue vault balance 확인
13. Venue signer가 트랜잭션 서명
14. Worker B Devnet USDC ATA로 지급
15. PayoutSettled 이벤트 감지
16. Worker B 상태가 PAID로 변경
17. Payroll Mock import
18. Worker A payroll confirmed
19. Worker B payroll pending alert
20. Worker가 최근 3개월 요약만 공개
21. PDF와 QR 발급
22. Verifier가 QR을 열어 유효성 확인
23. 관리자가 한 shift를 correction 처리
24. 기존 report가 corrected 상태로 변경

---

# 27. 구현 단계

## Phase 1 — Domain Core

- Prisma schema
- 조직·사업장·노동자
- CSV Adapter
- Worker mapping
- Allocation policy
- Allocation calculation
- Venue approval

## Phase 2 — Solana Settlement

- Anchor program
- Config/Venue/Vault/Settlement PDA
- Devnet test mint
- Vault funding
- settle_payout
- indexer
- payout status

## Phase 3 — Observability

- IncomeEntry
- Payroll mock
- discrepancy rules
- evidence grade
- correction ledger

## Phase 4 — Selective Disclosure

- disclosure grant
- PDF
- QR
- verification page
- expiration/revocation

## Phase 5 — External Integration

- Square Sandbox
- provider health
- resync
- adapter error handling

---

# 28. 완료 기준

## 기능

- CSV 또는 Square에서 tip/shift 데이터 수집
- worker mapping 성공
- 정책 기반 배분 합계 정확
- 관리자 승인 전 지급 불가
- 동일 paymentId 이중 지급 불가
- USDC 실제 전송 성공
- tx signature와 Settlement PDA 저장
- Payroll pending 상태 구분
- discrepancy 경고 생성
- correction 원본 유지
- 선택 공개 PDF·QR 발급
- 철회된 링크 접근 차단

## 테스트

- unit tests
- API integration tests
- Anchor tests
- idempotency tests
- duplicate payment tests
- invalid mint tests
- insufficient vault tests
- tenant isolation tests
- report revocation tests
- full demo E2E

---

# 29. Deployment and Operations

이 장은 공개 캡스톤 데모 배포를 위한 필수 운영 기준을 정의한다.

목표는 다음을 실제로 시연 가능한 상태로 만드는 것이다.

- 외부에서 접근 가능한 웹 URL
- Square Sandbox 또는 CSV 기반 데이터 수집
- Solana Devnet 상 실제 테스트 USDC 전송
- 온체인 settlement 확인
- PDF·QR 보고서 발급
- 만료·철회 가능한 공개 검증 페이지
- API·Worker 장애를 확인할 수 있는 기본 모니터링

프로덕션 상용 서비스 수준의 보안·법률·운영 요구사항은 별도 단계로 둔다.

---

## 29.1 환경 분리

최소 세 개의 환경을 분리한다.

### local

```text
Solana local validator
Local PostgreSQL
Local Redis
Mock providers
Local object storage 또는 filesystem
Test keypairs
```

목적:

- 빠른 개발
- Anchor program 테스트
- DB migration 검증
- CSV·Mock 시나리오 반복
- 외부 API 장애와 무관한 E2E 테스트

### staging

```text
Solana Devnet
Square Sandbox
테스트 사용자·사업장
테스트 SPL mint
Private object storage
실제 배포된 API와 Worker
```

목적:

- 공개 데모
- 실제 브라우저 wallet 서명
- 실제 Devnet transaction
- 실제 PDF·QR 검증
- Square Sandbox 동기화
- 장애·재시도 테스트

### production

```text
Solana Mainnet
실제 provider credentials
실제 사용자·사업장
실제 개인정보
실제 USDC mint
실제 treasury 운영
```

MVP에서는 production 배포를 실행하지 않는다.

단, 코드와 환경변수 구조는 production 전환이 가능하도록 분리한다.

### 환경별 필수 변수

```env
NODE_ENV=
APP_ENV=

DATABASE_URL=
REDIS_URL=

SOLANA_RPC_URL=
SOLANA_NETWORK=
SERVEPROOF_PROGRAM_ID=
USDC_MINT=

SQUARE_APP_ID=
SQUARE_ACCESS_TOKEN=
SQUARE_ENVIRONMENT=

OBJECT_STORAGE_BUCKET=
OBJECT_STORAGE_ENDPOINT=
OBJECT_STORAGE_ACCESS_KEY=
OBJECT_STORAGE_SECRET_KEY=

AUTH_SECRET=
REPORT_SIGNING_KEY=

SENTRY_DSN=
LOG_LEVEL=
```

추가 원칙:

- `.env`는 저장소에 커밋하지 않는다.
- `.env.example`에는 변수명과 설명만 둔다.
- local, staging, production secret은 분리한다.
- staging key를 production에서 재사용하지 않는다.
- provider token은 DB에 암호화해 저장한다.

---

## 29.2 추천 캡스톤 배포 구성

```text
Frontend
→ Vercel

API
→ Railway NestJS service

Background Worker
→ Railway worker service

Database
→ Supabase PostgreSQL

Queue
→ Upstash Redis + BullMQ

Storage
→ Supabase Storage private bucket

Blockchain
→ Solana Devnet + Anchor program

RPC
→ Helius Devnet RPC

External Data
→ Square Sandbox + CSV fixtures

Monitoring
→ Sentry + structured JSON logs
```

대체 가능 구성:

- Railway 대신 Render 또는 Fly.io
- Supabase PostgreSQL 대신 Neon
- Supabase Storage 대신 Cloudflare R2
- Helius 대신 QuickNode 또는 Triton

MVP에서는 공급자 교체가 쉽도록 URL과 credential을 환경변수로 분리한다.

---

## 29.3 Solana 프로그램 배포 절차

백엔드와 프론트엔드 배포 전에 Anchor 프로그램을 먼저 준비한다.

전체 순서:

```text
Anchor build
→ Anchor/local validator test
→ Devnet program deploy
→ Program ID 고정
→ initialize_config
→ 테스트 USDC mint 생성·설정
→ 사업장 Venue PDA 생성
→ Venue Vault 생성
→ Venue Vault 테스트 USDC 충전
→ Backend에 Program ID와 mint 등록
→ Frontend에 Program ID와 network 등록
```

권장 명령 흐름:

```bash
anchor build
anchor test

solana config set --url devnet
anchor deploy --provider.cluster devnet
```

배포 후 반드시 확인할 항목:

- 실제 배포된 Program ID
- `Anchor.toml` Program ID
- `declare_id!` Program ID
- Backend 환경변수
- Frontend 환경변수

네 곳의 값이 일치해야 한다.

### 테스트 mint 원칙

POC에서는 Devnet 공식 USDC에 의존하지 않는다.

직접 생성한 SPL 테스트 mint를 사용한다.

```text
Token name shown in UI:
Test USDC

Symbol:
tUSDC

Decimals:
6
```

UI와 PDF에 다음 문구를 표시한다.

> This transaction uses a Devnet test token and has no monetary value.

테스트 mint authority와 freeze authority는 별도 배포용 keypair로 관리한다.

---

## 29.4 배포 키 관리

### Program deployer 및 upgrade authority

POC에서도 개인 개발 지갑과 배포 권한을 분리한다.

필수 원칙:

- 별도 deployer keypair 사용
- 저장소에 keypair 파일 커밋 금지
- Docker image에 keypair 포함 금지
- CI 로그에 private key 출력 금지
- 암호화된 secret 또는 안전한 로컬 저장소 사용
- 복구 가능한 백업 1개 유지

POC에서는 단일 upgrade authority를 허용한다.

프로덕션 전환 시:

- multisig
- 조직형 키 관리
- upgrade delay
- 배포 승인 절차
- verifiable build

를 추가한다.

### Backend signer 원칙

Backend는 Venue Vault 출금 private key를 보유하지 않는다.

권장 흐름:

```text
Backend
→ unsigned 또는 partially signed transaction 생성

Venue Wallet
→ 사용자에게 승인 내용 표시
→ venue authority 서명

RPC
→ signed transaction 제출
```

장점:

- 백엔드 침해가 곧 vault 출금 권한 탈취로 이어지지 않음
- 사용자가 지급 전 amount·worker·venue를 확인 가능
- POC에서 온체인 서명 과정을 명확히 시연 가능

Backend가 fee payer를 맡는 경우에도 vault authority는 소유하지 않는다.

---

## 29.5 API와 Worker 분리 배포

NestJS API 프로세스와 백그라운드 작업 프로세스를 분리한다.

### API Service

담당:

- 로그인
- 사용자·사업장 조회
- worker mapping
- 정책 CRUD
- 배분 계산 요청
- 배분 승인
- transaction 생성
- 보고서 생성 요청
- 공개 검증 API

실행 명령 예:

```bash
npm run start:api
```

### Worker Service

담당:

- Square 데이터 동기화
- CSV 대량 처리
- Solana transaction confirmation
- blockhash 만료 후 상태 확인
- provider 재시도
- PDF 생성
- report hash 계산
- 공유 링크 만료
- 철회 처리
- reconciliation job
- stale record 탐지

실행 명령 예:

```bash
npm run start:worker
```

### Queue 분리

권장 BullMQ queue:

```text
provider-sync
csv-import
allocation-calculate
solana-confirmation
payout-reconcile
payroll-import
report-generate
disclosure-expire
audit-cleanup
```

API는 오래 걸리는 작업을 직접 수행하지 않고 job ID를 반환한다.

---

## 29.6 데이터베이스 마이그레이션

배포 시 Prisma migration을 명시적으로 실행한다.

권장 순서:

```text
Install
→ Build
→ Unit test
→ Integration test
→ prisma migrate deploy
→ API deploy
→ Worker deploy
→ Smoke test
```

명령:

```bash
npx prisma migrate deploy
```

원칙:

- API 인스턴스 시작 시 자동 migration 금지
- 별도 release command에서 1회만 실행
- destructive migration은 staging에서 먼저 검증
- migration 전 DB backup
- migration 실패 시 API·Worker 신규 버전 배포 중단
- seed 데이터는 migration과 분리

Staging seed:

- Demo organization
- Demo venue
- Demo workers
- Demo allocation policy
- Test wallet mappings
- CSV fixtures

---

## 29.7 RPC 장애와 재시도

공개 무료 RPC 하나에만 의존하지 않는다.

### 필수 설정

- 전용 Devnet RPC URL
- request timeout
- retry backoff
- transaction signature 저장
- latest blockhash와 lastValidBlockHeight 저장
- confirmation polling
- finalized 확인 job
- Settlement PDA 조회
- paymentId 기반 idempotency
- RPC 오류 logging

### 중요한 원칙

```text
HTTP 요청 재시도
≠
USDC 전송 무조건 재실행
```

재시도 전 다음을 확인한다.

1. DB에 transaction signature가 있는가
2. signature status가 confirmed/finalized인가
3. SettlementRecord PDA가 존재하는가
4. SettlementRecord status가 SETTLED인가
5. worker token account balance 변화가 확인되는가

### 처리 예

```text
Case A
RPC 응답 timeout
→ tx signature 존재
→ signature status 조회
→ confirmed이면 재전송 금지

Case B
blockhash expired
→ Settlement PDA 미존재
→ 새 blockhash로 transaction 재생성
→ 사용자 재서명 요청

Case C
duplicate payment error
→ Settlement PDA 조회
→ 이미 settled이면 DB를 reconciliation
```

### confirmation 기준

```text
SUBMITTED
→ signature 확보

CONFIRMED
→ UI에 지급 성공 표시 가능

FINALIZED
→ Income Ledger 최종 확정
```

데모에서는 confirmed 상태를 빠르게 보여주고, Worker가 finalized로 후속 갱신한다.

---

## 29.8 PDF·QR 배포 보안

PDF는 public bucket에 저장하지 않는다.

권장 구조:

```text
Private Object Storage
→ 짧은 만료시간의 Signed URL
```

### PDF 접근

- PDF object key는 추측 불가능한 UUID 사용
- signed URL은 5~15분 만료
- report status가 REVOKED이면 signed URL 발급 금지
- worker와 허용된 recipient만 원본 PDF 다운로드 가능
- public verifier는 PDF object URL을 직접 받지 않음

### 공개 검증 페이지

```text
GET /verify/:token
```

검증 페이지에서 확인:

- report status
- 만료 여부
- 철회 여부
- correction 여부
- disclosure field scope
- report hash
- issuer status
- issuedAt
- expiresAt

공개 페이지는 허용된 필드만 렌더링한다.

### 공유 token

DB에는 원문 token이 아니라 hash를 저장한다.

```text
raw token
→ 사용자에게 URL로 전달

token hash
→ DB 저장
```

추가 보안:

- optional recipient email restriction
- email OTP
- view count limit
- IP rate limit
- access audit log
- worker 즉시 철회

---

## 29.9 관측성과 로그

캡스톤 데모에서도 최소 운영 가시성을 확보한다.

### 수집 대상

- API error
- authentication failure
- Worker job failure
- Square sync 결과
- CSV import 결과
- allocation calculation failure
- venue approval audit
- payout state transition
- Solana RPC latency
- transaction submit 결과
- confirmation retry count
- Settlement PDA reconciliation
- PDF generation failure
- verification access
- disclosure revoke
- provider health check

### 도구

- Sentry
- structured JSON logs
- Railway log drain 또는 기본 log viewer
- 선택적으로 uptime monitor

### 권장 log context

```json
{
  "requestId": "uuid",
  "jobId": "uuid",
  "organizationId": "uuid",
  "venueId": "uuid",
  "paymentId": "hashed-or-internal-id",
  "provider": "square",
  "network": "devnet",
  "status": "FAILED"
}
```

### 절대 로그에 남기지 않는 값

- access token
- refresh token
- 이메일 OTP
- auth cookie
- private key
- seed phrase
- REPORT_SIGNING_KEY
- 전체 income record
- 원천징수 상세
- provider raw payload 전체
- PDF 원문
- signed URL 전체

PII가 포함된 오류는 redact 후 전송한다.

---

## 29.10 CI/CD

권장 GitHub Actions 흐름:

```text
Pull Request
→ lint
→ typecheck
→ unit test
→ API integration test
→ Anchor build
→ Anchor test

main merge
→ production build
→ staging migration
→ API staging deploy
→ Worker staging deploy
→ Frontend staging deploy
→ smoke test
```

Program deploy는 일반 애플리케이션 배포와 분리한다.

```text
Manual workflow
→ Anchor test
→ deploy approval
→ Devnet deploy
→ Program ID verification
→ initialize / migration instruction
→ backend config update
```

Program ID가 바뀌는 배포는 frontend/backend보다 먼저 완료한다.

---

## 29.11 Health Check와 Smoke Test

### API health

```text
GET /health
GET /health/database
GET /health/redis
GET /health/solana
GET /health/providers/square
```

### Worker health

- 최근 heartbeat
- queue backlog
- failed job count
- 최근 Solana confirmation 성공 시각
- 최근 Square sync 성공 시각

### 배포 후 Smoke Test

1. frontend 접속
2. API health 확인
3. DB·Redis 연결 확인
4. Demo venue 조회
5. CSV fixture import
6. allocation 계산
7. wallet 연결
8. 테스트 USDC 지급
9. tx confirmed 확인
10. report 생성
11. QR 검증
12. report 철회 후 접근 차단

---

## 29.12 백업과 복구

데모에서도 최소 기준을 둔다.

- PostgreSQL daily backup 또는 provider PITR
- Object Storage versioning 또는 삭제 보호
- Program deployer key 암호화 백업
- test mint authority 백업
- staging seed 재생성 script
- DB restore runbook

복구 우선순위:

```text
1. 사용자·조직·배분 DB
2. 지급과 settlement reference
3. Disclosure·report metadata
4. PDF object
5. Provider raw snapshot
```

온체인 settlement는 Solana에서 다시 조회할 수 있으나, off-chain 의미 연결을 위해 `paymentId`, `allocationHash`, `txSignature`는 반드시 백업한다.

---

# 30. 캡스톤 배포 완료 기준

다음 조건을 모두 만족하면 공개 데모 배포 완료로 본다.

## Application

- Vercel 공개 URL 접속 가능
- Venue·Worker 로그인 가능
- 조직·사업장 데이터 tenant isolation 적용
- CSV import 가능
- Square Sandbox sync 가능
- 배분 계산·승인 가능

## Blockchain

- Anchor program Devnet 배포
- Program ID 환경변수 고정
- tUSDC mint 표시
- Venue PDA 생성
- Venue Vault 충전
- 실제 Devnet payout 성공
- duplicate payment 차단
- transaction signature 표시
- confirmed/finalized 상태 분리

## Worker and Queue

- API와 Worker 별도 프로세스
- Redis queue 작동
- confirmation 재시도 작동
- PDF 비동기 생성
- failed job 확인 가능

## Privacy and Report

- PDF private bucket 저장
- signed URL 만료
- 선택 공개 field scope 적용
- QR verification 작동
- report 만료·철회 작동
- 철회 후 raw PDF 접근 차단

## Operations

- `prisma migrate deploy` release command
- Sentry error 수집
- structured logs
- health endpoint
- staging smoke test
- secret 미커밋 검사

이 수준이면 다음을 실제로 증명할 수 있다.

> 공개 웹 애플리케이션에서 외부 Sandbox 또는 CSV 데이터를 수집하고, 사업장이 배분을 승인하며, Solana Devnet에서 테스트 USDC를 실제 지급하고, 노동자가 선택적으로 공개 가능한 PDF·QR 소득증명을 발급하는 전체 흐름이 동작한다.

---

# 31. 최종 구현 원칙

```text
외부 시스템은 원천 증거를 제공한다.
ServeProof는 배분의 의미와 승인 과정을 만든다.
Solana는 승인된 USDC 지급을 실행하고 증명한다.
Payroll과 세금은 별도 상태로 관찰한다.
소득은 기본 비공개이며 노동자가 선택적으로 공개한다.
원본 기록은 삭제하지 않고 정정 이력을 남긴다.
```

최종적으로 ServeProof가 증명하려는 것은 단순한 지갑 송금이 아니다.

> **어떤 외부 증거와 어떤 정책을 근거로, 어떤 사업장이 어떤 노동자에게 얼마를 승인했고, 실제로 어떤 경로로 지급했으며, 그 지급이 Payroll과 원천징수에 어떻게 반영되었는지를 검증 가능한 하나의 생명주기로 만드는 것**이 핵심이다.
