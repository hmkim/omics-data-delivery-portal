#!/usr/bin/env bash
# CORS probe for the data distribution (N4 / acceptance §3-6). Run from the repo root.
# Signs in as the e2e user, asks the portal API for a download URL of the 1 GiB sample (CloudFront path after the
# first download), then fetches 1 KiB ranges with different Origin headers and prints the CORS-relevant headers.
set -euo pipefail
PORTAL="https://d111111abcdef8.cloudfront.net"
BUCKET="genome-portal-data-123456789012-ap-northeast-2"
KEY="projects/DEMO-0001/sample-1gib.bin"
CREDS="$HOME/.cache/genome-portal-e2e/user-login.txt"
OUT="${1:-${PORTAL_SCRATCH:-${TMPDIR:-/tmp}}/cors-probe}"
mkdir -p "$OUT"

TOKEN="$(npx tsx tools/token.ts < "$CREDS")"
body="{\"bucket\":\"$BUCKET\",\"key\":\"$KEY\"}"
for attempt in 1 2; do
  curl -sS -o "$OUT/dl.json" -w '%{http_code}\n' -X POST "$PORTAL/api/downloads" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body" > "$OUT/dl.status"
  path="$(node -e "console.log(require('$OUT/dl.json').path)")"
  echo "POST /api/downloads -> $(cat "$OUT/dl.status") path=$path count=$(node -e "console.log(require('$OUT/dl.json').count)")"
  [ "$path" = "CLOUDFRONT" ] && break
done
URL="$(node -e "console.log(require('$OUT/dl.json').url)")"
echo "url host: $(node -e "console.log(new URL(process.argv[1]).host)" "$URL")"

probe() { # label, extra curl args...
  local label="$1"; shift
  echo "--- $label"
  curl -sS -o /dev/null -D - "$@" "$URL" | grep -iE '^(HTTP/|x-cache|access-control-|vary|content-range|x-amz-checksum-crc32|etag)' | sed 's/^/    /'
}
probe "GET range, Origin=portal (1st: may be Miss)"  -r 0-1023 -H "Origin: $PORTAL"
probe "GET range, Origin=portal (2nd: expect Hit)"   -r 0-1023 -H "Origin: $PORTAL"
probe "GET range, Origin=https://other.example.test" -r 0-1023 -H "Origin: https://other.example.test"
probe "GET range, no Origin (curl/aria2c client)"     -r 0-1023
probe "OPTIONS preflight, Origin=other, ACRM=GET, ACRH=range" -X OPTIONS -H "Origin: https://other.example.test" \
  -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: range"
probe "GET range 1024-2047, Origin=other (different cache key: Miss expected)" -r 1024-2047 -H "Origin: https://other.example.test"
probe "GET range 1024-2047, Origin=portal (Hit from the other origin's fill)" -r 1024-2047 -H "Origin: $PORTAL"
