#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

docker compose stop postgres redis
echo "Stopped ServeProof PostgreSQL and Redis. Data volumes were preserved."
