#!/usr/bin/env bash
set -euo pipefail

: "${SYNC_TOKEN:?Set SYNC_TOKEN to the Worker sync token}"
BASE_URL="${GARAGE_API_URL:-https://garage.20040114.xyz}"
JOB_ID="sync-regression-job"
DEVICE_ID="sync-regression-device"
NOW_MS=$(date +%s000)
OLD_MS=$((NOW_MS - 1000))

post() {
  curl -fsS --max-time 20 -X POST "$BASE_URL/sync" \
    -H "Authorization: Bearer $SYNC_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "$1"
}

post "$(python3 - "$JOB_ID" "$DEVICE_ID" "$NOW_MS" <<'PY'
import json, sys
job, device, now = sys.argv[1:]
print(json.dumps({'jobs': [{'id': job, 'device_id': device, 'plate': '皖A12345',
  'total_cost': 6000, 'total_charge': 12000, 'created_at': int(now), 'updated_at': int(now),
  'items': [{'id': 'sync-regression-fresh-item', 'spoken_name': '最新明细', 'cost': 6000, 'charge': 12000}]}]}))
PY
)" >/dev/null

post "$(python3 - "$JOB_ID" "$DEVICE_ID" "$OLD_MS" <<'PY'
import json, sys
job, device, old = sys.argv[1:]
print(json.dumps({'jobs': [{'id': job, 'device_id': device, 'plate': '陈旧车牌',
  'total_cost': 1, 'total_charge': 1, 'created_at': int(old), 'updated_at': int(old),
  'items': [{'id': 'sync-regression-stale-item', 'spoken_name': '陈旧明细', 'cost': 1, 'charge': 1}]}]}))
PY
)" >/dev/null

result=$(curl -fsS --max-time 20 "$BASE_URL/sync?device=$DEVICE_ID&since=0" \
  -H "Authorization: Bearer $SYNC_TOKEN")
python3 - "$result" <<'PY'
import json, sys
body = json.loads(sys.argv[1])
job = next(x for x in body['jobs'] if x['id'] == 'sync-regression-job')
items = [x for x in body['items'] if x['job_id'] == job['id']]
assert job['plate'] == '皖A12345', f"stale job overwrote fresh job: {job}"
assert [x['spoken_name'] for x in items] == ['最新明细'], f"stale items overwrote fresh items: {items}"
print('PASS stale payload cannot overwrite job or items')
PY
