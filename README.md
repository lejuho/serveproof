# ServeProof

[한국어](README.md) | [English](README.en.md)

ServeProof는 팁 기반 노동자의 소득이 어떻게 발생하고, 배분되고, 지급되었는지를 검증 가능한 기록으로 만드는 데모 애플리케이션입니다. POS·근무기록에서 팁과 Timecard를 수집하고, 사업장 정책으로 배분한 뒤, 기존 급여 경로 또는 Solana Devnet의 테스트 USDC로 정산합니다. 노동자는 소득 기록 중 필요한 범위만 PDF와 QR 링크로 공유할 수 있습니다.

> 이 저장소는 캡스톤/MVP 데모용입니다. Solana Devnet의 `tUSDC`는 실제 가치가 없으며, 현재 이메일 발송과 영구 PDF object storage는 운영 수준으로 연결되어 있지 않습니다.

## 현재 구현 상태

> 코드·CI·테스트·배포 기준 최종 점검: 2026-08-09

- Phase 1~4: CSV 기반 도메인 흐름, Devnet 정산, 소득 관측, 선택 공개 기능 구현 완료
- Phase 5: Square OAuth·암호화 token 저장·evidence sync·provider health 및 live acceptance 완료
- Phase 6: 로컬 데모·Supertest·Playwright 완료, Vercel/Railway/Supabase/Upstash 데모 인프라 배포
- 배포 후 남은 작업: staging seed, Worker queue 운영 확인, smoke test, private object storage와 dependency health

다음 작업 순서는 **staging seed → Worker 운영 확인 → 배포 smoke test → storage/운영 보강**입니다. 세부 체크리스트는 [구현 계획](IMPLEMENTATION_PLAN.md), 파일별 책임은 [코드베이스 맵](ARCHITECTURE.md)을 기준으로 합니다.

## 주요 기능

- 이메일 OTP 로그인, 자동 세션 복원, 서버 로그아웃, JWT access token과 refresh token rotation 및 재사용 차단
- 한 계정에서 노동자 화면과 사업장 관리 화면을 함께 사용하며, 탭별 화면 모드와 저장된 복수 계정 전환 지원
- 조직·사업장 단위 OWNER/MANAGER/PAYROLL_ADMIN/VIEWER RBAC와 tenant isolation
- CSV 및 Square Sandbox의 Payment, Order, Timecard, 현금 팁 수집
- 연결된 사업장·노동자 네트워크에서 오픈 시프트 등록, 초대·수락, 출퇴근, 근무 승인
- 승인된 staffing 근무를 `ShiftEvidence`로 전환해 기존 팁 배분·지급·소득원장 흐름과 연결
- USDC 온체인 `FINALIZED` 또는 Legacy 지급 등록 직후 IncomeEntry와 지급 불일치 알림 자동 재계산
- 외부 직원 ID 매핑, source hash 기반 멱등 evidence 저장
- 시간·역할 가중 팁 배분, 정책 버전 관리, 검토 및 승인 상태 머신
- Payroll/legacy 지급 증빙과 Solana Devnet tUSDC 정산
- CSV의 정산 경로를 배분 계획에 보존하고, 현금·급여·USDC별 마감 상태와 급여 CSV 내보내기 제공
- Devnet vault tUSDC·필요액·부족/여유·RPC 확인 시각·signer SOL 잔고를 한 화면에서 조회
- 소득 ledger, payroll 관측, discrepancy 및 correction 기록
- 급여/원천징수 기록과 아직 연결되지 않은 금액을 보여주는 보수적인 세금 준비 알림(Devnet 자산 제외)
- 선택 공개 PDF·QR, 만료·철회·정정 상태가 반영되는 공개 검증 페이지
- 소득증명 공유 시 지정 수신자 이메일 OTP(기본) 또는 공개 링크 모드, 이메일 재확인, 마스킹된 열람 이력 제공
- BullMQ 기반 provider sync, Solana confirmation/reconciliation, report expiry 작업

Staffing 기능은 현재 연결이 확인된 노동자만 참여하는 폐쇄형 인력 풀입니다. 공개 구인 마켓플레이스, 자동 근로자 분류, background check, 보험 및 고용대행 기능은 포함하지 않습니다. 화면에 표시되는 시급과 예상 팁은 모집 조건이며, 실제 소득은 승인된 근무 및 정산 자료를 통해 확정됩니다.

화면은 사업장의 `인력 운영 / 정산·소득`, 노동자의 `근무 / 소득·증명` 작업공간으로 분리됩니다. 선택한 사업장과 계정 맥락은 유지되며, 근무 승인 뒤 배분·소득원장으로 이어지는 이동 버튼을 제공합니다.

노동자 화면의 첫 로드는 `계정·소득 요약·알림·최근 소득 25건`을 overview API로 가져옵니다. 세금·증빙 이력은 첫 화면 뒤에, 사업장 연결과 시프트는 `근무` 탭을 열 때 조회합니다. 소득 타임라인은 커서 페이지네이션으로 이전 25건씩 추가합니다.

인증된 화면의 GET 응답은 사용자 ID가 포함된 React Query 메모리 캐시로 중복 요청을 줄입니다. 조직·사업장 목록은 5분, overview·연결은 30초, 오늘 할 일은 10초, 정산 요약은 5초 동안 fresh로 취급합니다. 승인·지급·재계산·직원 연결 같은 변경 직후에는 관련 키를 즉시 무효화하며, 지급 상태 폴링과 서버/CDN 공유 캐시는 사용하지 않습니다.

소득증명은 새 발급부터 `지정 이메일 OTP`가 기본입니다. 수신자는 5분 유효 OTP를 통과해야 하며 인증 세션은 최대 15분 유지됩니다. 사용자가 명시적으로 선택하면 로그인 없는 공개 링크도 만들 수 있습니다. 만료·철회·정정된 링크는 보고서 메타데이터만 반환하고 소득 snapshot은 반환하지 않습니다. 기존 발급 링크는 호환성을 위해 공개 링크 모드로 유지됩니다.

상세 요구사항과 현재 진행 상태는 [구현 명세](ServeProof_MVP_Implementation_Spec_v2.md), [구현 계획](IMPLEMENTATION_PLAN.md), [아키텍처 문서](ARCHITECTURE.md)를 참고하세요.

## 시스템 구조

```text
Browser
  └─ apps/web (Next.js, :3000)
       ├─ REST/JSON ────────────────┐
       └─ venue wallet signature    │
                                    ▼
External providers ────────► apps/api (NestJS, :3001)
  Square / CSV                    ├─ PostgreSQL / Prisma
                                  ├─ Redis / BullMQ producer
                                  └─ unsigned Solana transaction
                                             │
                                             ▼
                                  apps/worker (BullMQ consumer)
                                    ├─ Square periodic sync
                                    ├─ Solana confirmation/reconcile
                                    └─ disclosure expiry
                                             │
                                             ▼
                                  Solana Devnet Anchor program
```

이 저장소는 pnpm workspace monorepo입니다.

```text
serveproof/
├─ apps/
│  ├─ web/          # Next.js 사용자·사업장·공개 검증 UI
│  ├─ api/          # NestJS REST API, 인증/인가 및 도메인 서비스
│  └─ worker/       # BullMQ 백그라운드 작업
├─ packages/
│  ├─ shared/       # 배분 엔진, 금액 변환, enum, CSV 스키마, queue 이름
│  ├─ db/           # Prisma schema, migration, seed, PrismaClient
│  ├─ providers/    # EvidenceProvider 인터페이스, Square client, token 암호화
│  └─ solana/       # Anchor IDL client, PDA 파생, unsigned transaction builder
├─ onchain/         # Anchor 프로그램, 테스트, Devnet 초기화/스모크 스크립트
├─ scripts/         # 로컬 데모 setup/start/stop 및 포트 사전 검사
├─ fixtures/csv/    # 데모용 팁·시프트 CSV
├─ var/reports/     # 로컬 생성 PDF; gitignore 대상
├─ docker-compose.yml
└─ .github/workflows/ci.yml
```

의존성 방향은 `apps → packages`입니다. USD는 DB/API 내부에서 정수 센트로, USDC는 6-decimal base unit으로 다룹니다. 승인된 배분과 소득 원본은 수정하지 않고 correction record를 추가합니다.

## 기술 스택

| 영역       | 기술                                                 |
| ---------- | ---------------------------------------------------- |
| Web        | Next.js 15, React 19, Tailwind CSS                   |
| API/Worker | NestJS 11, Zod, BullMQ                               |
| Data       | PostgreSQL 16, Prisma 6, Redis 7                     |
| Provider   | Square OAuth/Payments/Orders/Labor API, CSV fallback |
| On-chain   | Solana, Anchor 0.32, SPL Token                       |
| Test/CI    | node:test, Jest, Supertest, GitHub Actions, gitleaks |

## 로컬 실행

### 빠른 데모 실행

최초 한 번만 setup을 실행한 뒤 API·Worker·Web을 한 명령으로 시작할 수 있습니다.

```bash
cd /home/user/serveproof
pnpm demo:setup
pnpm demo:start
```

`demo:setup`은 다음 작업을 순서대로 수행합니다.

- `.env`가 없으면 `.env.example`에서 생성
- 비어 있는 `AUTH_SECRET`, `REPORT_SIGNING_KEY`, `PROVIDER_ENCRYPTION_KEY` 생성
- workspace 의존성 설치
- PostgreSQL·Redis 기동 및 readiness 대기
- Prisma migration 적용과 멱등 demo seed 실행

`demo:start`는 API, worker, web을 함께 실행합니다. `Ctrl+C`는 애플리케이션 프로세스를 함께 종료하지만 PostgreSQL과 Redis는 다음 실행을 위해 유지합니다. 컨테이너도 중지하려면 실행하세요.

시작 전에 Web `3000`과 API `API_PORT`(기본 `3001`)가 비어 있는지 검사합니다. Web 포트는 `3000`으로 고정하므로 다른 프로세스 때문에 Next.js가 API 포트로 자동 이동하지 않습니다.

```bash
pnpm demo:stop
```

기존 `.env` 값과 PostgreSQL volume은 세 명령 모두 덮어쓰거나 삭제하지 않습니다.

### 1. 준비물

- Node.js 22 이상
- pnpm 10.33.x
- Docker 및 Docker Compose
- 선택 사항: Solana CLI, Anchor CLI, 브라우저 Solana 지갑
- 선택 사항: Square Developer Sandbox 앱

### 2. 설치 및 환경변수

```bash
pnpm install
cp .env.example .env
```

`.env`에서 최소 다음 값을 설정합니다.

```dotenv
NODE_ENV=development
APP_ENV=local
DATABASE_URL=postgresql://serveproof:serveproof@localhost:5433/serveproof
REDIS_URL=redis://localhost:6379

AUTH_SECRET=<openssl rand -hex 32 결과>
REPORT_SIGNING_KEY=<openssl rand -hex 32 결과>
PROVIDER_ENCRYPTION_KEY=<openssl rand -hex 32 결과>

WEB_ORIGIN=http://localhost:3000
API_PORT=3001
```

각 비밀값은 별도로 생성합니다.

```bash
openssl rand -hex 32
```

`PROVIDER_ENCRYPTION_KEY`가 없으면 개발 편의를 위해 `AUTH_SECRET`을 provider token 암호화 키의 입력으로 사용하지만, 공유 환경에서는 반드시 별도 값을 설정하세요. `.env`는 커밋하지 않습니다.

### 3. PostgreSQL·Redis와 DB 준비

```bash
docker compose up -d postgres redis
pnpm db:migrate
pnpm --filter @serveproof/db seed
```

로컬 PostgreSQL은 다른 기본 인스턴스와 충돌하지 않도록 `5433` 포트를 사용합니다. seed는 멱등이며 다음 데모 데이터를 만듭니다.

- 조직: `ServeProof Demo`
- 사업장: `Demo Diner`
- 관리자: `manager@demo.serveproof.local`
- 노동자: Worker A/B/C
- 역할 가중 배분 정책 v1

### 4. 애플리케이션 기동

세 터미널에서 각각 실행합니다.

```bash
pnpm dev:api
```

```bash
pnpm dev:worker
```

```bash
pnpm dev:web
```

접속 주소:

- Web: `http://localhost:3000`
- API: `http://localhost:3001`
- Health: `http://localhost:3001/health`

`APP_ENV=local`에서는 OTP 요청 응답과 로그인 화면에 개발용 코드가 표시됩니다. `manager@demo.serveproof.local`로 로그인하면 기본적으로 사업장 대시보드로 이동합니다. 이 계정은 노동자 자격과 `Demo Diner`의 OWNER 멤버십을 함께 가지므로 상단의 `노동자로 보기`와 `사업장 관리자로 보기`를 사용해 두 화면을 전환할 수 있습니다. 화면 모드는 탭별로 저장되므로 한 탭에는 사업장 대시보드, 다른 탭에는 노동자 화면을 동시에 열어둘 수 있습니다.

### 5. CSV 데모

1. 대시보드에서 `Demo Diner`를 선택합니다.
2. [데모 CSV](fixtures/csv/demo_tips_shifts.csv)의 내용을 CSV Import 영역에 붙여 넣습니다.
3. Worker C의 대기 중 매핑을 확정합니다.
4. business date를 `2026-08-05`로 지정해 배분을 계산합니다.
5. 계산 결과를 승인합니다.
6. 각 allocation에 payroll reference를 등록하거나 Devnet tUSDC 지급을 진행합니다.
7. IncomeEntry를 재계산하고 노동자 화면에서 ledger와 discrepancy를 확인합니다.
8. 노동자 화면에서 공개 범위를 선택해 PDF·QR report를 발급하고 `/verify/:token`을 확인합니다.

USDC 경로는 사업장에 등록된 `payoutSignerWallet`과 노동자의 활성 기본 지갑이 필요합니다. 브라우저 지갑이 unsigned transaction에 서명하며 API는 private key를 보관하지 않습니다.

## Square Sandbox 연결

Square 앱의 Sandbox OAuth Redirect URL을 다음 값과 정확히 일치시키세요.

```text
http://localhost:3001/providers/square/callback
```

`.env` 설정:

```dotenv
SQUARE_ENVIRONMENT=sandbox
SQUARE_APP_ID=...
SQUARE_APP_SECRET=...
SQUARE_ACCESS_TOKEN=...
SQUARE_REDIRECT_URI=http://localhost:3001/providers/square/callback
PROVIDER_ENCRYPTION_KEY=...
```

연결 흐름:

1. OWNER 또는 MANAGER access token으로 `POST /providers/square/connect`에 `{ "venueId": "..." }`를 보냅니다.
2. 응답의 `authorizationUrl`을 브라우저에서 열고 Sandbox seller 권한을 승인합니다.
3. callback이 access/refresh token을 암호화하여 `ProviderConnection`에 저장합니다.
4. Sandbox에서 Payment와 Timecard fixture를 만든 뒤 기간을 지정해 동기화를 요청합니다.

```http
POST /evidence/sync
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "venueId": "<venue-uuid>",
  "provider": "square",
  "startDate": "2026-08-05",
  "endDate": "2026-08-05"
}
```

API는 BullMQ job ID를 즉시 반환합니다. worker가 Payment의 `tip_money`, Order의 `total_tip_money` fallback, Timecard와 `declared_cash_tip_money`, 환불·취소 상태를 기존 `TipEvidence`/`ShiftEvidence` 파이프라인에 저장합니다.

상태 확인:

```http
GET /providers/square/health?venueId=<venue-uuid>
Authorization: Bearer <access-token>
```

## Solana Devnet

현재 저장소가 참조하는 데모 프로그램과 테스트 mint:

```dotenv
SOLANA_NETWORK=devnet
SOLANA_RPC_URL=https://api.devnet.solana.com
SERVEPROOF_PROGRAM_ID=A2snJHtFRK8wKawieDTQy6wMReJCP3BxU6i6y9aECJhi
USDC_MINT=4R3s4BJLvBMKKgWFxsxPTCnZDuDK9dB46WJKPeaJMrDF
```

이 mint는 데모용 `tUSDC`이며 금전적 가치가 없습니다. Devnet 상태는 venue별로 `onchain/state/devnet-demo.json`과 `onchain/state/devnet-smoke.json`에 분리해 기록합니다. 프로그램을 직접 빌드·테스트·재배포하려면 `onchain/`을 별도 workspace처럼 설치하고 Anchor/Solana CLI wallet을 준비해야 합니다.

```bash
cd onchain
pnpm install
anchor build
anchor test
```

새 프로그램을 배포하면 `declare_id!`, `Anchor.toml`, IDL, 환경변수의 Program ID를 함께 갱신해야 합니다.

## 테스트와 품질 검사

최근 확인 결과(2026-08-06): shared 단위 테스트 11/11, Square provider 단위 테스트 3/3,
API Supertest 3/3, 전체 workspace typecheck 7개·build·lint 통과. Anchor local validator는 Phase 2에서
14/14 통과했습니다.

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

API 통합 테스트는 전용 `serveproof_test` PostgreSQL DB와 Redis DB 15를 사용합니다. 로컬에서 실행하려면 test DB를 먼저 생성하고 migration을 적용하세요.

```bash
docker compose exec postgres createdb -U serveproof serveproof_test
DATABASE_URL=postgresql://serveproof:serveproof@localhost:5433/serveproof_test \
  pnpm --filter @serveproof/db migrate:deploy
pnpm test
```

CI는 PostgreSQL·Redis service container를 기동한 뒤 migration, lint, build, typecheck, 단위/API 통합 테스트와 secret scan을 수행합니다. Anchor build/test job은 아직 CI에 포함되지 않습니다.

## 데모 배포

### 현재 배포 현황 (2026-08-09)

| 구성 요소   | 플랫폼                       | 주소/연결                                                                                   | 상태                          |
| ----------- | ---------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------- |
| Web         | Vercel                       | [serveproof-web.vercel.app](https://serveproof-web.vercel.app/)                             | 공개, HTTP 200 확인           |
| API         | Railway                      | [serveproofapi-production.up.railway.app](https://serveproofapi-production.up.railway.app/) | 공개, `/health` HTTP 200 확인 |
| Worker      | Railway                      | public domain 없음                                                                          | 내부 BullMQ consumer          |
| PostgreSQL  | Supabase                     | `DATABASE_URL`로 API/Worker 연결                                                            | staging DB                    |
| Redis       | Railway Redis                | internal `REDIS_URL` + `?family=0`으로 API/Worker 연결                                      | BullMQ/OTP/OAuth state        |
| OTP Email   | Brevo (HTTPS API)            | `BREVO_API_KEY` (Railway는 Pro 미만 SMTP 차단)                                              | 실발송 검증 완료              |
| Blockchain  | Solana Devnet                | 기존 Anchor program + tUSDC                                                                 | Devnet 전용                   |
| PDF Storage | Railway API local filesystem | `var/reports`                                                                               | 영구 storage 이전 필요        |

현재 배포 토폴로지:

```text
Vercel Web ──HTTPS──→ Railway API ──→ Supabase PostgreSQL
                          │          ├─→ Railway Redis/BullMQ
                          │          └─→ Brevo (OTP email, HTTPS)
Railway Worker (internal) ┘─────────→ Solana Devnet / Square Sandbox
```

### 1. Railway 프로젝트

Railway에 같은 Git 저장소를 연결해 `serveproof-api`, `serveproof-worker`, Redis 서비스를 운용합니다. DB는 Supabase를 사용합니다. (Upstash free tier는 BullMQ 폴링이 500K command 한도를 소진해 Railway Redis로 교체했습니다.) shared workspace package가 있으므로 두 서비스 모두 repository root `/`를 사용합니다.

API 서비스:

```text
Build Command:      pnpm --filter @serveproof/api... build
Pre-deploy Command: pnpm --filter @serveproof/db migrate:deploy
Start Command:      pnpm --filter @serveproof/api start:api
Healthcheck Path:   /health
```

Worker 서비스:

```text
Build Command: pnpm --filter @serveproof/worker... build
Start Command: pnpm --filter @serveproof/worker start:worker
```

Migration은 API 서비스의 pre-deploy에서만 실행해 API와 worker가 동시에 migration을 시도하지 않게 합니다. Railway의 pre-deploy command는 build 이후, 새 프로세스 시작 전에 실행되며 실패하면 배포가 중단됩니다.

두 서비스에 같은 backend 환경변수를 설정합니다. Railway reference variable을 사용해 PostgreSQL `DATABASE_URL`과 Redis `REDIS_URL`을 연결하세요.

```dotenv
NODE_ENV=production
APP_ENV=staging
DATABASE_URL=<Supabase PostgreSQL session-pooler URI>
REDIS_URL=${{Redis.REDIS_URL}}?family=0   # Railway internal DNS는 IPv6 전용
AUTH_SECRET=<strong random secret>
BREVO_API_KEY=<Brevo API key (xkeysib-…)>  # API 서비스만 필요
EMAIL_FROM=<Brevo에서 인증한 발신자 이메일>
OTP_DEVCODE_DOMAINS=demo.serveproof.local,staging.serveproof.local
REPORT_SIGNING_KEY=<different strong random secret>
PROVIDER_ENCRYPTION_KEY=<different strong random secret>
WEB_ORIGIN=https://serveproof-web.vercel.app

SOLANA_NETWORK=devnet
SOLANA_RPC_URL=<Devnet RPC URL>
SERVEPROOF_PROGRAM_ID=A2snJHtFRK8wKawieDTQy6wMReJCP3BxU6i6y9aECJhi
USDC_MINT=4R3s4BJLvBMKKgWFxsxPTCnZDuDK9dB46WJKPeaJMrDF

SQUARE_ENVIRONMENT=sandbox
SQUARE_APP_ID=...
SQUARE_APP_SECRET=...
SQUARE_ACCESS_TOKEN=...
SQUARE_REDIRECT_URI=https://serveproofapi-production.up.railway.app/providers/square/callback

# Optional low-volume performance thresholds (defaults shown)
PERFORMANCE_LOGGING_ENABLED=true
API_SLOW_REQUEST_MS=750
PRISMA_SLOW_QUERY_MS=200
```

Railway가 런타임 `PORT`를 자동 주입하므로 배포 환경에 `API_PORT`를 별도로 고정하지 않습니다. API는 `PORT`를 우선 사용하고, 로컬에서만 `API_PORT=3001`을 사용합니다.

성능 로그는 모든 요청과 SQL을 출력하지 않습니다. API는 임계값을 넘긴 요청만 `slow_api_request` 한 줄로 기록하고, Prisma는 200ms 이상인 쿼리만 `slow_db_query`로 기록합니다. SQL 파라미터·이메일·토큰은 기록하지 않으며 쿼리는 동작과 테이블 이름만 남깁니다. `dbDurationSumMs`는 한 요청에 포함된 쿼리 시간의 합계라 병렬 쿼리가 있으면 `totalMs`보다 클 수 있습니다. Prisma 연결 풀 타임아웃 `P2024`는 `db_pool_timeout`으로 구분됩니다. 계측 자체를 끄려면 `PERFORMANCE_LOGGING_ENABLED=false`로 설정합니다.

느린 쿼리가 반복될 때만 Supabase SQL Editor에서 [`scripts/pg-stat-statements.sql`](scripts/pg-stat-statements.sql)을 수동 실행해 누적 실행시간 상위 쿼리를 확인합니다. 애플리케이션과 migration은 이 진단 SQL을 자동 실행하지 않습니다.

OTP 이메일은 Brevo HTTPS API로 발송합니다 (Railway는 Pro 플랜 미만에서 아웃바운드 SMTP 25/465/587을 차단하므로 SMTP는 로컬/Pro 전용 폴백입니다). `OTP_DEVCODE_DOMAINS`에 등록된 도메인의 이메일과 `APP_ENV=local` 환경에서만 응답에 `devCode`가 포함되어 데모/E2E 계정은 원클릭 로그인이 유지됩니다. 그 외 주소는 실제 이메일로만 코드를 받습니다.

API가 처음 정상 기동된 뒤 Railway one-off shell에서 seed를 한 번 실행합니다.

```bash
pnpm --filter @serveproof/db seed
```

Square Developer Console의 Sandbox Redirect URL도 Railway API callback URL로 변경합니다.

### 2. Vercel Web 프로젝트

같은 저장소를 새 Vercel 프로젝트로 가져옵니다.

```text
Framework Preset: Next.js
Root Directory:   apps/web
Build Command:    pnpm --filter @serveproof/web... build
Output Directory: .next (framework default)
Node.js:          22
```

Root Directory 밖의 workspace package를 읽을 수 있도록 `Include source files outside of the Root Directory`를 활성화합니다. pnpm 버전은 루트 `packageManager`와 lockfile에서 감지됩니다.

Vercel 환경변수:

```dotenv
NEXT_PUBLIC_API_URL=https://<railway-api-domain>
```

현재 production environment 값:

```dotenv
NEXT_PUBLIC_API_URL=https://serveproofapi-production.up.railway.app
```

`NEXT_PUBLIC_API_URL`은 client bundle에 build-time으로 들어가므로 API 도메인을 바꾼 뒤에는 Web을 다시 배포해야 합니다. Vercel 배포가 끝나면 실제 도메인을 Railway의 `WEB_ORIGIN`에 넣고 API를 재배포합니다.

### 3. 배포 확인

```bash
curl https://serveproofapi-production.up.railway.app/health
```

그다음 다음 순서로 smoke test를 수행합니다.

1. Web에서 demo manager OTP 로그인
2. CSV import → 사업장이 계정 연결 요청 → 노동자가 근무 탭에서 수락 → allocation 계산 → 승인
3. API에서 Square OAuth 연결 및 provider health 확인
4. Worker log에서 `provider-sync` 소비 확인
5. legacy payout 또는 Devnet tUSDC 정산
6. worker income 화면과 discrepancy 확인
7. disclosure report 발급 → QR 공개 검증 → 철회 확인

### 데모 배포 제한

- PDF는 현재 API container의 `var/reports`에 저장됩니다. Railway 재배포/재시작 후 사라질 수 있으므로 영구 데모에는 S3 호환 private bucket 구현이 필요합니다.
- 이메일 OTP는 Brevo 무료 tier(일 300통)로 발송합니다. 발신자가 gmail.com 주소라 일부 수신함에서 스팸 분류될 수 있으며, 도메인 확보 후 Brevo 도메인 인증을 추가하면 해결됩니다.
- API와 worker의 structured logging/Sentry 및 완전한 dependency health endpoint는 Phase 6 작업입니다.
- Devnet RPC rate limit을 피하려면 전용 RPC를 권장합니다.
- Devnet authority와 tUSDC는 실제 자산용 보안 구성이 아닙니다.

## 보안 원칙

- `.env`, provider token, OTP, refresh token, wallet private key를 커밋하거나 로그에 남기지 않습니다.
- Square token은 DB에 AES-256-GCM ciphertext로만 저장합니다.
- backend는 venue wallet private key를 보관하지 않고 unsigned transaction만 생성합니다.
- 계정은 한 사람의 신원을 나타냅니다. 노동자 자격과 organization membership은 서로 배타적인 전역 역할로 취급하지 않습니다.
- 모든 venue-scoped API는 JWT 인증 후 organization membership과 organization role을 검사합니다.
- 승인된 배분과 지급 원본을 삭제하거나 덮어쓰지 않습니다.
- 운영 배포 전 `APP_ENV=local`을 반드시 제거하고 외부 secret manager와 private object storage를 사용합니다.

## 라이선스

현재 저장소에는 별도 루트 라이선스가 정의되어 있지 않습니다. 외부 배포나 재사용 전에 프로젝트 소유자와 사용 조건을 확인하세요.
