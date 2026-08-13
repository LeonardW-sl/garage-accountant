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

# A duplicate receipt number must not poison the whole batch.
#
# The unique index on (device_id, receipt_no) is deliberate, but D1 runs a batch
# as one transaction: without per-job isolation a single conflicting row rejects
# every other job in the push, so one bad record silently blocks the entire
# ledger from ever syncing.
DUP_A="dup-receipt-job-a"
DUP_B="dup-receipt-job-b"
GOOD="dup-receipt-good-job"
DUP_DEVICE="dup-receipt-device"
DUP_NO="GX29991231-001"

post "$(python3 - "$DUP_A" "$DUP_DEVICE" "$DUP_NO" "$NOW_MS" <<'PY'
import json, sys
job, device, receipt, now = sys.argv[1:]
print(json.dumps({'jobs': [{'id': job, 'device_id': device, 'plate': '皖A00001',
  'receipt_no': receipt, 'local_date': '2999-12-31',
  'total_cost': 100, 'total_charge': 200,
  'created_at': int(now), 'updated_at': int(now),
  'items': [{'id': job + '-item', 'spoken_name': '三元催化器', 'cost': 100, 'charge': 200}]}]}))
PY
)" >/dev/null

# Second job, different id, same receipt number, batched with an unrelated good
# job. The good job is the one that must not be lost.
batch=$(python3 - "$DUP_B" "$GOOD" "$DUP_DEVICE" "$DUP_NO" "$NOW_MS" <<'PY'
import json, sys
dup, good, device, receipt, now = sys.argv[1:]
print(json.dumps({'jobs': [
    {'id': dup, 'device_id': device, 'plate': '皖A00002',
     'receipt_no': receipt, 'local_date': '2999-12-31',
     'total_cost': 100, 'total_charge': 200,
     'created_at': int(now), 'updated_at': int(now), 'items': []},
    {'id': good, 'device_id': device, 'plate': '皖A00003',
     'receipt_no': 'GX29991231-002', 'local_date': '2999-12-31',
     'total_cost': 300, 'total_charge': 400,
     'created_at': int(now), 'updated_at': int(now),
     'items': [{'id': good + '-item', 'spoken_name': '机油滤芯', 'cost': 300, 'charge': 400}]},
]}))
PY
)

if ! post "$batch" >/tmp/dup-batch-out.json 2>/tmp/dup-batch-err.txt; then
  echo "FAIL a duplicate receipt number made the whole push fail"
  cat /tmp/dup-batch-err.txt
  exit 1
fi

dup_result=$(curl -fsS --max-time 20 "$BASE_URL/sync?device=$DUP_DEVICE&since=0" \
  -H "Authorization: Bearer $SYNC_TOKEN")
python3 - "$dup_result" "$GOOD" "$DUP_A" <<'PY'
import json, sys
body, good, dup_a = json.loads(sys.argv[1]), sys.argv[2], sys.argv[3]
ids = {j['id'] for j in body['jobs']}
assert good in ids, f"the unrelated job was lost to another job's conflict: {sorted(ids)}"
assert dup_a in ids, f"the original job disappeared: {sorted(ids)}"
print('PASS a duplicate receipt number does not poison the batch')
PY

# ---------------------------------------------------------------------------
# /ocr guardrails.
#
# This endpoint proxies a paid vision API, so an unauthenticated or unbounded
# request costs real money. These cases hold with or without OCR_API_KEY set:
# auth and the size limit must both be decided before the upstream call.
# ---------------------------------------------------------------------------

code() {  # method url [data] [auth]
  local url="$1" data="$2" auth="$3"
  if [ -n "$auth" ]; then
    curl -s -o /tmp/ocr-body.json -w '%{http_code}' --max-time 20 -X POST "$url" \
      -H "Authorization: Bearer $auth" -H 'Content-Type: application/json' --data-binary "$data"
  else
    curl -s -o /tmp/ocr-body.json -w '%{http_code}' --max-time 20 -X POST "$url" \
      -H 'Content-Type: application/json' --data-binary "$data"
  fi
}

small='{"image":"data:image/png;base64,iVBORw0KGgo=","kind":"plate"}'

got=$(code "$BASE_URL/ocr" "$small" "")
if [ "$got" != "401" ]; then
  echo "FAIL /ocr without a token returned $got, expected 401 (anyone could spend the OCR budget)"
  cat /tmp/ocr-body.json; exit 1
fi
echo "PASS /ocr rejects an unauthenticated request"

got=$(code "$BASE_URL/ocr" "$small" "wrong-token-entirely")
if [ "$got" != "401" ]; then
  echo "FAIL /ocr with a bad token returned $got, expected 401"
  cat /tmp/ocr-body.json; exit 1
fi
echo "PASS /ocr rejects a wrong token"

# An oversized image must be refused before it reaches the paid upstream.
python3 - <<'PY' > /tmp/ocr-big.json
import json
print(json.dumps({'image': 'data:image/jpeg;base64,' + 'A' * (700 * 1024), 'kind': 'plate'}))
PY
got=$(code "$BASE_URL/ocr" "@/tmp/ocr-big.json" "$SYNC_TOKEN")
if [ "$got" != "413" ]; then
  echo "FAIL an oversized photo returned $got, expected 413 before the upstream call"
  head -c 300 /tmp/ocr-body.json; exit 1
fi
echo "PASS /ocr refuses an oversized photo"

# The limit must not reject a real photo: a 300KB JPEG base64-encodes to ~400KB.
# If this starts returning 413, phone photos stop working entirely.
python3 - <<'PY' > /tmp/ocr-real.json
import json
print(json.dumps({'image': 'data:image/jpeg;base64,' + 'A' * (400 * 1024), 'kind': 'plate'}))
PY
got=$(code "$BASE_URL/ocr" "@/tmp/ocr-real.json" "$SYNC_TOKEN")
if [ "$got" = "413" ]; then
  echo "FAIL a realistic 300KB photo was rejected as too large — the phone could never use OCR"
  cat /tmp/ocr-body.json; exit 1
fi
echo "PASS /ocr accepts a realistically sized photo (got $got)"

# A non-image payload must be refused too.
got=$(code "$BASE_URL/ocr" '{"image":"https://example.com/x.jpg","kind":"plate"}' "$SYNC_TOKEN")
if [ "$got" != "400" ] && [ "$got" != "503" ]; then
  echo "FAIL a non-data-URL image returned $got, expected 400 (or 503 when unconfigured)"
  cat /tmp/ocr-body.json; exit 1
fi
echo "PASS /ocr refuses a non-data-URL image (got $got)"

rm -f /tmp/ocr-big.json /tmp/ocr-real.json /tmp/ocr-body.json
