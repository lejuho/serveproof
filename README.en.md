# ServeProof

[한국어](README.md) | [English](README.en.md)

ServeProof is a demo application that turns how tip-based workers earn, receive allocations, and get paid into verifiable records. It collects tips and timecards from POS and workforce systems, allocates them according to venue policy, and settles them through an existing payroll route or test USDC on Solana Devnet. Workers can selectively share only the income records they need through PDF reports and QR links.

> This repository is a capstone/MVP demo. `tUSDC` on Solana Devnet has no monetary value, and email delivery and persistent PDF object storage are not yet connected at production quality.

## Implementation status

> Last code, CI, test, and deployment review: August 9, 2026

- Phases 1–4: CSV-based domain flow, Devnet settlement, income observation, and selective disclosure are complete.
- Phase 5: Square OAuth, encrypted token storage, evidence sync, provider health, and live acceptance are complete.
- Phase 6: Local demo, Supertest, and Playwright are complete; demo infrastructure is deployed on Vercel, Railway, Supabase, and Upstash.
- Remaining post-deployment work: staging seed, Worker queue operations check, smoke test, private object storage, and dependency health.

The next sequence is **staging seed → Worker operations check → deployment smoke test → storage and operational hardening**. See the [implementation plan](IMPLEMENTATION_PLAN.md) for the detailed checklist and the [codebase map](ARCHITECTURE.md) for file-level responsibilities.

## Key features

- Email OTP login, automatic session restoration, server-side logout, JWT access tokens, refresh-token rotation, and reuse prevention
- Worker and venue-management views under one account, with per-tab view modes and switching among multiple saved accounts
- Organization- and venue-level OWNER/MANAGER/PAYROLL_ADMIN/VIEWER RBAC with tenant isolation
- Payment, Order, Timecard, and cash-tip ingestion from CSV and Square Sandbox
- Open-shift creation, invitations, acceptance, clock-in/out, and work approval inside the connected venue-worker network
- Approved staffing attendance converted into `ShiftEvidence` for the existing allocation, payout, and income-ledger workflows
- Automatic IncomeEntry and payout-discrepancy rebuild after on-chain USDC `FINALIZED` or legacy payout registration
- External worker ID mapping and source-hash-based idempotent evidence storage
- Time- and role-weighted tip allocation, policy versioning, review, and approval state machine
- Payroll/legacy payment evidence and Solana Devnet tUSDC settlement
- Settlement-route intent preserved from CSV through allocation planning, with cash/payroll/USDC close lanes and payroll CSV export
- Read-only Devnet treasury status for vault tUSDC, required amount, shortfall/surplus, RPC check time, and signer SOL balance
- Income ledger, payroll observations, discrepancies, and correction records
- Conservative tax-readiness notice for amounts not yet matched to payroll/withholding records, excluding Devnet test assets
- Selective-disclosure PDF and QR reports with expiration, revocation, and correction-aware public verification
- Recipient-email OTP (default) or explicit public-link sharing, recipient confirmation, and masked access history for income proofs
- BullMQ jobs for provider sync, Solana confirmation/reconciliation, and report expiration

Staffing currently operates as a closed labor pool limited to workers with confirmed venue connections. It does not provide a public job marketplace, automated worker classification, background checks, insurance, or employer-of-record services. Displayed hourly rates and expected tips are offer terms; approved attendance and settlement evidence determine recorded income.

The UI separates venue work into `Staffing / Settlement & income` and worker work into `Work / Income & proof`. Venue and account context remain persistent, with explicit handoffs from approved attendance to allocation and the income ledger.

The worker screen initially loads `account, income summary, alerts, and the latest 25 income entries` through one overview API. Tax/proof history loads after the first screen, while venue connections and shifts load only when the `Work` tab opens. The income timeline uses cursor pagination to append 25 older entries at a time.

New income proofs default to `recipient email OTP`. The recipient must pass a five-minute OTP and receives an access session lasting at most 15 minutes. Workers can explicitly opt into an unauthenticated public link. Expired, revoked, or corrected links return report metadata but never the income snapshot. Existing grants remain public-link mode for compatibility.

For detailed requirements and current progress, see the [implementation specification](ServeProof_MVP_Implementation_Spec_v2.md), [implementation plan](IMPLEMENTATION_PLAN.md), and [architecture documentation](ARCHITECTURE.md).

## System architecture

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

This repository is a pnpm workspace monorepo.

```text
serveproof/
├─ apps/
│  ├─ web/          # Next.js worker, venue, and public verification UI
│  ├─ api/          # NestJS REST API, auth, authorization, and domain services
│  └─ worker/       # BullMQ background jobs
├─ packages/
│  ├─ shared/       # Allocation engine, money conversion, enums, CSV schema, queue names
│  ├─ db/           # Prisma schema, migrations, seed, and PrismaClient
│  ├─ providers/    # EvidenceProvider interface, Square client, and token encryption
│  └─ solana/       # Anchor IDL client, PDA derivation, and unsigned transaction builder
├─ onchain/         # Anchor program, tests, and Devnet initialization/smoke scripts
├─ scripts/         # Local demo setup/start/stop and port preflight checks
├─ fixtures/csv/    # Demo tip and shift CSV files
├─ var/reports/     # Locally generated PDFs; gitignored
├─ docker-compose.yml
└─ .github/workflows/ci.yml
```

Dependencies flow from `apps → packages`. USD values are represented as integer cents inside the database and API, while USDC uses 6-decimal base units. Approved allocations and original income records remain immutable; changes are represented as correction records.

## Technology stack

| Area       | Technology                                           |
| ---------- | ---------------------------------------------------- |
| Web        | Next.js 15, React 19, Tailwind CSS                   |
| API/Worker | NestJS 11, Zod, BullMQ                               |
| Data       | PostgreSQL 16, Prisma 6, Redis 7                     |
| Provider   | Square OAuth/Payments/Orders/Labor API, CSV fallback |
| On-chain   | Solana, Anchor 0.32, SPL Token                       |
| Test/CI    | node:test, Jest, Supertest, GitHub Actions, gitleaks |

## Running locally

### Quick demo

Run setup once, then start the API, Worker, and Web application with a single command.

```bash
cd /home/user/serveproof
pnpm demo:setup
pnpm demo:start
```

`demo:setup` performs the following steps in order:

- Creates `.env` from `.env.example` when it does not exist
- Generates empty `AUTH_SECRET`, `REPORT_SIGNING_KEY`, and `PROVIDER_ENCRYPTION_KEY` values
- Installs workspace dependencies
- Starts PostgreSQL and Redis and waits for readiness
- Applies Prisma migrations and runs the idempotent demo seed

`demo:start` runs the API, worker, and web application together. `Ctrl+C` stops the application processes while leaving PostgreSQL and Redis running for the next session. To stop the containers as well, run:

The command checks that Web port `3000` and API `API_PORT` (default `3001`) are available before starting. The Web port is fixed at `3000`, preventing Next.js from silently moving onto the API port when another process is running.

```bash
pnpm demo:stop
```

None of these commands overwrite existing `.env` values or delete the PostgreSQL volume.

### 1. Prerequisites

- Node.js 22 or later
- pnpm 10.33.x
- Docker and Docker Compose
- Optional: Solana CLI, Anchor CLI, and a browser Solana wallet
- Optional: Square Developer Sandbox application

### 2. Installation and environment variables

```bash
pnpm install
cp .env.example .env
```

Configure at least the following values in `.env`:

```dotenv
NODE_ENV=development
APP_ENV=local
DATABASE_URL=postgresql://serveproof:serveproof@localhost:5433/serveproof
REDIS_URL=redis://localhost:6379

AUTH_SECRET=<output of openssl rand -hex 32>
REPORT_SIGNING_KEY=<output of openssl rand -hex 32>
PROVIDER_ENCRYPTION_KEY=<output of openssl rand -hex 32>

WEB_ORIGIN=http://localhost:3000
API_PORT=3001
```

Generate each secret independently:

```bash
openssl rand -hex 32
```

For development convenience, when `PROVIDER_ENCRYPTION_KEY` is absent, `AUTH_SECRET` is used as input for provider-token encryption. Always configure a separate value in shared environments. Never commit `.env`.

### 3. Prepare PostgreSQL, Redis, and the database

```bash
docker compose up -d postgres redis
pnpm db:migrate
pnpm --filter @serveproof/db seed
```

Local PostgreSQL uses port `5433` to avoid conflicts with other default instances. The seed is idempotent and creates:

- Organization: `ServeProof Demo`
- Venue: `Demo Diner`
- Manager: `manager@demo.serveproof.local`
- Workers: Worker A/B/C
- Role-weighted allocation policy v1

### 4. Start the applications

Run each command in a separate terminal:

```bash
pnpm dev:api
```

```bash
pnpm dev:worker
```

```bash
pnpm dev:web
```

Endpoints:

- Web: `http://localhost:3000`
- API: `http://localhost:3001`
- Health: `http://localhost:3001/health`

When `APP_ENV=local`, the OTP response and login screen expose a development code. Signing in as `manager@demo.serveproof.local` opens the venue dashboard by default. This account has both a worker profile and an OWNER membership in `Demo Diner`, so use `Worker view` and `Venue manager view` in the header to switch between the two. The selected view is stored per tab, allowing the venue dashboard and worker screen to remain open at the same time.

### 5. CSV demo

1. Select `Demo Diner` in the dashboard.
2. Paste the contents of the [demo CSV](fixtures/csv/demo_tips_shifts.csv) into the CSV Import area.
3. Have Worker C accept the pending venue connection from the Work tab.
4. Set the business date to `2026-08-05` and calculate the allocation.
5. Approve the calculated result.
6. Record a payroll reference or issue a Devnet tUSDC payment for each allocation.
7. Rebuild IncomeEntry records and inspect the ledger and discrepancies on the worker screen.
8. Select a disclosure scope on the worker screen, issue a PDF/QR report, and open `/verify/:token`.

The USDC route requires a venue `payoutSignerWallet` and an active default wallet for the worker. The browser wallet signs the unsigned transaction; the API never stores private keys.

## Square Sandbox connection

Configure the Square application's Sandbox OAuth Redirect URL to exactly:

```text
http://localhost:3001/providers/square/callback
```

`.env` configuration:

```dotenv
SQUARE_ENVIRONMENT=sandbox
SQUARE_APP_ID=...
SQUARE_APP_SECRET=...
SQUARE_ACCESS_TOKEN=...
SQUARE_REDIRECT_URI=http://localhost:3001/providers/square/callback
PROVIDER_ENCRYPTION_KEY=...
```

Connection flow:

1. Send `{ "venueId": "..." }` to `POST /providers/square/connect` using an OWNER or MANAGER access token.
2. Open the returned `authorizationUrl` and approve the Sandbox seller permissions.
3. The callback encrypts and stores the access and refresh tokens in `ProviderConnection`.
4. Create Payment and Timecard fixtures in Sandbox, then request synchronization for a date range.

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

The API immediately returns a BullMQ job ID. The worker stores Payment `tip_money`, the Order `total_tip_money` fallback, Timecards and `declared_cash_tip_money`, and refund/cancellation states through the existing `TipEvidence`/`ShiftEvidence` pipeline.

Health check:

```http
GET /providers/square/health?venueId=<venue-uuid>
Authorization: Bearer <access-token>
```

## Solana Devnet

Demo program and test mint currently referenced by the repository:

```dotenv
SOLANA_NETWORK=devnet
SOLANA_RPC_URL=https://api.devnet.solana.com
SERVEPROOF_PROGRAM_ID=A2snJHtFRK8wKawieDTQy6wMReJCP3BxU6i6y9aECJhi
USDC_MINT=4R3s4BJLvBMKKgWFxsxPTCnZDuDK9dB46WJKPeaJMrDF
```

This mint is demo `tUSDC` and has no monetary value. Devnet state is recorded in [onchain/devnet-state.json](onchain/devnet-state.json). To build, test, or redeploy the program, install `onchain/` as a separate workspace and configure Anchor/Solana CLI wallet access.

```bash
cd onchain
pnpm install
anchor build
anchor test
```

After deploying a new program, update the Program ID in `declare_id!`, `Anchor.toml`, the IDL, and environment variables together.

## Tests and quality checks

Most recent recorded results (August 6, 2026): 11/11 shared unit tests, 3/3 Square provider unit tests, 3/3 API Supertests, and all seven workspace type checks, build, and lint pass. The Anchor local validator passed 14/14 tests in Phase 2.

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

API integration tests use a dedicated `serveproof_test` PostgreSQL database and Redis database 15. Create the test database and apply migrations before running them locally.

```bash
docker compose exec postgres createdb -U serveproof serveproof_test
DATABASE_URL=postgresql://serveproof:serveproof@localhost:5433/serveproof_test \
  pnpm --filter @serveproof/db migrate:deploy
pnpm test
```

CI starts PostgreSQL and Redis service containers, then runs migrations, lint, build, type checks, unit/API integration tests, and secret scanning. Anchor build/test is not yet part of CI.

## Demo deployment

### Current deployment status (August 9, 2026)

| Component   | Platform                     | Address/connection                                                                          | Status                     |
| ----------- | ---------------------------- | ------------------------------------------------------------------------------------------- | -------------------------- |
| Web         | Vercel                       | [serveproof-web.vercel.app](https://serveproof-web.vercel.app/)                             | Public, HTTP 200 verified  |
| API         | Railway                      | [serveproofapi-production.up.railway.app](https://serveproofapi-production.up.railway.app/) | Public, `/health` HTTP 200 |
| Worker      | Railway                      | No public domain                                                                            | Internal BullMQ consumer   |
| PostgreSQL  | Supabase                     | API/Worker connect through `DATABASE_URL`                                                   | Staging database           |
| Redis       | Railway Redis                | Internal `REDIS_URL` + `?family=0`                                                          | BullMQ/OTP/OAuth state     |
| OTP Email   | Brevo (HTTPS API)            | `BREVO_API_KEY` (Railway blocks SMTP below Pro)                                             | Real delivery verified     |
| Blockchain  | Solana Devnet                | Existing Anchor program + tUSDC                                                             | Devnet only                |
| PDF Storage | Railway API local filesystem | `var/reports`                                                                               | Needs persistent storage   |

Current deployment topology:

```text
Vercel Web ──HTTPS──→ Railway API ──→ Supabase PostgreSQL
                          │          ├─→ Railway Redis/BullMQ
                          │          └─→ Brevo (OTP email, HTTPS)
Railway Worker (internal) ┘─────────→ Solana Devnet / Square Sandbox
```

### 1. Railway project

Connect the same Git repository to Railway and operate `serveproof-api`, `serveproof-worker`, and Redis services. PostgreSQL is hosted on Supabase. (Upstash free tier was replaced with Railway Redis because BullMQ polling exhausted its 500K command allowance.) Both services use repository root `/` because they depend on shared workspace packages.

API service:

```text
Build Command:      pnpm --filter @serveproof/api... build
Pre-deploy Command: pnpm --filter @serveproof/db migrate:deploy
Start Command:      pnpm --filter @serveproof/api start:api
Healthcheck Path:   /health
```

Worker service:

```text
Build Command: pnpm --filter @serveproof/worker... build
Start Command: pnpm --filter @serveproof/worker start:worker
```

Run migrations only in the API service pre-deploy step so the API and worker do not attempt them concurrently. Railway runs the pre-deploy command after build and before starting the new process; a failure stops the deployment.

Configure the same backend environment variables on both services. Use Railway reference variables to connect PostgreSQL `DATABASE_URL` and Redis `REDIS_URL`.

```dotenv
NODE_ENV=production
APP_ENV=staging
DATABASE_URL=<Supabase PostgreSQL session-pooler URI>
REDIS_URL=${{Redis.REDIS_URL}}?family=0   # Railway internal DNS is IPv6-only
AUTH_SECRET=<strong random secret>
BREVO_API_KEY=<Brevo API key (xkeysib-…)>  # API service only
EMAIL_FROM=<sender email verified by Brevo>
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

Railway injects runtime `PORT`, so do not set a fixed `API_PORT` in deployed environments. The API prefers `PORT` and uses `API_PORT=3001` only locally.

Performance logging does not print every request or SQL statement. The API emits one `slow_api_request` line only after the threshold, while Prisma emits `slow_db_query` only for queries at or above 200ms. SQL parameters, email addresses, and tokens are never logged; only the operation and table name are retained. `dbDurationSumMs` is the sum of query durations within a request and can exceed `totalMs` when queries run in parallel. Prisma pool timeouts (`P2024`) are labeled `db_pool_timeout`. Set `PERFORMANCE_LOGGING_ENABLED=false` to disable the instrumentation entirely.

When slow queries recur, manually run [`scripts/pg-stat-statements.sql`](scripts/pg-stat-statements.sql) in the Supabase SQL Editor to inspect statements ranked by cumulative execution time. The application and migrations never run this diagnostic query automatically.

OTP email is sent through the Brevo HTTPS API. Railway blocks outbound SMTP ports 25/465/587 below the Pro plan, so SMTP remains a local/Pro fallback. Responses contain `devCode` only for email domains listed in `OTP_DEVCODE_DOMAINS` and when `APP_ENV=local`, preserving one-click demo/E2E login. All other addresses receive codes only by email.

After the API starts successfully for the first time, run the seed once in a Railway one-off shell:

```bash
pnpm --filter @serveproof/db seed
```

Update the Square Developer Console Sandbox Redirect URL to the Railway API callback URL as well.

### 2. Vercel Web project

Import the same repository as a new Vercel project.

```text
Framework Preset: Next.js
Root Directory:   apps/web
Build Command:    pnpm --filter @serveproof/web... build
Output Directory: .next (framework default)
Node.js:          22
```

Enable `Include source files outside of the Root Directory` so Vercel can read workspace packages above the root directory. The root `packageManager` field and lockfile determine the pnpm version.

Vercel environment variable:

```dotenv
NEXT_PUBLIC_API_URL=https://<railway-api-domain>
```

Current production value:

```dotenv
NEXT_PUBLIC_API_URL=https://serveproofapi-production.up.railway.app
```

`NEXT_PUBLIC_API_URL` is embedded into the client bundle at build time, so redeploy Web after changing the API domain. Once Vercel deployment completes, set the real domain as Railway's `WEB_ORIGIN` and redeploy the API.

### 3. Deployment verification

```bash
curl https://serveproofapi-production.up.railway.app/health
```

Then run the smoke test in this order:

1. Sign in to Web as the demo manager through OTP.
2. CSV import → venue connection request → worker acceptance → allocation calculation → approval.
3. Connect Square OAuth through the API and verify provider health.
4. Confirm `provider-sync` consumption in Worker logs.
5. Record a legacy payout or settle Devnet tUSDC.
6. Verify the worker income screen and discrepancies.
7. Issue a disclosure report → verify it publicly through QR → revoke it.

### Demo deployment limitations

- PDFs are currently stored in the API container's `var/reports`. They may disappear after a Railway restart or redeployment; persistent demos require an S3-compatible private bucket.
- Email OTP uses Brevo's free tier (300 messages/day). Messages may be classified as spam when the sender uses a gmail.com address; obtaining a domain and completing Brevo domain verification resolves this.
- Structured API/worker logging, Sentry, and a comprehensive dependency health endpoint remain Phase 6 work.
- Use a dedicated RPC provider to avoid Devnet rate limits.
- Devnet authority and tUSDC are not secured for real assets.

## Security principles

- Never commit or log `.env`, provider tokens, OTPs, refresh tokens, or wallet private keys.
- Square tokens are stored in the database only as AES-256-GCM ciphertext.
- The backend never stores venue wallet private keys and creates only unsigned transactions.
- An account represents one person's identity. Worker capability and organization membership are not mutually exclusive global roles.
- Every venue-scoped API validates organization membership and organization role after JWT authentication.
- Never delete or overwrite approved allocations or original payment records.
- Remove `APP_ENV=local` before production deployment and use an external secret manager and private object storage.

## License

This repository does not currently define a root license. Confirm usage terms with the project owner before external distribution or reuse.
