# ServeProof

ServeProof는 팁 기반 노동자의 소득이 어떻게 발생하고, 배분되고, 지급되었는지를 검증 가능한 기록으로 만드는 데모 애플리케이션입니다. POS·근무기록에서 팁과 Timecard를 수집하고, 사업장 정책으로 배분한 뒤, 기존 급여 경로 또는 Solana Devnet의 테스트 USDC로 정산합니다. 노동자는 소득 기록 중 필요한 범위만 PDF와 QR 링크로 공유할 수 있습니다.

> 이 저장소는 캡스톤/MVP 데모용입니다. Solana Devnet의 `tUSDC`는 실제 가치가 없으며, 현재 이메일 발송과 영구 PDF object storage는 운영 수준으로 연결되어 있지 않습니다.

## 현재 구현 상태

> 코드·CI·테스트 기준 최종 점검: 2026-08-07

- Phase 1~4: CSV 기반 도메인 흐름, Devnet 정산, 소득 관측, 선택 공개 기능 구현 완료
- Phase 5: Square OAuth·암호화 token 저장·evidence sync·provider health 구현 및 단위 테스트 완료
- Phase 5 acceptance: Sandbox API 200 응답은 확인했지만 fixture가 0건이어서 실제 OAuth callback과 tip·Timecard 수집 검증은 남아 있음
- Phase 6: 로컬 데모 자동화와 핵심 Supertest 시나리오는 완료, Playwright 24단계와 staging 배포는 미완료

다음 작업 순서는 **Square Sandbox fixture/live sync 검증 → Playwright 24단계 → staging 배포와 smoke test**입니다. 세부 체크리스트는 [구현 계획](IMPLEMENTATION_PLAN.md), 파일별 책임은 [코드베이스 맵](ARCHITECTURE.md)을 기준으로 합니다.

## 주요 기능

- 이메일 OTP 로그인, JWT access token, refresh token rotation 및 재사용 차단
- 조직·사업장 단위 OWNER/MANAGER/PAYROLL_ADMIN/VIEWER RBAC와 tenant isolation
- CSV 및 Square Sandbox의 Payment, Order, Timecard, 현금 팁 수집
- 외부 직원 ID 매핑, source hash 기반 멱등 evidence 저장
- 시간·역할 가중 팁 배분, 정책 버전 관리, 검토 및 승인 상태 머신
- Payroll/legacy 지급 증빙과 Solana Devnet tUSDC 정산
- 소득 ledger, payroll 관측, discrepancy 및 correction 기록
- 선택 공개 PDF·QR, 만료·철회·정정 상태가 반영되는 공개 검증 페이지
- BullMQ 기반 provider sync, Solana confirmation/reconciliation, report expiry 작업

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

`APP_ENV=local`에서는 OTP 요청 응답과 로그인 화면에 개발용 코드가 표시됩니다. `manager@demo.serveproof.local`로 로그인하면 사업장 대시보드로 이동합니다.

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

이 mint는 데모용 `tUSDC`이며 금전적 가치가 없습니다. Devnet 상태는 [onchain/devnet-state.json](onchain/devnet-state.json)에 기록되어 있습니다. 프로그램을 직접 빌드·테스트·재배포하려면 `onchain/`을 별도 workspace처럼 설치하고 Anchor/Solana CLI wallet을 준비해야 합니다.

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

권장 데모 구성은 다음과 같습니다.

```text
Vercel:  apps/web
Railway: apps/api + apps/worker + PostgreSQL + Redis
Solana:  기존 Devnet 프로그램과 tUSDC
```

### 1. Railway 프로젝트

Railway에 Git 저장소를 연결하고 PostgreSQL과 Redis를 추가한 뒤, 같은 저장소에서 `serveproof-api`와 `serveproof-worker` 서비스를 만듭니다. shared workspace package가 있으므로 두 서비스 모두 repository root `/`를 사용합니다.

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
APP_ENV=local
DATABASE_URL=<Railway PostgreSQL reference>
REDIS_URL=<Railway Redis reference>
AUTH_SECRET=<strong random secret>
REPORT_SIGNING_KEY=<different strong random secret>
PROVIDER_ENCRYPTION_KEY=<different strong random secret>
WEB_ORIGIN=https://<vercel-domain>

SOLANA_NETWORK=devnet
SOLANA_RPC_URL=<Devnet RPC URL>
SERVEPROOF_PROGRAM_ID=A2snJHtFRK8wKawieDTQy6wMReJCP3BxU6i6y9aECJhi
USDC_MINT=4R3s4BJLvBMKKgWFxsxPTCnZDuDK9dB46WJKPeaJMrDF

SQUARE_ENVIRONMENT=sandbox
SQUARE_APP_ID=...
SQUARE_APP_SECRET=...
SQUARE_ACCESS_TOKEN=...
SQUARE_REDIRECT_URI=https://<railway-api-domain>/providers/square/callback
```

Railway가 런타임 `PORT`를 자동 주입하므로 배포 환경에 `API_PORT`를 별도로 고정하지 않습니다. API는 `PORT`를 우선 사용하고, 로컬에서만 `API_PORT=3001`을 사용합니다.

`APP_ENV=local`은 이메일 provider 없이 OTP를 화면에 표시하기 위한 **임시 공개 데모 설정**입니다. OTP가 API 응답에 포함되므로 접근 기간과 대상을 제한하세요. 실제 staging/production에서는 이메일 provider를 구현한 뒤 `APP_ENV=staging` 또는 `production`으로 바꿔야 합니다.

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

`NEXT_PUBLIC_API_URL`은 client bundle에 build-time으로 들어가므로 API 도메인을 바꾼 뒤에는 Web을 다시 배포해야 합니다. Vercel 배포가 끝나면 실제 도메인을 Railway의 `WEB_ORIGIN`에 넣고 API를 재배포합니다.

### 3. 배포 확인

```bash
curl https://<railway-api-domain>/health
```

그다음 다음 순서로 smoke test를 수행합니다.

1. Web에서 demo manager OTP 로그인
2. CSV import → worker mapping → allocation 계산 → 승인
3. API에서 Square OAuth 연결 및 provider health 확인
4. Worker log에서 `provider-sync` 소비 확인
5. legacy payout 또는 Devnet tUSDC 정산
6. worker income 화면과 discrepancy 확인
7. disclosure report 발급 → QR 공개 검증 → 철회 확인

### 데모 배포 제한

- PDF는 현재 API container의 `var/reports`에 저장됩니다. Railway 재배포/재시작 후 사라질 수 있으므로 영구 데모에는 S3 호환 private bucket 구현이 필요합니다.
- 이메일 OTP provider가 아직 없어 공개 데모에서는 `APP_ENV=local`에 의존합니다.
- API와 worker의 structured logging/Sentry 및 완전한 dependency health endpoint는 Phase 6 작업입니다.
- Devnet RPC rate limit을 피하려면 전용 RPC를 권장합니다.
- Devnet authority와 tUSDC는 실제 자산용 보안 구성이 아닙니다.

## 보안 원칙

- `.env`, provider token, OTP, refresh token, wallet private key를 커밋하거나 로그에 남기지 않습니다.
- Square token은 DB에 AES-256-GCM ciphertext로만 저장합니다.
- backend는 venue wallet private key를 보관하지 않고 unsigned transaction만 생성합니다.
- 모든 venue-scoped API는 JWT 인증 후 organization membership과 role을 검사합니다.
- 승인된 배분과 지급 원본을 삭제하거나 덮어쓰지 않습니다.
- 운영 배포 전 `APP_ENV=local`을 반드시 제거하고 외부 secret manager와 private object storage를 사용합니다.

## 라이선스

현재 저장소에는 별도 루트 라이선스가 정의되어 있지 않습니다. 외부 배포나 재사용 전에 프로젝트 소유자와 사용 조건을 확인하세요.
