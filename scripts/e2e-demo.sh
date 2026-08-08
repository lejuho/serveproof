#!/usr/bin/env bash
# §26 데모 24단계 Playwright E2E 실행.
# 전제: docker compose up -d + api/worker/web 기동 (scripts/demo-start.sh)
# 옵션: PW_SKIP_ONCHAIN=1 (Devnet 미사용), PW_BUSINESS_DATE=YYYY-MM-DD (기본: 분 단위 자동 파생)
set -euo pipefail
cd "$(dirname "$0")/../apps/web"

# WSL에 chromium 시스템 라이브러리(libnss3 등)가 없으면 sudo 없이 로컬 추출본 사용
PW_LIBS="$HOME/.local/pw-libs/usr/lib/x86_64-linux-gnu"
if [ -d "$PW_LIBS" ]; then
  export LD_LIBRARY_PATH="$PW_LIBS${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

npx playwright test "$@"
