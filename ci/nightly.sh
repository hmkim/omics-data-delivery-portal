#!/usr/bin/env bash
# Nightly job (T7.7): M6 integration tests + M7 Playwright e2e against the deployed dev account.
#
# The runner must already hold AWS credentials for the dev account in the default credential chain (GitHub Actions:
# OIDC role, see ci/README.md) and provide the portal test user through E2E_PORTAL_USER ("<e-mail>\n<password>").
# The large e2e downloads (12 GiB × ~5 passes ≈ $4–6 of CloudFront/S3 transfer) are the reason this is a nightly
# job and not part of the PR gate.
#
#   PORTAL_URL           https://<web distribution>.cloudfront.net  (default: CloudFormation output of genome-portal-web)
#   E2E_PORTAL_USER      two lines: portal test user e-mail, password (required for the signed-in e2e scenarios)
#   NIGHTLY_INTEG=0      skip the integration suite      NIGHTLY_E2E=0   skip the Playwright suite
#   INTEG_SLOW=1         include the 15-min URL-expiry and CloudTrail tests (default 1 for the nightly run)
#   E2E_BIG_FILE         cache-test object; keep the 12 GiB default — sample-53gib.bin costs ≈ $5–6 per pass
#   CI_OUTPUT_DIR        where reports land (default ./ci-output)
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${AWS_REGION:-ap-northeast-2}"
OUT="${CI_OUTPUT_DIR:-$PWD/ci-output}"
mkdir -p "$OUT"
step() { printf '\n==> %s\n' "$*"; }

step "identity"
aws sts get-caller-identity --output table --region "$REGION"

step "install (npm ci)"
npm ci --no-audit --no-fund

if [[ -z "${PORTAL_URL:-}" ]]; then
  PORTAL_URL="$(aws cloudformation describe-stacks --stack-name genome-portal-web --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='PortalUrl'].OutputValue" --output text)"
fi
PORTAL_URL="${PORTAL_URL%/}"
echo "portal: $PORTAL_URL"

# the SPA's runtime config doubles as the Vite dev-server config for the e2e run
step "web/dev-config.json from ${PORTAL_URL}/config.json"
curl -fsS "${PORTAL_URL}/config.json" -o web/dev-config.json
node -e "JSON.parse(require('fs').readFileSync('web/dev-config.json','utf8')); console.log('  ok')"

if [[ "${NIGHTLY_INTEG:-1}" == "1" ]]; then
  step "M6 integration tests (INTEG=1 INTEG_SLOW=${INTEG_SLOW:-1})"
  INTEG=1 INTEG_SLOW="${INTEG_SLOW:-1}" npm test -w infra 2>&1 | tee "$OUT/integ.log"
fi

if [[ "${NIGHTLY_E2E:-1}" == "1" ]]; then
  if [[ -z "${E2E_PORTAL_USER:-}" ]]; then
    echo "E2E_PORTAL_USER is not set; the signed-in e2e scenarios cannot run" >&2
    exit 2
  fi
  CREDS_FILE="$(mktemp)"
  chmod 600 "$CREDS_FILE"
  printf '%s\n' "$E2E_PORTAL_USER" > "$CREDS_FILE"
  trap 'rm -f "$CREDS_FILE"' EXIT

  step "Playwright browsers"
  (cd web && npx playwright install --with-deps chromium firefox)

  step "M7 e2e (Chromium + Firefox, big file: ${E2E_BIG_FILE:-sample-12gib.bin})"
  E2E_CREDENTIALS_FILE="$CREDS_FILE" \
  E2E_API_ORIGIN="$PORTAL_URL" \
  E2E_OUTPUT_DIR="$OUT/e2e" \
  E2E_REQUIRE_CREDENTIALS=1 \
    npm run e2e -w web 2>&1 | tee "$OUT/e2e.log"
fi

printf '\nNightly run finished; reports in %s\n' "$OUT"
