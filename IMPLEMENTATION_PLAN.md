# ServeProof MVP 구현 계획 (Implementation Plan)

> 기준 문서: [ServeProof_MVP_Implementation_Spec_v2.md](ServeProof_MVP_Implementation_Spec_v2.md)
> 작성일: 2026-08-06

이 문서는 명세서의 Phase 1~5(§27)를 기반으로, 실제 작업 순서·산출물·완료 기준을 실행 가능한 단계로 세분화한 구현 계획이다.

---

## 전체 로드맵 요약

```text
Phase 0  프로젝트 셋업 (monorepo, CI, 환경 분리)
Phase 1  Domain Core (DB, 조직/노동자, CSV, 배분 엔진, 승인)
Phase 2  Solana Settlement (Anchor program, USDC 지급, 인덱싱)
Phase 3  Observability (IncomeEntry, Payroll mock, 경고, 등급, 정정 원장)
Phase 4  Selective Disclosure (공개 grant, PDF, QR, 검증 페이지)
Phase 5  External Integration (Square Sandbox, provider health)
Phase 6  Deployment & Demo (staging 배포, smoke test, 데모 시나리오)
```

의존 관계:

- Phase 1은 모든 후속 단계의 전제.
- Phase 2는 Phase 1의 승인(PAYABLE) 상태에 의존.
- Phase 3은 Phase 1(배분)·Phase 2(지급) 데이터를 소비.
- Phase 4는 Phase 3의 IncomeEntry·evidence grade에 의존.
- Phase 5는 Phase 1의 어댑터 인터페이스만 있으면 병렬 진행 가능.
- Phase 6은 전체 통합 후 최종 단계.

---

## Phase 0 — 프로젝트 셋업

### 0.1 저장소 구조

- [x] monorepo 구성 (pnpm workspace)
  ```text
  serveproof/
  ├─ apps/
  │  ├─ web/        # Next.js 15 frontend
  │  ├─ api/        # NestJS API service
  │  └─ worker/     # NestJS background worker (BullMQ)
  ├─ packages/
  │  ├─ db/         # Prisma schema + client
  │  ├─ shared/     # 공통 타입, Zod 스키마, 상수
  │  └─ solana/     # Anchor IDL 기반 TS client
  ├─ programs/
  │  └─ serveproof/ # Anchor program (Rust)
  └─ fixtures/      # CSV fixture, seed 데이터
  ```
- [x] TypeScript, Prettier, tsconfig 공통 설정
- [x] `.env.example` 작성 (§29.1의 환경변수 전체 목록)
- [x] `.gitignore`에 `.env`, keypair 파일 포함

### 0.2 로컬 개발 환경

- [x] docker-compose: PostgreSQL + Redis (파일 준비 — WSL Docker integration 활성화 필요)
- [x] Solana CLI 4.0.3 + Anchor 0.32.1 설치 확인
- [x] local / staging / production 환경 변수 구조 분리 (§29.1)

### 0.3 CI 기본 골격

- [x] GitHub Actions: PR 시 lint → typecheck → build → unit test
- [x] Anchor build job은 Phase 2에서 별도 workflow로 추가 (§29.10 원칙)
- [x] secret 미커밋 검사 (gitleaks)

**완료 기준**: 로컬에서 `web/api/worker` 빈 앱이 각각 기동되고, CI가 PR에서 통과한다.

---

## Phase 1 — Domain Core

> 목표: CSV 데이터로 팁 배분 계산 → 사업장 승인까지 오프체인 전체 흐름 동작.

### 1.1 Prisma Schema (§9 핵심 데이터 모델)

- [x] User, Organization, OrganizationMember(RBAC: OWNER/MANAGER/PAYROLL_ADMIN/VIEWER)
- [x] Venue (solanaVenuePda, vaultTokenAccount, payoutSignerWallet 필드 포함 — Phase 2에서 채움)
- [x] Worker, ExternalWorkerAccount, WorkerWallet
- [x] TipEvidence, ShiftEvidence (sourceHash, sourcePayloadUri 포함)
- [x] AllocationPolicy(버전형), AllocationBatch, WorkerAllocation
- [x] Payout, PayrollRecord, IncomeEntry, DisclosureGrant, VerificationReport
      (테이블은 미리 정의하되 사용은 Phase 2~4에서)
- [x] 조직별 tenant isolation을 위한 organizationId/venueId 인덱스 설계
- [x] `prisma migrate dev` (`20260806043930_init`) + seed script (demo org/venue/workers) — 로컬 Postgres는 포트 충돌로 **5433** 사용

### 1.2 Auth Module (§4)

- [x] 이메일 OTP 로그인 (`POST /auth/otp/request`, `POST /auth/otp/verify`) — Redis TTL 5분, 시도 5회 제한, 로컬은 devCode 반환
- [x] JWT access(15m) + refresh token rotation(7d, 단일 사용, DB hash 저장) + `POST /auth/refresh`, `POST /auth/logout`
- [ ] Google 소셜 로그인 (`POST /auth/social/callback`) — 후순위
- [x] RBAC: 전역 JwtAuthGuard(@Public 예외) + AccessService.assertVenueRole(OWNER/MANAGER vs 조회 role)
- [x] tenant isolation: 모든 venue-scoped API가 조직 멤버십 검사 후 데이터 접근

### 1.3 Organization / Venue Module

- [x] `POST /organizations` (생성자=OWNER), `POST /organizations/:id/members` (이메일 초대, OWNER 전용), `GET /organizations/mine`
- [x] `POST /venues`, `GET /venues/:id`
- [x] `POST /venues/:id/wallet` (payout signer wallet, base58 형식 검증)

### 1.4 Worker Identity Module

- [x] Worker 프로필 조회 (`GET /workers/me` — 외부 계정·지갑 포함)
- [x] WorkerWallet 연결 (`POST /workers/me/wallets`, `PATCH .../default` — 첫 지갑 자동 default, 단일 default 강제 §4.4)
- [x] ExternalWorkerAccount 매핑 (verify 시 기존 ShiftEvidence backfill 포함):
  - `GET /venues/:venueId/unmapped-workers`
  - `POST /worker-mappings`
  - `PATCH /worker-mappings/:id/verify`

### 1.5 Evidence Adapter — 공통 인터페이스 + CSV (§7, §8)

- [ ] `EvidenceProvider`, `PayrollProvider`, `SettlementProvider` 인터페이스 정의 — Square/Mock 어댑터 추가 시(Phase 5) 도입
- [x] CSV 파싱 + Zod 검증 + 정규화 (apps/api/src/evidence/csv-normalizer.ts)
- [ ] MockToastEvidenceProvider 구현 (같은 인터페이스)
- [x] Evidence Normalization: tipType 분류, USD센트 정규화, sourceHash 계산, upsert 멱등 import
- [x] `POST /providers/csv/import` — 현재 동기 처리; BullMQ `csv-import` queue 오프로드는 대량 처리 필요 시
- [x] `GET /venues/:venueId/tip-evidence`, `GET /venues/:venueId/shift-evidence` (`POST /evidence/sync`는 Phase 5)
- [x] CSV fixture로 E2E 검증 완료

### 1.6 Shift Module

- [x] ShiftEvidence → 시프트 관리 (venue timezone 기준 business date 계산 — `businessDateInTimezone`)
- [x] mappedWorkerId 연결 (import 시 해석 + mapping verify 시 backfill)

### 1.7 Allocation Policy Module (§9.9, §10.4)

- [x] 정책 CRUD: `POST /venues/:venueId/allocation-policies`, `GET ...`
- [x] 버전 관리: 새 버전 append(version=max+1) + 이전 ACTIVE 자동 ARCHIVED, 기존 버전 불변 (`POST /allocation-policies/:id/new-version` — clone+override)
- [x] roleWeights, tipOutRules(필드), tip type별 poolInclusion 설정

### 1.8 Allocation Engine (§10)

- [x] 입력 수집: TipEvidence + ShiftEvidence + mapping + policy + business date
- [x] 기본 알고리즘: `worker_score = worked_minutes × role_weight`, 비례 배분 (packages/shared/src/allocation.ts — 순수 함수)
- [x] 계산 규칙:
  - COMPLETED/APPROVED shift만 포함
  - 제외 role 규칙 (excludedRoles)
  - CASH_RETAINED 분리 (poolInclusion으로 CASH_TIP 제외)
  - refund FULL / canceled payment 풀 제외
  - 반올림: largest-remainder 배정 → **합계 = tip pool 총액 invariant 검증**
- [ ] tip-out given/received 규칙 (tipOutRules — 필드는 준비, 로직 미구현)
- [x] `POST /allocation-batches/calculate` — 동기 처리 (queue 오프로드는 필요 시)
- [x] evidenceHash, allocationHash 계산·저장
- [x] 단위 테스트 7종: 데모 시나리오 정합, 반올림 보존, 제외 규칙, refund, 미매핑, timezone

### 1.9 Approval Module (§11)

- [x] 승인 전 검사 → REVIEW_REQUIRED 처리 (미매핑 worker, 음수/0 workedMinutes, unknown role, refund 제외 플래그; 중복 evidence는 DB unique 제약으로 차단)
- [x] `POST /allocation-batches/:id/approve`, `POST .../reject` — **권한 검사(OWNER/MANAGER)는 1.2 Auth 이후 연결**
- [x] 승인 시 approvedBy/approvedAt/allocationHash/evidenceHash 기록
- [x] 상태 머신 강제: REVIEW_REQUIRED 승인 불가, 이중 승인 409, 승인 후 재계산 409
- [x] audit log 기록 (approve/reject)

### 1.10 Venue Dashboard 화면 (Frontend 1차)

- [x] 로그인 (OTP 2단계, 로컬 devCode 표시)
- [x] CSV import 화면
- [x] worker mapping 화면 (pending 표시 + 매핑 확정 버튼)
- [ ] allocation policy 설정 화면 (API만 존재 — UI 후순위)
- [x] 계산 결과·승인 화면 (상태 칩, review issues, 배분 테이블, 승인 버튼)

**완료 기준 (Phase 1)**

- CSV import → 정규화 → 매핑 → 정책 기반 배분 계산 → 승인(PAYABLE)까지 E2E 동작
- 배분 합계 = tip pool 총액 테스트 통과
- 승인 전 지급 불가 (상태 머신 강제)
- tenant isolation 테스트 통과

---

## Phase 2 — Solana Settlement

> 목표: 승인된 배분을 Devnet에서 실제 테스트 USDC로 지급하고, 중복 지급을 온체인에서 차단.

### 2.1 Anchor Program (§13, §14)

> 구현 위치: `onchain/` (Anchor 0.32 workspace, 프로그램 crate `onchain/programs/serveproof`)
> Devnet Program ID: `A2snJHtFRK8wKawieDTQy6wMReJCP3BxU6i6y9aECJhi`

- [x] 계정 구조:
  - GlobalConfig PDA `["config"]` — admin, usdcMint, paused, version
  - Venue PDA `["venue", venueIdHash]` (venueIdHash = sha256(venue UUID))
  - VaultAuthority PDA `["vault_authority", venuePda]` (data 없는 authority PDA)
  - SettlementRecord PDA `["settlement", paymentIdHash]`
- [x] instruction 구현:
  - `initialize_config`
  - `register_venue`
  - `initialize_venue_vault` (authority = VaultAuthority PDA)
  - `settle_payout` — 검사 10종(§14.4) + `transfer_checked` CPI + SettlementRecord 생성 + PayoutSettled event
  - `mark_corrected` (원본 삭제 금지, status만 변경)
  - `pause` / `unpause`
- [x] 이벤트: PayoutSettled, VenueRegistered, VaultInitialized, SettlementCorrected, ProgramPaused (§15)
- [x] 온체인 보안 체크리스트 반영 (§24): signer 검증, mint 고정(config), ATA owner 검증, amount > 0, checked transfer, PDA seed 격리. mark_corrected는 venue authority 또는 admin만

### 2.2 Anchor 테스트 (local validator) — **14/14 통과**

- [x] happy path: config → venue → vault → fund → settle_payout (+ PayoutSettled 이벤트 수신 검증)
- [x] duplicate payment 차단 (동일 paymentIdHash → account already in use)
- [x] invalid mint (vault ATA 제약이 선차단)
- [x] insufficient vault
- [x] wrong signer / paused 상태 / 관리자 아닌 pause / 관리자 아닌 register_venue
- [x] mark_corrected (원본 보존 + CORRECTED 상태) / 무관한 signer 거부
- [x] zero amount, zero allocationHash 거부

### 2.3 Devnet 배포 (§29.3)

- [ ] deployer keypair 분리 — **현재 개발 지갑(8uBo...U8k)이 deploy/admin/venue authority 겸용. 캡스톤 데모까지는 허용, staging 전 분리 필요**
- [x] Devnet 배포 → Program ID `A2snJHtFRK8wKawieDTQy6wMReJCP3BxU6i6y9aECJhi` (공용 RPC 혼잡 시 `--with-compute-unit-price` 재시도)
- [x] Program ID 4곳 일치: 배포 ID / Anchor.toml / declare_id! / .env
- [x] tUSDC mint 생성: `4R3s4BJLvBMKKgWFxsxPTCnZDuDK9dB46WJKPeaJMrDF` (decimals 6)
- [x] `onchain/scripts/init-devnet.mjs`(멱등): initialize_config → demo venue 등록 → vault 생성 → 500 tUSDC 충전 (상태는 `onchain/devnet-state.json`)
- [x] `onchain/scripts/smoke-settle.mjs`: **실제 Devnet 지급 26.72 tUSDC 성공 + 중복 지급 온체인 거부 확인**

### 2.4 Backend Solana Adapter + Settlement Orchestrator (§16)

- [x] Anchor IDL 기반 TypeScript client (packages/solana — PDA 파생, unsigned tx 빌더, SettlementRecord 조회)
- [x] Payout 생성: idempotency key = paymentId = allocation id (allocation당 1결제, unique 제약)
- [x] **unsigned transaction 생성 → venue wallet 서명 → RPC 제출** 흐름 (§29.4 — backend는 vault key 미보유)
- [x] worker ATA 자동 생성 (프로그램의 init_if_needed, payer = venue authority)
- [x] `POST /payouts`, `GET /payouts/:id/transaction`, `POST /payouts/:id/submit`, `GET /payouts/:id`, `POST /payouts/legacy-evidence`
- [x] Payout 상태 머신: CREATED → INITIATED → SUBMITTED → CONFIRMED → FINALIZED (§25) + tx 재생성 전 온체인 PDA 선조회

### 2.5 Confirmation Worker + 실패 처리 (§16.2~16.3, §29.7)

- [x] BullMQ `solana-confirmation` queue: signature status polling (attempts 10, exponential backoff)
- [x] confirmed → CONFIRMED 표시, finalized → FINALIZED + slot/blockTime 저장 + allocation PAID + batch PARTIALLY_PAID/PAID 롤업
- [x] SettlementRecord PDA 조회 검증 (finalize 시 금액 대조)
- [x] 실패 케이스 처리 (§29.7 Case A/B/C):
  - signature 미발견 → PDA 선조회, 존재하면 재전송 금지·정합화
  - tx error → PDA 조회 후 존재하면 정합화, 아니면 FAILED
  - INITIATED 10분 초과 + PDA 미존재 → blockhash_expired FAILED (재시도 가능)
- [x] `payout-reconcile` queue: 60초 주기 repeatable job으로 stale payout 탐지·정합화
- [x] retry backoff, 실패 로그

### 2.6 온체인 이벤트 인덱싱

- [x] PayoutSettled 웹소켓 구독 (worker) → paymentIdHash 매칭 → Payout CONFIRMED 갱신
- [x] txSignature, settlementPda, paymentIdHash DB 저장

### 2.7 Legacy Payout Evidence Module (§12.1)

- [x] `POST /payouts/legacy-evidence` — rail(CASH_RETAINED/PAYROLL/BANK_REFERENCE 등) + externalReference 등록 → venue-attested FINALIZED
- [x] allocation PAID + batch 롤업 연동

### 2.8 Frontend 지갑 연동

- [x] 지갑 연결: injected provider(window.solana — Phantom/Solflare 호환) 경량 통합 (apps/web/src/lib/wallet.ts). Wallet Adapter로 교체 가능 구조
- [x] Venue: 지급 섹션 — allocation별 "USDC 지급(지갑 서명)" 버튼 → unsigned tx 수신 → 지갑 서명(signer 주소 일치 검증) → 제출 → 상태 폴링(FINALIZED까지). "Legacy 증빙" 버튼 병행
- [x] Worker: 지갑 목록·기본 지갑 표시 (/me — 추가/교체 UI는 후순위, API는 존재)
- [x] "Devnet test token, no monetary value" 문구 표시

**완료 기준 (Phase 2)**

- Devnet에서 실제 tUSDC 전송 성공, tx signature + Settlement PDA 저장
- 동일 paymentId 이중 지급 온체인 차단
- confirmed/finalized 상태 분리 표시
- Anchor 테스트 전체 통과 (duplicate, invalid mint, insufficient vault 포함)

---

## Phase 3 — Observability

> 목표: 시프트 단위 `earned → allocated → paid → payroll_reported → withheld` 상태 추적과 경고.

### 3.1 Income Ledger Module (§9.14, §17)

- [x] IncomeEntry 생성 파이프라인: `POST /venues/:venueId/income/rebuild` — shift별 earned/allocated/paid/payrollReported/withholding 집계 (멱등, 정정된 계보는 보존)
- [x] 각 상태는 별도 필드 — 뒤 상태가 앞 상태를 덮어쓰지 않음
- [x] `GET /workers/me/income-timeline`, `GET /workers/me/income-summary`

### 3.2 Payroll Observability Module (§9.13)

- [x] Mock payroll import (gusto_mock — 이메일 기반 worker 매칭)
- [x] `POST /payroll/import` — 동기 처리 + import 후 자동 income rebuild (queue 오프로드는 필요 시)
- [x] PayrollRecord ↔ shift 매칭 (periodStart≤businessDate≤periodEnd), withholding 유무·PROVIDER_CONFIRMED로 CONFIRMED/PENDING 구분
- [x] `GET /workers/:workerId/payroll-status` (본인 또는 venue staff)

### 3.3 Discrepancy 엔진 (§17.1~17.2)

- [x] 규칙 구현: earned>0&allocated=0, allocated>0&paid=0, paid>0&payrollReported=0, withholding unknown, refund exists & paid unchanged
- [x] 경고 6종 생성: ALLOCATION_GAP, PAYOUT_GAP, PAYROLL_GAP, WITHHOLDING_UNKNOWN, REFUND_ADJUSTMENT_REQUIRED, UNMAPPED_WORKER
- [ ] DUPLICATE_EVIDENCE(DB unique로 원천 차단됨), STALE_PROVIDER_DATA — Phase 5 provider sync 시 추가
- [x] `GET /workers/me/discrepancies`

### 3.4 Evidence Grade Module (§18)

- [x] Grade A~E 판정: A(지급+payroll confirmed) / B(USDC finalized) / C(venue-attested) / D(evidence만) / E — E2E에서 A·B·D 실측 확인
- [x] IncomeEntry.evidenceGrade 저장

### 3.5 Correction Ledger Module (§19)

- [x] 원본 불변: `POST /income-entries/:id/correct` → 원본 SUPERSEDED + 새 ACTIVE 엔트리(correctionOfId/originalEntryId 체인) + audit log
- [x] 정정 사유는 자유 텍스트(reason) — enum 강제는 후순위
- [ ] 이미 지급된 금액 처리 경로(adjustment payout 등) — Phase 4 이후
- [ ] 온체인 정정 `mark_corrected` 연동 — 지갑 서명 UI(2.8)와 함께
- [ ] Venue corrections 화면 — UI 단계

### 3.6 Worker 화면 (Frontend 2차)

- [x] 시프트 타임라인 (/me — 배분/지급/payroll/원천징수/경로/등급/정정 배지)
- [x] 소득 상태 대시보드 (요약 카드: 배분·지급 총액, 월평균, payer/시프트 수)
- [x] discrepancy alerts 화면 (타입별 한국어 설명)
- [x] 로그인 후 role 라우팅: WORKER → /me, staff → /dashboard
- [x] Venue 대시보드에 IncomeEntry 재계산 버튼 (payroll import는 API로 수행)

**완료 기준 (Phase 3)**

- Payroll pending/confirmed 상태 구분 표시
- discrepancy 경고 생성 확인 (데모 시나리오 19번: Worker B payroll pending alert)
- correction 후 원본 유지 + effective value 계산 정확

---

## Phase 4 — Selective Disclosure

> 목표: 노동자가 선택한 범위만 PDF·QR로 공개, 만료·철회 동작.

### 4.1 Disclosure Module (§20)

- [x] DisclosureGrant: `POST /disclosures`(raw 토큰 1회 반환), `GET /disclosures`, `DELETE /disclosures/:id`(철회 — 발급된 report도 REVOKED)
- [x] 공개 수준 3단계: LEVEL_1(threshold 충족 TRUE/FALSE만), LEVEL_2(월평균·개월 수·payer 수·grade), LEVEL_3(시프트별 payroll·원천징수 포함 상세)
- [x] fieldScope(threshold) / dateRange / expiresAt / allowDownload (venueScope 필터는 후순위)
- [x] 공유 토큰: base64url 랜덤 → URL로 1회 전달, **DB에는 sha256 해시만 저장** (§29.8)
- [x] 접근 audit log (DisclosureAccessLog: ip/userAgent) — view count limit·IP rate limit는 후순위

### 4.2 Report Generator (§21)

- [x] `POST /reports` — 동기 생성 (pdfkit; queue 오프로드는 필요 시). 발급 시점 **불변 snapshot** 저장 → 검증 페이지는 라이브 데이터가 아닌 snapshot 렌더
- [x] PDF 내용: worker명, 기간, verified income, 월평균, payer count, evidence grade, correction 유무, report ID, issuer, **QR(공유 URL)** + Devnet 문구
- [x] 민감 필드: 지갑 주소 미포함, 시프트 상세는 LEVEL_3만
- [x] reportHash = HMAC(REPORT_SIGNING_KEY, snapshot)
- [x] 로컬 private 디렉터리(var/reports, gitignore) 저장 — **staging에서 S3 호환 bucket + signed URL로 교체 필요**
- [x] REVOKED면 PDF 접근 403

### 4.3 Public Verification Page (§21.2, §29.8)

- [x] `GET /verify/:token` — @Public, 계정 불필요. 웹 `/verify/[token]` 페이지
- [x] 표시: VALID/EXPIRED/REVOKED/CORRECTED/NOT_ISSUED, report hash, issuer, issuedAt/expiresAt, snapshot의 허용 필드만
- [x] REVOKED 시 소득 필드 미반환, PDF URL 절대 비노출

### 4.4 만료·철회 Worker

- [x] BullMQ `disclosure-expire` — 5분 주기 repeatable로 만료 report EXPIRED 처리 (+ 읽기 시점 백스톱)
- [x] 철회 즉시 반영: verify REVOKED + disclosed 숨김 + PDF 403 (E2E 확인)
- [x] correction 발생 시 해당 worker의 ISSUED report → CORRECTED 자동 전환 (E2E 확인 — 데모 23~24단계)

### 4.5 Worker 화면 (Frontend 3차)

- [x] 공유 범위 선택 UI (목적, level 3종 — 기간은 최근 3개월 고정, 세분화는 후순위)
- [x] 발급 → 공유 URL(1회 표시) + QR 렌더 + PDF 다운로드
- [x] 공유 내역 목록 (report 상태 배지) + 철회 버튼

**완료 기준 (Phase 4)**

- 선택 공개 PDF·QR 발급 성공
- QR 검증 페이지에서 허용 필드만 표시
- 철회된 링크 접근 차단 + raw PDF 접근 차단 테스트 통과

---

## Phase 5 — External Integration

> 목표: Square Sandbox 실연동 + provider 운영 안정성.

### 5.1 Square Sandbox Adapter (§7.2)

- [x] Square OAuth: `POST /providers/square/connect`, `GET /providers/square/callback` (일회성 state hash, 10분 만료)
- [x] access/refresh token AES-256-GCM 암호화 저장 + 만료 전 refresh (§24)
- [x] 수집: Payment(tip_money), Order(total_tip_money fallback), Timecard(team_member_id, declared_cash_tip_money), refund/cancel status
- [x] `EvidenceProvider` 인터페이스로 정규화 (sourceHash 기반 upsert로 CSV와 동일 TipEvidence/ShiftEvidence 파이프라인 합류)
- [x] BullMQ `provider-sync` queue: 15분 주기 동기화 + `POST /evidence/sync` 기간 지정 수동 트리거

### 5.2 Provider Health & 에러 처리

- [x] `GET /providers/:provider/health?venueId=...` (tenant RBAC, latency/최근 sync/실패 횟수/stale)
- [x] resync 기능 (기간 지정 재수집, provider 복합 unique + sourceHash 기반 중복 방지)
- [x] rate limit / token 만료 / API 오류 재시도 (BullMQ exponential backoff 6회, OAuth refresh)
- [x] STALE_PROVIDER_DATA 경고 연동 (24시간 기준, 성공 시 자동 resolve)

구현 검증: Square provider 단위 테스트 3/3, API 통합 테스트의 OAuth connect RBAC/authorization URL,
Sandbox access token으로 Locations/Payments/Timecards API 모두 200 응답 확인(현재 fixture 0건). 실제 OAuth
callback과 샌드박스 팁·Timecard 수집은 Square seller 승인 및 fixture 생성 후 end-to-end 확인한다.

**완료 기준 (Phase 5)**

- Square Sandbox에서 카드 팁·Timecard 수집 → 배분 계산까지 동일 파이프라인 동작
- provider health 확인 및 장애 시 재시도 동작

---

## Phase 6 — Deployment & Demo (§29~30)

### 6.1 Staging 배포

- [ ] Frontend → Vercel
- [ ] API + Worker → Railway 별도 서비스 (start:api / start:worker)
- [ ] DB → Supabase PostgreSQL, Queue → Upstash Redis, Storage → Supabase private bucket
- [ ] RPC → Helius Devnet
- [ ] `prisma migrate deploy`를 release command로 분리 (자동 migration 금지)
- [ ] staging seed: demo org/venue/workers/policy/wallet mappings/CSV fixtures

### 6.2 관측성 (§29.9)

- [ ] Sentry 연동 (PII redact)
- [ ] structured JSON logs (requestId, jobId, venueId, network, status)
- [ ] 금지 로그 값 검사: token, OTP, private key, income record, signed URL 등

### 6.3 Health Check (§29.11)

- [ ] `GET /health`, `/health/database`, `/health/redis`, `/health/solana`, `/health/providers/square`
- [ ] Worker heartbeat, queue backlog, failed job count 노출

### 6.4 CI/CD 완성 (§29.10)

- [ ] main merge → build → staging migration → API/Worker/Frontend 배포 → smoke test
- [ ] Program deploy는 수동 workflow 분리 (Program ID verification 포함)

### 6.5 백업 (§29.12)

- [ ] PostgreSQL daily backup/PITR 활성화
- [ ] paymentId, allocationHash, txSignature 백업 확인
- [ ] DB restore runbook 작성

### 6.6 데모 시나리오 검증 (§26 — 24단계)

- [x] Supertest API 통합 테스트: OTP/refresh rotation, RBAC, tenant isolation,
      CSV→매핑→정책→배분→승인 상태 전이 및 중복 승인/재계산 차단
- [ ] Playwright E2E: 데모 시나리오 1~24 전체 자동화
      (CSV/Square 수집 → 매핑 → 배분 → 승인 → Worker A Payroll route / Worker B USDC route → PayoutSettled → payroll import → discrepancy alert → 선택 공개 → QR 검증 → correction → report CORRECTED)
- [ ] 배포 후 smoke test 12단계 (§29.11) 수행

**완료 기준 (Phase 6)** — §30 캡스톤 배포 완료 기준 전체 충족

---

## 테스트 전략 요약 (§28)

| 종류            | 도구                          | 핵심 대상                                                            |
| --------------- | ----------------------------- | -------------------------------------------------------------------- |
| Unit            | Jest                          | 배분 엔진, 등급 판정, discrepancy 규칙, hash 계산                    |
| API Integration | Supertest                     | 인증, RBAC, tenant isolation, 상태 머신 전이 — 핵심 흐름 구현 완료   |
| Anchor          | anchor test + local validator | settle_payout 검사 10종, duplicate, invalid mint, insufficient vault |
| Idempotency     | Jest/Supertest                | paymentId 중복, confirmation 재시도                                  |
| Fixture         | Jest                          | CSV 파싱·정규화                                                      |
| E2E             | Playwright                    | 데모 시나리오 24단계, report 철회 차단                               |

---

## 리스크와 선행 결정 사항

1. **지갑 서명 UX**: backend가 vault key를 갖지 않으므로 venue 관리자의 브라우저 지갑 서명이 필수 경로 — Phase 2 초기에 Wallet Adapter 연동 검증 필요.
2. **Program ID 관리**: Devnet 재배포 시 4곳(배포 ID / Anchor.toml / declare_id! / env) 동기화 절차를 문서화하고 CI에서 검증.
3. **BullMQ queue 9종**은 Phase별로 점진 도입 (Phase 1: csv-import, allocation-calculate → Phase 2: solana-confirmation, payout-reconcile → ...).
4. **Square Sandbox 계정·앱 등록**은 리드타임이 있으므로 Phase 1 진행 중 미리 신청.
5. **반올림·정밀도**: USD 금액은 decimal(소수점 2자리), USDC는 6 decimals — 변환 규칙을 shared 패키지에 단일 구현.
6. **embedded wallet, gas sponsorship, 보고서 hash 온체인 앵커** 등 §2.2 선택 기능은 전 Phase 완료 후 여유 시에만 착수.
