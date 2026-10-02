# CI (T7.7)

Two jobs, both defined as plain shell scripts so the runner is interchangeable; the GitHub Actions workflows in
`.github/workflows/` are thin wrappers around them.

| Job                     | Script          | Trigger                                             | Needs AWS | Runtime   | Cost / run                        |
| ----------------------- | --------------- | --------------------------------------------------- | --------- | --------- | --------------------------------- |
| PR gate (`pr.yml`)      | `ci/pr.sh`      | every pull request, pushes to `main`                | no        | ~5 min    | runner minutes only               |
| Nightly (`nightly.yml`) | `ci/nightly.sh` | 18:00 UTC (03:00 KST) daily, or `workflow_dispatch` | **yes**   | 60–90 min | ≈ $4–6 (≈ 60 GiB CloudFront + S3) |

**PR gate**: `npm ci` → `lint` → `prettier --check` → `typecheck` (all workspaces, including `web/e2e`) → unit
tests (contract 29, infra + Lambda 246, web 79, tools 56) → `vite build` → `cdk synth` against the placeholder
account with cdk-nag (an unsuppressed finding fails the synth). The nag CSV reports are uploaded as an artifact.

**Nightly**: `INTEG=1 INTEG_SLOW=1 npm test -w infra` (M6, T6.1–T6.8, ~45 min) then the Playwright suite
(M7, Chromium + Firefox, `E2E_REQUIRE_CREDENTIALS=1` so a missing test user fails instead of skipping). Reports,
`results.json`, `cache-passes.json` and failure traces are uploaded (30-day retention). `workflow_dispatch` lets an
operator run one suite only or switch the cache test to `sample-53gib.bin` (≈ $5–6 per pass, R5.8 evidence for
T8.1). The dev-server config (`web/dev-config.json`) is fetched from the portal's own `/config.json`.

## One-time repository setup

1. **IAM role for the nightly job** — deploy `ci/github-oidc-role.yaml` once in the dev account:

   ```sh
   aws cloudformation deploy --stack-name genome-portal-ci --template-file ci/github-oidc-role.yaml \
     --capabilities CAPABILITY_NAMED_IAM --region ap-northeast-2 \
     --parameter-overrides GitHubRepository=<owner>/<repo>   # CreateOidcProvider=false if the account already has the GitHub provider
   aws cloudformation describe-stacks --stack-name genome-portal-ci --region ap-northeast-2 \
     --query "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue" --output text
   ```

   The role (`genome-portal-ci-nightly`) is scoped to what the suites touch: `genome-portal-*` stacks, the user
   pool's admin APIs, fixture prefixes of the data bucket (`projects/INTEG-*`, `PERF-1000/`, `DEMO-0001/`), the
   `/genome-portal/*` SSM parameters, `genome-portal-ops-daily`, the three tables, the origin-verify secret,
   CloudTrail/CloudWatch reads, and the `genome-portal-ops` Athena workgroup with its buckets. No IAM, no
   deploy permissions — CI never deploys.

2. **Let the role through the data bucket policy** — the bucket denies everything that is not S3 Access Grants except
   the principals listed in `infra/config/dev.json`. Add the role ARN to `uploaderPrincipalArns` and redeploy the data
   stack (`tools/deploy.sh --env dev --only genome-portal-data`). Without this step T6.1's fixture upload fails with
   `AccessDenied`.

3. **Repository settings** (Settings → Environments → `dev`):
   - variable `DEV_CI_ROLE_ARN` = the `RoleArn` output;
   - secret `E2E_PORTAL_USER` = the portal test user, two lines: e-mail, password. Use a dedicated user of org
     `demo` **without TOTP** (pool MFA is OPTIONAL); create it with `npm run admin -- user create …` and set a
     permanent password with `aws cognito-idp admin-set-user-password --permanent`. Rotate it like any other
     secret; the e2e suite never prints it (`web/e2e/README.md`).

4. **Branch protection**: require the `pr / gate` check on `main`.

## Disk for the e2e run

Chromium keeps its profile — and the OPFS the split engine writes into — in `$TMPDIR`, and commits an OPFS file
through a swap file, so the run needs about **2 × the largest object** free there (≥ 30 GB for the 12 GiB default,
≥ 120 GB for `sample-53gib.bin`). `web/playwright.config.ts` refuses to start otherwise. `nightly.yml` points
`TMPDIR` at `/mnt/e2e-tmp` (the ~70 GB secondary disk of GitHub-hosted runners); a self-hosted runner needs the
same headroom. The 53 GiB pass does not fit a hosted runner — run it from a workstation.

## Cost lever

The nightly transfer (~60 GiB) comes from the 12 GiB object being downloaded ~5 times (T7.2 twice, T7.3, T7.4,
T7.6 ×2–3). Halve it by moving `nightly.yml` to `cron: '0 18 * * 1,4'` (Mon/Thu) or set `NIGHTLY_E2E=0` on the
schedule and run the e2e job by hand before releases. The integration suite alone costs cents (1–2 MiB objects).

## Running the same jobs elsewhere

Both scripts only need Node 22, `aws` CLI v2 and (nightly) Playwright's browser dependencies, so an AWS CodeBuild
project works with a five-line `buildspec.yml` (`runtime-versions: nodejs: 22`, `commands: [ci/pr.sh]`), with the
nightly project's service role carrying the same policy as `ci/github-oidc-role.yaml` and `E2E_PORTAL_USER` coming
from Secrets Manager. GitHub Actions was chosen because the reference implementation this portal builds on lives on
GitHub; nothing in `ci/` depends on it beyond the two workflow files.
