#!/usr/bin/env bash
# Deploys the genome-portal stacks in dependency order and records stack outputs.
#
#   tools/deploy.sh --env dev [--out <dir>] [--only <stack>[,<stack>...]]
#   --only takes FULL stack names (e.g. genome-portal-ops,genome-portal-web); a short name matches nothing and the
#   script reports "ALL DONE" without deploying anything.
#
# Order: auth, waf -> cdn -> cdn-logs (us-east-1) -> data -> api -> web -> ops (README "Deploy").
# If the very first cdn deployment fails because the data bucket does not exist yet, the script
# deploys data with -c skipCdnPolicy=true (bucket/KMS policies without the CloudFront statements),
# then cdn, then data again with the full policy.
set -uo pipefail

ENV_NAME="dev"
OUT_DIR=""
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT/infra/cdk.out/outputs-$ENV_NAME}"
mkdir -p "$OUT_DIR"
LOG="$OUT_DIR/deploy.log"
cd "$ROOT/infra"

log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG"; }

deploy() {
  local stack="$1"; shift
  log "deploying $stack $*"
  # cdk exits non-zero on failure; tee keeps the full CloudFormation event stream in the log.
  npx cdk deploy "$stack" -c "env=$ENV_NAME" "$@" --require-approval never --progress events \
    --outputs-file "$OUT_DIR/$stack.json" 2>&1 | tee -a "$LOG"
  local rc=${PIPESTATUS[0]}
  if [ "$rc" -eq 0 ]; then log "$stack OK"; else log "$stack FAILED (exit $rc)"; fi
  return "$rc"
}

wanted() {
  [ -z "$ONLY" ] && return 0
  case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

ALL_STACKS="genome-portal-auth genome-portal-waf genome-portal-cdn genome-portal-cdn-logs genome-portal-data genome-portal-api genome-portal-web genome-portal-ops"
if [ -n "$ONLY" ]; then
  for want in $(printf '%s' "$ONLY" | tr ',' ' '); do
    case " $ALL_STACKS " in *" $want "*) ;; *)
      echo "deploy.sh: --only '$want' is not a stack id. Use full names: $ALL_STACKS" >&2; exit 2 ;;
    esac
  done
fi

for s in genome-portal-auth genome-portal-waf; do
  wanted "$s" && { deploy "$s" || exit 1; }
done

if wanted genome-portal-cdn; then
  if ! deploy genome-portal-cdn; then
    log "cdn failed on first attempt; trying data (skipCdnPolicy) -> cdn -> data"
    deploy genome-portal-data -c skipCdnPolicy=true || exit 1
    deploy genome-portal-cdn || exit 1
  fi
fi

for s in genome-portal-cdn-logs genome-portal-data genome-portal-api genome-portal-web genome-portal-ops; do
  wanted "$s" && { deploy "$s" || exit 1; }
done

log "ALL DONE"
