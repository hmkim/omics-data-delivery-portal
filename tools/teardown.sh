#!/usr/bin/env bash
# tools/teardown.sh -- remove a genome-portal environment (T4.3, requirement N8, design §7.2 step 5).
#
# Order (each step can be previewed with --dry-run, which makes NO AWS calls):
#   1. npm run admin -- location unassign --all      (deletes every S3 Access Grant; CloudFormation cannot
#                                                     delete the Access Grants location/instance while grants
#                                                     created at runtime still exist)
#   2. Confirm that the CloudFront flat-rate (Pro) plan has been cancelled AND the billing cycle has ended.
#      A distribution subscribed to a plan cannot be deleted; cancellation takes effect at the end of the
#      current billing cycle. If the plan is still attached the script stops here.
#   3. npx -w infra cdk destroy, one stack at a time, in reverse deployment order:
#        genome-portal-ops -> -web -> -api -> -data -> -cdn -> -waf -> -auth
#   4. Print the manual clean-up for RETAIN resources (data bucket, KMS key, audit archive bucket,
#      CloudFront log bucket). They are never deleted by this script.
#
# Usage: tools/teardown.sh --env <env> [--region ap-northeast-2] [--yes] [--dry-run] [--skip-unassign]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENV_NAME=""
REGION="ap-northeast-2"
YES=0
DRY_RUN=0
SKIP_UNASSIGN=0

# Reverse of the deployment order in README / infra/lib/constants.ts (STACK_IDS).
STACKS_REVERSE=(
  genome-portal-ops
  genome-portal-web
  genome-portal-api
  genome-portal-data
  genome-portal-cdn-logs
  genome-portal-cdn
  genome-portal-waf
  genome-portal-auth
)

usage() { sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
log() { printf '[teardown] %s\n' "$*" >&2; }
die() { printf '[teardown] ERROR: %s\n' "$*" >&2; exit 1; }

run() {
  printf '[teardown] $ %q' "$1" >&2
  shift
  for a in "$@"; do printf ' %q' "$a" >&2; done
  printf '\n' >&2
  if [[ "$DRY_RUN" -eq 0 ]]; then "$@"; fi
}

confirm() {
  # confirm <question>  -> returns 0 for yes. --yes answers yes; --dry-run only prints the question.
  local q="$1"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "(dry-run) would ask: $q"
    return 0
  fi
  if [[ "$YES" -eq 1 ]]; then
    log "$q -> yes (--yes)"
    return 0
  fi
  local answer
  read -r -p "[teardown] $q [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]]
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --yes) YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-unassign) SKIP_UNASSIGN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

[[ -n "$ENV_NAME" ]] || die "--env <env> is required (e.g. --env dev; matches infra/config/<env>.json)"
[[ "$ENV_NAME" =~ ^[a-z0-9-]+$ ]] || die "--env must be lowercase letters, digits or '-'"
[[ -f "$ROOT_DIR/infra/config/$ENV_NAME.json" ]] || log "WARNING: infra/config/$ENV_NAME.json not found; cdk will fail unless it exists"

cd "$ROOT_DIR"
log "environment: $ENV_NAME  region: $REGION  dry-run: $DRY_RUN"

# ---- step 1: remove grants ------------------------------------------------------------------------------
log "step 1/4: remove every organisation->location assignment and S3 Access Grant"
if [[ "$SKIP_UNASSIGN" -eq 1 ]]; then
  log "--skip-unassign given; assuming 'location unassign --all' already ran"
else
  run npm run --silent admin -- location unassign --all --yes
fi

# ---- step 2: flat-rate plan gate --------------------------------------------------------------------------
log "step 2/4: CloudFront flat-rate plan check"
cat >&2 <<'EOF'
[teardown] The data distribution (stack genome-portal-cdn) must not be subscribed to a flat-rate plan.
[teardown]   - The subscription is the cdn stack's FlatRatePlan resource (config flatRatePlan). Cancel it in the
[teardown]     CloudFront console (Distributions -> data distribution -> Manage plan -> Cancel) or with
[teardown]     'aws pricing-plan-manager cancel-subscription --region us-east-1 --arn <arn> --if-match <eTag>'.
[teardown]     Cancellation of an ACTIVE paid plan takes effect at the END of the current billing cycle; the
[teardown]     distribution cannot be deleted until then ('cdk destroy genome-portal-cdn' only schedules the same
[teardown]     cancellation and then fails on the distribution).
[teardown]   - A PENDING_APPROVAL (never approved) plan is cancelled immediately, and 'cdk destroy' deletes it itself.
[teardown]   - Verify: the distribution page shows "Pay-as-you-go" and no pending plan.
EOF
if confirm "Is the flat-rate plan on the data distribution already cancelled AND the billing cycle over (distribution is pay-as-you-go)?"; then
  log "plan check passed"
else
  cat >&2 <<'EOF'
[teardown] Stopping: with the plan still attached, 'cdk destroy genome-portal-cdn' fails and leaves the stack in
[teardown] DELETE_FAILED. Cancel the plan, wait for the billing cycle to end, then rerun this script
[teardown] (add --skip-unassign if the grants were already removed).
EOF
  exit 2
fi

# ---- step 3: destroy stacks -------------------------------------------------------------------------------
log "step 3/4: cdk destroy in reverse deployment order"
if confirm "Destroy stacks ${STACKS_REVERSE[*]} for env '$ENV_NAME'?"; then
  for STACK in "${STACKS_REVERSE[@]}"; do
    run npx -w infra cdk destroy "$STACK" -c "env=$ENV_NAME" --force
  done
else
  die "aborted before destroying stacks"
fi

# ---- step 4: RETAIN resources -----------------------------------------------------------------------------
log "step 4/4: resources kept by RemovalPolicy.RETAIN (manual clean-up)"
ACCOUNT="<ACCOUNT_ID>"
if [[ "$DRY_RUN" -eq 0 ]]; then
  ACCOUNT="$(aws sts get-caller-identity --query Account --output text --region "$REGION" 2>/dev/null || echo '<ACCOUNT_ID>')"
fi
DATA_BUCKET="genome-portal-data-${ACCOUNT}-${REGION}"
cat >&2 <<EOF
[teardown]
[teardown] The following were RETAINED on purpose (genome data, audit trail, logs, encryption key). Delete them only
[teardown] after confirming that the data is no longer needed or has been copied elsewhere:
[teardown]
[teardown]   a) Data bucket (versioned; empty all versions and delete markers first):
[teardown]        aws s3api list-object-versions --bucket ${DATA_BUCKET} --region ${REGION} --max-items 5
[teardown]        aws s3 rm s3://${DATA_BUCKET} --recursive --region ${REGION}
[teardown]        # versions/delete markers: use a lifecycle rule (expire noncurrent versions) or s3api delete-objects
[teardown]        aws s3api delete-bucket --bucket ${DATA_BUCKET} --region ${REGION}
[teardown]      Skip this if the bucket was imported via infra/config/${ENV_NAME}.json "dataBucketName".
[teardown]
[teardown]   b) Audit archive bucket (Glacier Instant Retrieval objects, >= 1 year retention requirement R7.1):
[teardown]        aws s3 rm s3://genome-portal-audit-archive-${ACCOUNT} --recursive --region ${REGION}
[teardown]        aws s3api delete-bucket --bucket genome-portal-audit-archive-${ACCOUNT} --region ${REGION}
[teardown]
[teardown]   c) CloudFront standard log bucket:
[teardown]        aws s3 rm s3://genome-portal-cf-logs-${ACCOUNT} --recursive --region ${REGION}
[teardown]        aws s3api delete-bucket --bucket genome-portal-cf-logs-${ACCOUNT} --region ${REGION}
[teardown]
[teardown]   d) KMS key of the data bucket (alias alias/genome-portal-data; schedule deletion, 7-30 day waiting period):
[teardown]        aws kms describe-key --key-id alias/genome-portal-data --region ${REGION} --query KeyMetadata.KeyId
[teardown]        aws kms schedule-key-deletion --key-id <KeyId> --pending-window-in-days 30 --region ${REGION}
[teardown]      Objects encrypted with this key become unreadable once it is deleted -- empty (a) first.
[teardown]
[teardown]   e) Cognito users are deleted with the auth stack; ~/.genome-portal/token.json on admin workstations
[teardown]      can be removed (rm ~/.genome-portal/token.json).
[teardown]
[teardown]   f) If the S3 Access Grants instance was imported (accessGrantsInstanceArn) it was not deleted:
[teardown]        aws s3control list-access-grants --account-id ${ACCOUNT} --region ${REGION}
[teardown]      should list no genome-portal grants; remove the location with delete-access-grants-location if unused.
EOF
log "done"
