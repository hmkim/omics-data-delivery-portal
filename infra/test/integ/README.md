# Integration tests (M6, T6.1–T6.8)

> Identifiers in this public copy (account id, CloudFront domains and distribution id, user pool id, e-mail
> addresses) are documentation placeholders; the measurements and dates are the real ones from the dev run.

End-to-end checks against the **deployed dev account** (`infra/config/dev.json`, region `ap-northeast-2`). They
exercise the real portal (`${PortalUrl}/api/...`), Cognito, S3 Access Grants, CloudFront, DynamoDB, CloudWatch,
CloudTrail and the `genome-portal-ops-daily` Lambda. Nothing here is mocked.

## Prerequisites

- The eight stacks are deployed (`tools/deploy.sh` / `npm run deploy:dev -w infra`); outputs are read with
  CloudFormation `DescribeStacks`, never hard-coded.
- AWS credentials for the account's `Admin` role in the default profile (no `--profile`). `Admin` is listed in
  `uploaderPrincipalArns`, so the test process may `PutObject` into the data bucket. Sandbox tokens are re-read
  from the shared credentials file every 10 minutes (`harness/aws.ts`), so a token rotated mid-run is picked up.
- The seed object `projects/DEMO-0001/sample-1gib.bin` exists with a `FULL_OBJECT` CRC32 (T6.1 precondition).
- SSM `/genome-portal/cf-threshold` = `1` and `/genome-portal/url-ttl-seconds` = `3600` before the run
  (every file asserts this in `beforeAll`; see "Manual clean-up" if a previous run was interrupted).

```bash
INTEG=1 npm test -w infra                 # fast suite, ~8 min
INTEG=1 INTEG_SLOW=1 npm test -w infra    # + 15-min URL expiry (T6.5) and CloudTrail (T6.7), ~40–50 min
INTEG=1 npx vitest run test/integ/t6.4-path-rules.test.ts   # one file (run from infra/)
```

`infra/vitest.config.ts` switches to `test/integ/**` when `INTEG=1`, runs the files serially in path order,
and sets a 10-minute default timeout (slow tests declare their own). Without `INTEG=1` the unit suite runs and the
integ files are ignored, so `npm test` at the repo root stays offline.

## What the suite creates, mutates and restores

| Resource                                                                                                  | Lifetime        | Notes                                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Cognito users `integ-a@`, `integ-b@`, `integ-admin@genome-portal.invalid`                                 | persistent      | Created with `MessageAction: SUPPRESS`; a fresh random permanent password is set on every run (memory only). Never deleted. |
| Orgs `integ-a`, `integ-b`                                                                                 | persistent      | Created through `POST /api/admin/orgs` (409 = already there).                                                               |
| Assignments `projects/INTEG-A/` → integ-a, `projects/INTEG-B/` → integ-b, `projects/PERF-1000/` → integ-a | persistent      | Each creates one Access Grant on first run.                                                                                 |
| `projects/INTEG-B/isolation-probe.bin` (4 KiB), `projects/PERF-1000/obj-0001..1000.bin` (1 KiB)           | persistent      | Idempotent; PERF-1000 is skipped once 1,000 objects exist.                                                                  |
| `projects/INTEG-A/run-<runId>/*.bin` (1–2 MiB each)                                                       | per run         | Deleted in each file's `afterAll` (best effort).                                                                            |
| `ORG#integ-a` / `LOC#<bucket>/projects/INTEG-NOGRANT/` item in `genome-portal-orgs`                       | seconds         | T6.3(b) injects it without a grant and deletes it in `finally`.                                                             |
| `projects/INTEG-SHARED/` assignment + grant                                                               | minutes         | T6.6 assigns to both orgs then unassigns both; `afterAll` unassigns again on failure.                                       |
| SSM `/genome-portal/url-ttl-seconds` → `43200` (T6.2), `900` (T6.5 slow)                                  | ≤ 2 min         | Restored to `3600` in `finally`, then 65 s wait for the Lambda cache.                                                       |
| SSM `/genome-portal/cf-threshold` → `0` (T6.4)                                                            | ≤ 2 min         | Restored to `1` in `finally`, then 65 s wait.                                                                               |
| Audit events, download counters, `DL#` metadata, CloudWatch metrics                                       | permanent (TTL) | Normal product side effects of the API calls; nothing is removed.                                                           |

Never touched: org `demo`, `projects/DEMO-0001/` and its grant, the seeded admin and demo users,
and the admin action `unassign-all`.

## Evidence

Every file prints `[evidence] <timestamp> ...` lines (`console.info`) and appends them to
`$PORTAL_SCRATCH/gp/integ/run-<runId>/evidence.log`. The run id comes from `harness/global-setup.ts`; the first
successful `POST /downloads` of the run is recorded in `first-download.json` for T6.7. Measured numbers:

- T6.2: `expiresAt − now` for a 12 h TTL and the S3 URL's `X-Amz-Expires`.
- T6.3(b): `GrantMissing` Sum over the last 10 min and how long it took to appear.
- T6.5: S3/CF lifetimes vs. TTL, Range responses, and (slow) the post-expiry status codes.
- T6.7 (slow): time from issue until the `GetDataAccess` event with `dl=<downloadId>` is visible in CloudTrail.
- T6.8: p50 / p95 / max of 200 portal-domain downloads plus 40 direct API Gateway calls.

## Manual clean-up after an interrupted run

```bash
# 1. SSM back to the contract defaults (Lambdas re-read them within 60 s)
aws ssm put-parameter --name /genome-portal/url-ttl-seconds --value 3600 --overwrite
aws ssm put-parameter --name /genome-portal/cf-threshold   --value 1    --overwrite

# 2. T6.3(b) injected assignment (only if the run died inside that test)
aws dynamodb delete-item --table-name genome-portal-orgs --key \
  '{"pk":{"S":"ORG#integ-a"},"sk":{"S":"LOC#genome-portal-data-123456789012-ap-northeast-2/projects/INTEG-NOGRANT/"}}'

# 3. T6.6 INTEG-SHARED assignments (admin CLI, or POST /api/admin/locations as integ-admin)
npm run admin -- locations unassign --org integ-a --prefix projects/INTEG-SHARED/
npm run admin -- locations unassign --org integ-b --prefix projects/INTEG-SHARED/

# 4. Per-run objects (safe: only the run prefix)
aws s3 rm s3://genome-portal-data-123456789012-ap-northeast-2/projects/INTEG-A/run-<runId>/ --recursive
```

The `genome-portal-ops-daily` `GrantDrift` metric confirms step 3: it is `0` when the grants and the
`LOC#…/META` ledger agree.

## Playwright hand-off (M7)

`projects/PERF-1000/` holds 1,000 × 1 KiB objects assigned to `integ-a`. Log in at `${PortalUrl}` as
`integ-a@genome-portal.invalid`; the password is reset by every integ run, so set a known one first:
`aws cognito-idp admin-set-user-password --user-pool-id <UserPoolId> --username integ-a@genome-portal.invalid --password '<...>' --permanent`.
