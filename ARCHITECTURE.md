# ServeProof 코드베이스 맵 (Architecture)

> 최종 갱신: 2026-08-06 (Phase 5 구현 시점)
> 관련 문서: [명세서](ServeProof_MVP_Implementation_Spec_v2.md) · [구현 계획/진행 체크리스트](IMPLEMENTATION_PLAN.md)

---

## 1. 저장소 구조

pnpm workspace monorepo (7개 프로젝트).

```text
serveproof/
├─ apps/
│  ├─ web/          # Next.js 15 프론트엔드 (:3000)
│  ├─ api/          # NestJS REST API (:3001)
│  └─ worker/       # NestJS 백그라운드 워커 (BullMQ 컨슈머)
├─ packages/
│  ├─ shared/       # 순수 도메인 로직·타입 (배분 엔진, money, enum, CSV 스키마)
│  ├─ db/           # Prisma 스키마 + 마이그레이션 + seed + PrismaClient re-export
│  ├─ providers/    # EvidenceProvider, Square API client, provider token 암호화
│  └─ solana/       # Anchor IDL 클라이언트: PDA 파생, unsigned settle tx 빌더, SettlementRecord 조회
├─ onchain/         # Anchor 0.32 workspace (pnpm workspace 밖, 독립 설치)
│  ├─ programs/serveproof/src/lib.rs   # 정산 프로그램 전체 (PDA 4종, instruction 7종, 이벤트 5종)
│  ├─ tests/serveproof.ts              # local validator 테스트 14종
│  ├─ scripts/init-devnet.mjs          # Devnet 부트스트랩 (멱등): mint→config→venue→vault→충전
│  ├─ scripts/smoke-settle.mjs         # Devnet 실지급 스모크 테스트
│  └─ devnet-state.json                # 배포된 주소 기록 (program/mint/venuePda/vault)
├─ fixtures/
│  └─ csv/          # 데모 CSV fixture (§26 시나리오용)
├─ .github/workflows/ci.yml   # lint→build→typecheck→test + gitleaks
├─ docker-compose.yml         # 로컬 Postgres(:5433) + Redis(:6379)
└─ .env / .env.example        # §29.1 환경변수
```

**의존 방향** (역방향 금지):

```text
apps/web ──→ packages/shared
apps/api ──→ packages/shared, packages/db, packages/providers, packages/solana
apps/worker → packages/shared, packages/db, packages/providers, packages/solana
packages/*  → (상호 의존 없음)
```

---

## 2. packages/shared — 순수 도메인 로직

DB·네트워크 I/O가 전혀 없는 순수 TS. 단위 테스트는 여기에 집중돼 있다 (`test/*.test.mjs`, node:test).

| 파일                                                   | 내용                                                                                                                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/enums.ts](packages/shared/src/enums.ts)           | 스펙의 모든 enum: TipType(§7.1), PayoutRail, 상태 머신 3종(§25), EvidenceGrade(§18), DiscrepancyType(§17.2), OrgRole                                                                               |
| [src/money.ts](packages/shared/src/money.ts)           | **금액 규약의 단일 소스**: USD는 정수 센트(int), USDC는 6-decimals base unit(bigint). `parseUsdToCents`, `centsToUsdcBaseUnits` 등                                                                 |
| [src/allocation.ts](packages/shared/src/allocation.ts) | **배분 엔진**(§10). `computeAllocationBatch(tips, shifts, policy)` 순수 함수. largest-remainder 반올림으로 합계=풀 invariant 강제. blocking/non-blocking issue 반환. `businessDateInTimezone` 포함 |
| [src/csv.ts](packages/shared/src/csv.ts)               | §7.3 공통 CSV 행 Zod 스키마                                                                                                                                                                        |
| [src/queues.ts](packages/shared/src/queues.ts)         | BullMQ 큐 이름 9종(§29.5) — API(생산자)와 worker(소비자)가 공유                                                                                                                                    |

---

## 3. packages/db — 데이터 계층

- [prisma/schema.prisma](packages/db/prisma/schema.prisma) — §9 전체 모델. **금액 필드는 `*UsdCents`(Int), 온체인 금액은 `amountBaseUnits`(BigInt)**
- [prisma/seed.mjs](packages/db/prisma/seed.mjs) — 데모 시나리오(§26) seed: Demo Diner, Worker A/B/C(C는 매핑 PENDING), 정책 v1. 멱등
- 마이그레이션: `init` → `auth_refresh_tokens` → `payout_payment_id_hash`

모델 그룹:

```text
인증/테넌시   User, Organization, OrganizationMember(OrgRole), RefreshToken
노동자 신원   Worker, ExternalWorkerAccount(venue+provider+externalId 유니크), WorkerWallet
증거         TipEvidence, ShiftEvidence  (sourceHash, businessDate, provider별 유니크 키)
배분         AllocationPolicy(버전 불변), AllocationBatch(venue+date+policyVersion 유니크), WorkerAllocation
정산(P2)     Payout(paymentId 유니크 = idempotency key)
관측(P3)     PayrollRecord, IncomeEntry(correction 체인), DiscrepancyAlert
공개(P4)     DisclosureGrant(accessTokenHash), DisclosureAccessLog, VerificationReport
감사         AuditLog
```

---

## 4. apps/api — NestJS 모듈 맵

모든 라우트는 전역 `JwtAuthGuard`로 보호되며 `@Public()`만 예외 (health, auth). 권한(authz)은 컨트롤러에서 `AccessService`로 명시적으로 검사한다.

```text
src/
├─ main.ts                 # 부트스트랩, CORS(WEB_ORIGIN)
├─ app.module.ts           # 모듈 조립
├─ prisma/                 # PrismaService (@Global)
├─ common/zod.ts           # parseBody() — Zod body 검증 → 400
├─ auth/                   # ★ 인증·인가의 중심
│  ├─ auth.service.ts      #   OTP(Redis, sha256, TTL 5m, 5회 제한), JWT 발급,
│  │                       #   refresh rotation(DB hash, 단일 사용), logout
│  ├─ auth.controller.ts   #   POST /auth/otp/request|verify, /auth/refresh, /auth/logout
│  ├─ jwt-auth.guard.ts    #   전역 APP_GUARD. @Public() 예외
│  ├─ access.service.ts    #   assertOrgRole / assertVenueRole — RBAC + tenant isolation(§24)
│  │                       #   VENUE_MANAGE_ROLES=[OWNER,MANAGER], VENUE_READ_ROLES=[+PAYROLL_ADMIN,VIEWER]
│  └─ *.decorator.ts       #   @Public, @CurrentUser
├─ organizations/          # POST /organizations, /organizations/:id/members,
│                          # GET /organizations/mine, POST/GET /venues, POST /venues/:id/wallet
├─ policies/               # GET·POST /venues/:venueId/allocation-policies,
│                          # POST /allocation-policies/:id/new-version (버전 append, 이전 ACTIVE→ARCHIVED)
├─ workers/                # GET /workers/me, POST /workers/me/wallets, PATCH .../:id/default
├─ evidence/
│  ├─ csv-normalizer.ts    # §7.3 CSV → 정규화(센트 변환, sourceHash, businessDate). 순수 함수
│  ├─ evidence.service.ts  # 멱등 upsert import + 매핑 해석
│  └─ evidence.controller.ts # POST /providers/csv/import, GET /venues/:id/tip|shift-evidence
├─ providers/              # Square OAuth, health, provider-sync producer
├─ mappings/               # GET /venues/:id/unmapped-workers, POST /worker-mappings,
│                          # PATCH /worker-mappings/:id/verify (기존 시프트 backfill)
├─ allocations/
│  ├─ allocations.service.ts # calculate(엔진 호출→CALCULATED|REVIEW_REQUIRED, evidence/allocationHash),
│  │                         # approve(CALCULATED→PAYABLE, audit log), reject
│  └─ allocations.controller.ts # POST /allocation-batches/calculate, GET /:id, POST /:id/approve|reject
├─ payouts/                # POST /payouts, GET /:id/transaction(unsigned tx), POST /:id/submit,
│                          # GET /:id, POST /payouts/legacy-evidence (venue-attested)
├─ income/                 # POST /venues/:id/income/rebuild (IncomeEntry 투영 + discrepancy 경고),
│                          # GET /workers/me/income-timeline|income-summary|discrepancies,
│                          # POST /income-entries/:id/correct (원본 SUPERSEDED + 새 ACTIVE, §19)
├─ payroll/                # POST /payroll/import (mock, import 후 자동 rebuild),
│                          # GET /workers/:workerId/payroll-status
├─ disclosure/             # POST/GET/DELETE /disclosures (토큰은 1회 반환, DB엔 해시),
│                          # POST /reports (snapshot+HMAC hash+PDF/QR), GET /reports/:id/pdf(소유자만),
│                          # GET /verify/:token (@Public — snapshot의 허용 필드만)
└─ health/                 # GET /health (@Public)
```

**요청 처리 패턴** (모든 venue-scoped 엔드포인트 공통):

```text
JwtAuthGuard(인증) → parseBody(Zod 검증) → AccessService.assertVenueRole(인가/테넌트)
→ Service(도메인 로직, 상태 머신 강제) → Prisma
```

---

## 5. apps/worker — 백그라운드 워커

- [src/queue-runner.service.ts](apps/worker/src/queue-runner.service.ts) — §29.5 큐 9종에 BullMQ Worker 등록. `provider-sync`, `solana-confirmation`, `payout-reconcile`, `disclosure-expire` 실제 프로세서 연결
- [src/square-sync.service.ts](apps/worker/src/square-sync.service.ts) — Square Payment/Order/Timecard 정규화·upsert, OAuth refresh, stale provider 경고
- [src/solana-settlement.service.ts](apps/worker/src/solana-settlement.service.ts) — confirmation 처리(§29.7 Case A/B/C), stale payout 정합화, PayoutSettled 웹소켓 인덱서
- REDIS_URL 미설정 시 경고만 내고 기동

## 6. apps/web — 프론트엔드

```text
src/
├─ lib/api.ts              # fetch 래퍼: localStorage 토큰, ApiError, NEXT_PUBLIC_API_URL
├─ lib/wallet.ts           # injected 지갑(window.solana) 연결·서명. signer 주소 일치 검증
└─ app/
   ├─ page.tsx             # 랜딩 → /login
   ├─ login/page.tsx       # OTP 2단계 → JWT role 기반 라우팅 (WORKER→/me, staff→/dashboard)
   ├─ dashboard/page.tsx   # Venue: CSV import → 매핑 → 계산 → 승인 → 지급(USDC 지갑 서명/legacy)
   │                       # → income rebuild. USDC 흐름: unsigned tx → 지갑 서명 → 제출 → 폴링
   ├─ me/page.tsx          # Worker: 요약 카드, discrepancy 알림, 타임라인, 소득증명 공유
   │                       # (level 선택→발급→QR/공유URL 1회 표시→PDF 다운로드→철회), 지갑
   └─ verify/[token]/      # 공개 검증 페이지 (계정 불필요): 상태 배너 + 허용 필드만 렌더
```

---

## 7. 핵심 도메인 흐름 (현재 동작하는 것)

```text
CSV 텍스트
→ [api/evidence] normalizeCsv: Zod 검증, USD센트, sourceHash, businessDate(venue TZ)
→ TipEvidence/ShiftEvidence 멱등 upsert (+ CONFIRMED 매핑으로 mappedWorkerId 해석)
→ [api/allocations] calculate: 증거 로드 → shared 배분 엔진(순수 함수)
   ├─ blocking issue 있음 → REVIEW_REQUIRED  (예: UNMAPPED_WORKER)
   └─ 없음 → CALCULATED (+ evidenceHash, allocationHash)
→ [api/mappings] verify → 시프트 backfill → 재계산
→ [api/allocations] approve (OWNER/MANAGER) → PAYABLE + AuditLog
→ (Phase 2) PAYABLE 배분을 Solana USDC로 정산
```

상태 머신 가드: REVIEW_REQUIRED 승인 불가(400), 이중 승인(409), 승인 후 재계산(409).

---

## 8. 컨벤션·불변 규칙

1. **금액**: DB·API 내부는 항상 정수 USD 센트. 표시할 때만 달러 변환. USDC 변환은 `money.ts`만 사용
2. **배분 로직은 shared의 순수 함수에만** — API 서비스는 로드/저장만 담당. 테스트도 shared에서
3. **원본 불변**: 승인된 batch는 수정 불가, 정정은 correction ledger(Phase 3)로. Evidence는 sourceHash 기반 멱등 upsert
4. **비밀값은 해시로만 저장**: OTP, refresh token, (Phase 4) disclosure access token
5. **정책 버전 불변**: 수정 = 새 버전 append, 과거 batch는 계산 당시 버전 유지
6. **인가는 컨트롤러에서 명시적으로**: 모든 venue-scoped 라우트는 `assertVenueRole` 호출 필수

---

## 9. 로컬 개발 명령

```bash
docker compose up -d                # Postgres(:5433) + Redis(:6379)
pnpm install
pnpm db:migrate                     # prisma migrate dev
pnpm --filter @serveproof/db seed   # 데모 데이터
pnpm build                          # 전체 빌드 (shared를 먼저 빌드해야 api가 봄)
pnpm dev:api                        # :3001 (또는 apps/api에서 node dist/main.js)
pnpm dev:worker
pnpm dev:web                        # :3000
pnpm test / pnpm typecheck / pnpm lint
```

데모 로그인: `manager@demo.serveproof.local` (OTP devCode가 응답/화면에 표시됨)

주의: 이 머신의 `localhost:5432`는 다른 Postgres가 점유 중이라 **ServeProof는 5433 포트**를 쓴다.

---

## 10. 온체인 프로그램 (Phase 2.1~2.3 완료)

- **Devnet Program ID**: `A2snJHtFRK8wKawieDTQy6wMReJCP3BxU6i6y9aECJhi`
- **tUSDC mint**: `4R3s4BJLvBMKKgWFxsxPTCnZDuDK9dB46WJKPeaJMrDF` (decimals 6, 화폐가치 없음)
- PDA: config `["config"]` / venue `["venue", sha256(venueUUID)]` / vault_authority `["vault_authority", venuePda]` / settlement `["settlement", paymentIdHash]`
- settle_payout 안전장치: paused·inactive venue·wrong signer·wrong mint·잔액 부족·zero amount/hash 거부, **중복 지급은 SettlementRecord PDA init 실패로 원천 차단**
- 정정은 mark_corrected로 상태만 변경 (원본 삭제 불가), pause/unpause는 admin 전용
- JS 클라이언트 패키지는 `@anchor-lang/core` (Anchor 0.32부터 @coral-xyz/anchor 대체)
- 주의: 현재 deploy/admin/venue authority가 모두 개발 지갑 하나임 — staging 전 분리 필요

### 정산 흐름 (Phase 2.4~2.6 — 동작 확인됨)

```text
POST /payouts {allocationId}          # PAYABLE batch + active default wallet 필요
→ paymentId = allocation id (멱등)     # Payout CREATED, allocation PENDING
GET /payouts/:id/transaction          # backend가 UNSIGNED settle_payout tx 생성 (INITIATED)
→ venue wallet이 서명 (브라우저)        # backend는 vault key 미보유 (§29.4)
POST /payouts/:id/submit              # raw tx 제출 → SUBMITTED + solana-confirmation job
→ worker: PayoutSettled ws 이벤트      # → CONFIRMED (빠른 신호)
→ worker: confirmation job            # finalized 확인 + SettlementRecord PDA 검증
→ FINALIZED + slot/blockTime          # allocation PAID, batch PARTIALLY_PAID/PAID 롤업
```

실패 처리(§29.7): 재시도 전 항상 SettlementRecord PDA 선조회 — "HTTP 재시도 ≠ USDC 재전송".
`payout-reconcile`가 60초마다 stale payout을 정합화. legacy rail은 `POST /payouts/legacy-evidence`로 venue-attested FINALIZED.

## 11. 남은 주요 작업 (Phase 6)

- Playwright 브라우저 E2E로 데모 시나리오 24단계 자동화
- Vercel/Railway staging 배포와 배포 후 smoke test
- PDF를 S3 호환 private object storage로 이전
- Sentry, structured logging, dependency health/worker heartbeat 보강
