#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

for command_name in pnpm docker openssl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

set_secret_if_blank() {
  local key="$1"
  if grep -q "^${key}=$" .env; then
    local value
    value="$(openssl rand -hex 32)"
    sed -i "s|^${key}=$|${key}=${value}|" .env
    echo "Generated ${key}"
  elif ! grep -q "^${key}=" .env; then
    local value
    value="$(openssl rand -hex 32)"
    printf '\n%s=%s\n' "$key" "$value" >>.env
    echo "Added ${key}"
  fi
}

set_secret_if_blank AUTH_SECRET
set_secret_if_blank REPORT_SIGNING_KEY
set_secret_if_blank PROVIDER_ENCRYPTION_KEY

# Seed is a plain Node script, so export the root .env for PrismaClient as well
# as for the Prisma CLI. Do not print any imported values.
set -a
# shellcheck disable=SC1091
source .env
set +a

pnpm install --frozen-lockfile
docker compose up -d postgres redis

ready=false
for _ in {1..30}; do
  if docker compose exec -T postgres pg_isready -U serveproof -d serveproof >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done

if [[ "$ready" != "true" ]]; then
  echo "PostgreSQL did not become ready within 30 seconds" >&2
  exit 1
fi

pnpm --filter @serveproof/db migrate:deploy
pnpm --filter @serveproof/db seed

echo
echo "ServeProof demo setup is ready."
echo "Run: pnpm demo:start"
