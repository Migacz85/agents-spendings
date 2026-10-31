#!/bin/bash
# dev.sh — run the dashboard LOCALLY (dev) from this working tree, on the
# laptop. Same code as production; dev data (this repo's fleet/ + history).
#
#   ./scripts/dev.sh          # collect + serve on http://127.0.0.1:8399/
#   ./scripts/dev.sh --serve  # serve only, no background collector
#
# Production is the same tree deployed to the production host.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
export SDASH_ENV="${SDASH_ENV:-dev}"
export SDASH_BUILD="${SDASH_BUILD:-$(git rev-parse --short HEAD 2>/dev/null || echo dev)}"
echo "dev server (env=$SDASH_ENV build=$SDASH_BUILD) -> http://127.0.0.1:8399/"
exec python3 collect.py "$@"
