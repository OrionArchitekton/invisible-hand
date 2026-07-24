#!/usr/bin/env bash
# One-word demo wrapper for the LABELED operator stress test: picks the
# weakest LIVING variant, fires the real insolvency path, then curls the
# delisted endpoint so the 410 GONE is shown on stage.
set -euo pipefail
WEAK=$(curl -s localhost:3313/state | python3 -c "
import json,sys
s=json.load(sys.stdin)
live=[v for v in s['variants'] if v['alive']]
print(sorted(live, key=lambda v: v['fitness'])[0]['id'])")
echo "weakest living variant: $WEAK"
echo "--- operator-triggered stress test (labeled as such) ---"
curl -s -X POST "localhost:3313/demo/stress-insolvency/$WEAK" --max-time 30 | python3 -m json.tool | head -12
echo "--- the dead endpoint, live ---"
curl -s -i "localhost:4020/v/$WEAK/extract" -X POST -H 'content-type: application/json' -d '{"text":"probe"}' --max-time 10 | head -3
