#!/usr/bin/env bash
# One-word demo wrapper: run one REAL paid buy cycle now, optionally on a
# judge-picked article URL. Usage: scripts/demo-buy.sh [url]
set -euo pipefail
URL="${1:-}"
if [ -n "$URL" ]; then
  BODY=$(printf '{"url":"%s"}' "$URL")
else
  BODY='{}'
fi
curl -s -X POST localhost:3313/demo/buy -H 'content-type: application/json' -d "$BODY" --max-time 120 | python3 -m json.tool
