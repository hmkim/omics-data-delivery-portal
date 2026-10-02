#!/usr/bin/env bash
# PR gate (T7.7): everything that runs offline on every pull request.
#   lint · prettier --check · typecheck (all workspaces) · unit tests (contract, infra incl. Lambda, web, tools)
#   · web production build · `cdk synth` with cdk-nag (an offline synth against the placeholder account; nag errors
#   fail the synth, so a new unsuppressed finding fails the PR).
# No AWS credentials are needed. Runs from any directory; ~4–6 min on a 4-vCPU runner.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n==> %s\n' "$*"; }

step "install (npm ci)"
npm ci --no-audit --no-fund

step "lint"
npm run lint

step "format check"
npm run format

step "typecheck"
npm run typecheck

step "unit tests"
npm test

step "web build"
npm run build -w web

step "cdk synth + cdk-nag (offline)"
npm run synth
test -d infra/cdk.out && ls infra/cdk.out/*.template.json | sed 's|^|  |'

printf '\nPR gate passed.\n'
