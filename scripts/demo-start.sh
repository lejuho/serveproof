#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ ! -f .env ]]; then
  echo "Missing .env. Run 'pnpm demo:setup' first." >&2
  exit 1
fi

docker compose up -d postgres redis

api_port="$(node --env-file=.env -p 'process.env.API_PORT || 3001')"

assert_port_free() {
  local port="$1"
  local service="$2"
  if ! node -e '
    const net = require("node:net");
    const server = net.createServer();
    server.once("error", () => process.exit(1));
    server.listen(Number(process.argv[1]), "127.0.0.1", () => server.close());
  ' "$port"; then
    echo "Cannot start ${service}: port ${port} is already in use." >&2
    echo "Inspect it with: sudo lsof -iTCP:${port} -sTCP:LISTEN" >&2
    exit 1
  fi
}

assert_port_free 3000 "ServeProof web"
assert_port_free "$api_port" "ServeProof API"

echo "Starting ServeProof API, worker, and web..."
echo "Web:    http://localhost:3000"
echo "API:    http://localhost:${api_port}"
echo "Health: http://localhost:${api_port}/health"
echo "Press Ctrl+C to stop the application processes."
echo

exec pnpm --parallel \
  --filter @serveproof/api \
  --filter @serveproof/worker \
  --filter @serveproof/web \
  run start:dev
