#!/usr/bin/env bash
# tools/seed.sh -- sample data for the genome data delivery portal (T4.2, requirements N8, design §7.4).
#
# Generates pseudo-random files of the requested sizes (default 1, 12 and 53 GiB), uploads them with a
# full-object CRC32 checksum to s3://<bucket>/<prefix>, verifies the checksum type, then creates the
# "demo" organisation, two users (ko / en) and assigns the location through the admin CLI.
#
# Usage:
#   tools/seed.sh --bucket <data-bucket> [--prefix projects/DEMO-0001/] [--sizes 1,12,53]
#                 [--region ap-northeast-2] [--ko-email a@x] [--en-email b@y] [--work-dir DIR]
#                 [--skip-admin] [--dry-run]
#
# Prerequisites: AWS CLI >= 2.23 with credentials for the data account, openssl, ~<largest size> GiB of
# free disk in --work-dir, and tools/admin.config.json for the admin steps (interactive TOTP login).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BUCKET=""
PREFIX="projects/DEMO-0001/"
SIZES="1,12,53"
REGION="ap-northeast-2"
KO_EMAIL=""
EN_EMAIL=""
WORK_DIR="${TMPDIR:-/tmp}"
DRY_RUN=0
SKIP_ADMIN=0
MIN_CLI="2.23.0"
ORG_ID="demo"
ORG_NAME="Demo organisation"

usage() {
  sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

log() { printf '[seed] %s\n' "$*" >&2; }
die() { printf '[seed] ERROR: %s\n' "$*" >&2; exit 1; }

run() {
  # Prints the command; executes it unless --dry-run.
  local -a cmd=("$@")
  printf '[seed] $ %q' "$1" >&2
  shift
  for a in "$@"; do printf ' %q' "$a" >&2; done
  printf '\n' >&2
  if [[ "$DRY_RUN" -eq 0 ]]; then
    "${cmd[@]}"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket) BUCKET="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --sizes) SIZES="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --ko-email) KO_EMAIL="$2"; shift 2 ;;
    --en-email) EN_EMAIL="$2"; shift 2 ;;
    --work-dir) WORK_DIR="$2"; shift 2 ;;
    --skip-admin) SKIP_ADMIN=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

[[ -n "$BUCKET" ]] || die "--bucket is required"
[[ "$PREFIX" == */ ]] || die "--prefix must end with '/' (got '$PREFIX')"
[[ "$PREFIX" != /* ]] || die "--prefix must not start with '/'"
[[ "$PREFIX" != *..* ]] || die "--prefix must not contain '..'"
if [[ "$SKIP_ADMIN" -eq 0 && "$DRY_RUN" -eq 0 ]]; then
  [[ -n "$KO_EMAIL" && -n "$EN_EMAIL" ]] || die "--ko-email and --en-email are required (or pass --skip-admin)"
fi
: "${KO_EMAIL:=demo-ko@example.com}"
: "${EN_EMAIL:=demo-en@example.com}"

# --- prerequisite checks ---------------------------------------------------------------------------
version_ge() {
  # version_ge A B -> true when A >= B (dot-separated numerics)
  [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]
}

command -v openssl >/dev/null || die "openssl not found"
command -v aws >/dev/null || die "aws CLI not found"
CLI_VERSION="$(aws --version 2>&1 | sed -nE 's#^aws-cli/([0-9]+\.[0-9]+\.[0-9]+).*#\1#p')"
[[ -n "$CLI_VERSION" ]] || die "could not parse 'aws --version' output"
version_ge "$CLI_VERSION" "$MIN_CLI" || die "AWS CLI $CLI_VERSION is too old; >= $MIN_CLI is required (CRC32 full-object checksums)"
log "aws-cli $CLI_VERSION OK"

if [[ "$DRY_RUN" -eq 0 ]]; then
  aws sts get-caller-identity --query Account --output text --region "$REGION" >/dev/null || die "no AWS credentials"
  aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null || die "bucket $BUCKET not reachable in $REGION"
fi

# --- disk check --------------------------------------------------------------------------------------
IFS=',' read -r -a SIZE_LIST <<<"$SIZES"
MAX_GIB=0
for s in "${SIZE_LIST[@]}"; do
  [[ "$s" =~ ^[0-9]+$ ]] || die "--sizes must be comma-separated integers (GiB), got '$s'"
  (( s > MAX_GIB )) && MAX_GIB=$s
done
NEED_BYTES=$(( MAX_GIB * 1073741824 + 1073741824 ))   # largest file + 1 GiB headroom (files are made one at a time)
mkdir -p "$WORK_DIR"
AVAIL_BYTES=$(df -P -B1 "$WORK_DIR" | awk 'NR==2 {print $4}')
if (( AVAIL_BYTES < NEED_BYTES )); then
  msg="need $(( NEED_BYTES / 1073741824 )) GiB free in $WORK_DIR, have $(( AVAIL_BYTES / 1073741824 )) GiB"
  if [[ "$DRY_RUN" -eq 1 ]]; then log "WARNING: $msg"; else die "$msg"; fi
fi

# --- generate + upload + verify -----------------------------------------------------------------------
for GIB in "${SIZE_LIST[@]}"; do
  BYTES=$(( GIB * 1073741824 ))
  NAME="sample-${GIB}gib.bin"
  LOCAL="$WORK_DIR/$NAME"
  KEY="${PREFIX}${NAME}"
  SEED="genome-portal-seed-${GIB}gib"

  log "generating $NAME ($BYTES bytes) with openssl aes-256-ctr keystream"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[seed] $ openssl enc -aes-256-ctr -pass pass:%s -nosalt </dev/zero | head -c %s > %q\n' "$SEED" "$BYTES" "$LOCAL" >&2
  else
    # head closes the pipe early, so openssl exits on SIGPIPE; that is expected, hence no pipefail here.
    ( set +o pipefail; openssl enc -aes-256-ctr -pass "pass:$SEED" -nosalt </dev/zero 2>/dev/null | head -c "$BYTES" >"$LOCAL" )
    ACTUAL=$(stat -c %s "$LOCAL")
    [[ "$ACTUAL" -eq "$BYTES" ]] || die "$LOCAL is $ACTUAL bytes, expected $BYTES"
  fi

  # `aws s3 cp --checksum-algorithm CRC32` records a COMPOSITE checksum for multipart uploads, which the portal
  # cannot verify (R5.3). tools/upload.ts declares ChecksumType=FULL_OBJECT and completes the upload with the
  # whole-file CRC32, then re-reads the object's checksum and compares it with the local value.
  run "$ROOT_DIR/node_modules/.bin/tsx" "$ROOT_DIR/tools/upload.ts" --file "$LOCAL" --bucket "$BUCKET" --key "$KEY" --region "$REGION"

  log "verifying checksum type of s3://$BUCKET/$KEY"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[seed] $ aws s3api head-object --bucket %q --key %q --checksum-mode ENABLED --region %q --query ChecksumType\n' "$BUCKET" "$KEY" "$REGION" >&2
  else
    CHECKSUM_TYPE="$(aws s3api head-object --bucket "$BUCKET" --key "$KEY" --checksum-mode ENABLED --region "$REGION" \
      --query 'ChecksumType' --output text)"
    if [[ "$CHECKSUM_TYPE" != "FULL_OBJECT" ]]; then
      cat >&2 <<EOF
[seed] ERROR: ChecksumType for $KEY is '$CHECKSUM_TYPE', expected FULL_OBJECT.
       The portal compares split downloads against the full-object CRC32 (R5.3), so this object is unusable.
       tools/upload.ts should have declared FULL_OBJECT; check its output above, delete the object and rerun.
EOF
      exit 1
    fi
    rm -f "$LOCAL"
    log "$KEY uploaded, ChecksumType=FULL_OBJECT"
  fi
done

# --- organisation, users, location ---------------------------------------------------------------------
if [[ "$SKIP_ADMIN" -eq 1 ]]; then
  log "--skip-admin: not touching organisations/users/locations"
  exit 0
fi

ADMIN=(npm run --silent admin --)
log "admin CLI steps (interactive Cognito sign-in with TOTP on first call; token cached in ~/.genome-portal)"
(
  cd "$ROOT_DIR"
  run "${ADMIN[@]}" org create --id "$ORG_ID" --name "$ORG_NAME"
  run "${ADMIN[@]}" user create --email "$KO_EMAIL" --org "$ORG_ID" --lang ko
  run "${ADMIN[@]}" user create --email "$EN_EMAIL" --org "$ORG_ID" --lang en
  run "${ADMIN[@]}" location assign --org "$ORG_ID" --bucket "$BUCKET" --prefix "$PREFIX" --label "Demo project"
  run "${ADMIN[@]}" location list --org "$ORG_ID"
)

log "done. Expected state: ${#SIZE_LIST[@]} object(s) under s3://$BUCKET/$PREFIX with FULL_OBJECT CRC32,"
log "organisation '$ORG_ID' with users $KO_EMAIL (ko) and $EN_EMAIL (en), one Access Grant for s3://$BUCKET/${PREFIX}*."
