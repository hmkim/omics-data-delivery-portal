# Omics Data Delivery Portal

Web portal that replaces hand-issued S3 presigned URLs for delivering omics data (FASTQ, BAM/CRAM, VCF, reports).
All AWS resource identifiers use the `genome-portal-` prefix.

- **UI**: [Storage Browser for Amazon S3](https://ui.docs.amplify.aws/react/connected-components/storage/storage-browser) (customer-managed auth) behind an **Amazon Cognito** login, branded like the Transfer Family web app.
- **Access**: per-organisation S3 prefixes, read-only, credentials issued by **S3 Access Grants**.
- **Delivery**: first download of an object goes straight to S3, every later download goes through **CloudFront** (Pro flat-rate plan, OAC, signed URLs). Files over 1 GiB use a resumable Range split download in the browser: parts are kept durable in the origin-private file system and either merged into a file the user picks (Chrome/Edge, File System Access API) or, where that API is missing (Firefox 111+, Safari 17+, Brave), verified and handed to the browser's ordinary download (`docs/design-notes/2026-10-14_split_export_firefox_safari.md`). Browsers without OPFS get a plain download, or aria2c/curl commands above 50 GB.

Design documents (Korean): [`docs/spec/requirements.md`](docs/spec/requirements.md) and
[`docs/spec/design.md`](docs/spec/design.md). The `R#`, `N#`, `D#` and `§#` references in code, tests and docs point
into those two files. The design decisions and what the dev verification found are written up in the blog post
(Korean): [AWS PS Tech Blog](https://www.aws-ps-tech.kr/link/118), summarised in the [Blog post](#blog-post) section below.

> Reference implementation, verified end to end on a development account (`docs/acceptance.md`). Read the
> [security review](docs/security-review.md) and the [runbook](docs/runbook.md) before pointing it at real data, and
> note that the CloudFront flat-rate plan starts billing the moment its subscription is approved.

## Repository layout

| Path        | Contents                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `contract/` | Shared constants (thresholds, SSM names, table names) and API types. Single source of truth for infra, web and tools. |
| `infra/`    | AWS CDK app (7 stacks) and the Lambda handlers (`infra/lambda/`).                                                     |
| `web/`      | Vite + React SPA.                                                                                                     |
| `tools/`    | Admin CLI, seed and teardown scripts.                                                                                 |
| `docs/`     | Runbook, acceptance evidence, security review, requirements and design (`docs/spec/`).                                |

## Prerequisites

- Node.js 22 (`.nvmrc`), npm 10.
- AWS CLI **>= 2.23** (CRC32 checksums are full-object by default; the portal verifies downloads against them).
- AWS CDK CLI (installed as a dev dependency; use `npx cdk`).
- An AWS account with credentials for **ap-northeast-2** and **us-east-1**. Both regions must be bootstrapped:

```bash
npx -w infra cdk bootstrap aws://<ACCOUNT_ID>/ap-northeast-2
npx -w infra cdk bootstrap aws://<ACCOUNT_ID>/us-east-1
```

## Configuration

Deployment settings live in `infra/config/<env>.json` and are selected with `-c env=<env>` (default `dev`).

| Field                          | Required | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account`                      | no       | 12-digit account. Defaults to the deploying credentials. `-c account=...` overrides both.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `region`                       | no       | Regional resources region. Default `ap-northeast-2`. CloudFront/WAF pieces that must live in `us-east-1` are placed there automatically.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `dataBucketName`               | no       | Import an existing data bucket instead of creating `genome-portal-data-<account>-<region>`. Must be in `region`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `accessGrantsInstanceArn`      | no       | Import the account's existing S3 Access Grants instance (there is one per account and region). Omit to create it.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `uploaderPrincipalArns`        | no       | IAM principals allowed to write into the data bucket (the provider's upload pipeline). They also receive KMS `GenerateDataKey`/`Encrypt`.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `adminPrincipalArns`           | no       | Operator IAM roles exempt from the data bucket's "deny everything outside the portal" statement (read-only; no KMS encrypt). The account root and the Access Grants location role are always exempt.                                                                                                                                                                                                                                                                                                                                                                       |
| `mfaMode`                      | no       | `REQUIRED` (default) or `OPTIONAL` TOTP MFA.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `alertEmail`                   | yes      | Receives the CloudWatch alarm notifications.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `portalDomain`, `hostedZoneId` | no       | Custom domain for the portal (`<portalDomain>`) and the data distribution (`data.<portalDomain>`). Without it CloudFront uses its default domain and **the minimum TLS version cannot be enforced** (N2), so production deployments must set it.                                                                                                                                                                                                                                                                                                                           |
| `flatRatePlan`                 | no       | `{ "tier": "PRO" \| "BUSINESS" \| "PREMIUM", "usageLevel"?: "DEFAULT" \| "CF_PREMIUM_L2".."L7" }`. The `cdn` stack then subscribes the data distribution + its WAF Web ACL to the CloudFront flat-rate plan (`AWS::PricingPlanManager::Subscription`). Paid tiers are created **`PENDING_APPROVAL`** -- nothing is billed and the plan is not applied until an operator approves it (`docs/runbook.md` §1.2). Omit for pay-as-you-go. To change the tier later, change it in the console/CLI first, then update this field to match (CloudFormation rejects tier changes). |
| `brand`                        | yes      | `name`, `logoUrl`, `primaryColor` shown on the login page and header, plus optional `logoFile`: a local image (path relative to `infra/config/`) uploaded to the static bucket at `logoUrl` on every deploy. Without `logoFile`, `logoUrl` must be the SPA's built-in neutral `/brand/logo.svg` or an absolute `https://` URL (the config loader rejects a bucket path nothing serves). No customer name appears in any resource identifier; branding is runtime configuration only.                                                                                       |

## Build, test, synthesize

```bash
npm install
npm run lint          # eslint, all workspaces
npm run typecheck     # tsc --noEmit per workspace
npm test              # vitest per workspace (unit tests)
npm run synth         # cdk synth of all 7 stacks with a dummy account (no credentials needed), includes cdk-nag
```

## Deploy

Stack order matters. Deploy the whole app with

```bash
npm -w infra run deploy:dev
```

or stack by stack in this order:

1. `genome-portal-auth` -- Cognito.
2. `genome-portal-waf` -- WAF Web ACL in us-east-1 (the flat-rate plan requires one).
3. `genome-portal-cdn` -- data distribution, OAC, signing key group, log bucket, and (with `flatRatePlan` set) the flat-rate plan subscription. It references the data bucket **by name only**.
4. `genome-portal-cdn-logs` -- CloudFront standard logging v2 delivery (us-east-1). CloudWatch Logs only accepts CloudFront `ACCESS_LOGS` delivery sources in US East (N. Virginia), even when the destination bucket is in Seoul, so these three `AWS::Logs::Delivery*` resources live in their own us-east-1 stack.
5. `genome-portal-data` -- data bucket, KMS key, S3 Access Grants instance/location, DynamoDB, SSM settings. Its bucket and KMS policies need the distribution ARN, so it depends on `cdn`; making the dependency one-directional is what avoids the CloudFormation circular reference between the bucket policy and the distribution.
6. `genome-portal-api` -- HTTP API, JWT authorizer, Lambda handlers, IAM roles.
7. `genome-portal-web` -- SPA bucket, pay-as-you-go distribution (static assets + `/api/*` behaviour), `config.json`.
8. `genome-portal-ops` -- dashboard, alarms, daily metrics/grant-drift/audit-archive job.

If the very first `cdn` deployment is rejected because the data bucket does not exist yet, deploy `data` first with `-c skipCdnPolicy=true` (bucket and KMS policies without the CloudFront statements), then `cdn`, then `data` again without the flag.

With `flatRatePlan` in the config, the `cdn` deployment creates the CloudFront **Pro** plan subscription in `PENDING_APPROVAL` (outputs `FlatRatePlanSubscriptionArn`, `FlatRatePlanStatusAtDeploy`). Approve it in the CloudFront console (distribution -> Manage plan) or with `aws pricing-plan-manager approve-paid-subscription` -- billing starts at approval and cannot be reverted before the end of the billing month -- then share the distribution ID with the AWS account team; see `docs/runbook.md` §1. The data distribution must stay within the Pro feature set: managed cache / origin-request / response-headers policies only, OAC, standard logs (the data bucket's CORS rule is therefore `*`, so CloudFront's cached answer is valid for every viewer origin).

## Admin CLI, seed data, teardown

Day-2 operations (flat-rate plan, monthly review, alarms, cost formula) are in `docs/runbook.md`. This section covers the three tools in `tools/`.

### Admin CLI (`tools/admin.ts`)

The first-phase admin surface is a CLI that calls the portal's `/api/admin/*` routes through the web distribution (requirement R6.6, design §7.3). It signs in as a Cognito user in the `admins` group (SRP + TOTP) and caches the ID token in `~/.genome-portal/token.json` (mode 0600, ~60 min; you are asked to sign in again when it expires).

Setup:

```bash
cp tools/admin.config.example.json tools/admin.config.json   # local file, keep it out of git (`.gitignore`: tools/admin.config.json)
# fill in: userPoolId, clientId (auth stack outputs), region, portalUrl (web stack output PortalUrl)
npm run admin -- --help
```

Global options: `--config <path>` (use another config file), `--login` (ignore the cached token and sign in again).

| Command                                                                                                | Effect                                                                                                                             |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `npm run admin -- org create --id <orgId> --name "<name>"`                                             | Create an organisation                                                                                                             |
| `npm run admin -- org disable --id <orgId>`                                                            | Disable it (every user of the org gets 403)                                                                                        |
| `npm run admin -- location assign --org <orgId> --bucket <bucket> --prefix <prefix>/ [--label <text>]` | Assign an S3 prefix; creates the S3 Access Grant on first assignment (idempotent)                                                  |
| `npm run admin -- location unassign --org <orgId> --bucket <bucket> --prefix <prefix>/`                | Remove the assignment; the grant is deleted when no organisation uses the prefix any more                                          |
| `npm run admin -- location unassign --all [--yes]`                                                     | Remove every assignment and grant (teardown step 1)                                                                                |
| `npm run admin -- location list [--org <orgId>]`                                                       | Locations with their organisations and grant ids                                                                                   |
| `npm run admin -- user create --email <email> --org <orgId> --lang ko\|en`                             | Create a user; Cognito e-mails the temporary password                                                                              |
| `npm run admin -- user disable\|enable\|delete --email <email>`                                        | User lifecycle                                                                                                                     |
| `npm run admin -- count reset --bucket <bucket> --key <key>`                                           | Reset an object's download counter (next download goes to S3 again)                                                                |
| `npm run admin -- audit export --from YYYY-MM-DD --to YYYY-MM-DD --out file.csv`                       | Export audit events per UTC day into one CSV (`at,type,userSub,orgId,bucket,key,sizeBytes,path,mode,ip,country,downloadId,reason`) |

Prefixes must end with `/` and may not contain `..`, empty segments or `*`. HTTP errors are printed as `HTTP <status> <error> reason=<reason> - <message>`; exit code 2 for API errors, 3 when the token was rejected (sign in again with `--login`).

Adding an administrator: put the Cognito user into the `admins` group in the Cognito console. The CLI deliberately has no group command.

### Seed data (`tools/seed.sh`)

Creates pseudo-random sample files, uploads them with a full-object CRC32 checksum and wires up a `demo` organisation (requirement N8, design §7.4). It needs AWS CLI >= 2.23, `openssl`, free disk for the largest file, and `tools/admin.config.json` for the admin steps.

```bash
tools/seed.sh --bucket <data-bucket> \
  --prefix projects/DEMO-0001/ --sizes 1,12,53 \
  --ko-email demo-ko@example.org --en-email demo-en@example.org \
  [--region ap-northeast-2] [--work-dir /var/tmp] [--skip-admin] [--dry-run]
```

What it does, per size: `openssl enc -aes-256-ctr ... | head -c <bytes>` -> `aws s3 cp --checksum-algorithm CRC32` -> `aws s3api head-object --checksum-mode ENABLED` and fails unless `ChecksumType` is `FULL_OBJECT` (the browser verifies split downloads against that checksum). Then `org create demo`, two users (`--lang ko` / `en`), `location assign`, `location list`. `--dry-run` prints every command without touching AWS; `--skip-admin` uploads only.

### Teardown (`tools/teardown.sh`)

```bash
tools/teardown.sh --dry-run --env dev      # print the order, no AWS calls
tools/teardown.sh --env dev [--yes] [--skip-unassign]
```

Order: (1) `admin location unassign --all` (grants created at runtime block deletion of the Access Grants location/instance), (2) a prompt confirming that the CloudFront flat-rate plan on the data distribution is cancelled **and** the billing cycle has ended -- a subscribed distribution cannot be deleted, and cancellation of a paid plan only takes effect at the end of the cycle, so the script stops if the plan is still attached (the subscription is the `FlatRatePlan` resource of the `cdn` stack: cancel it in the console/CLI first; a never-approved `PENDING_APPROVAL` subscription is simply deleted with the stack), (3) `cdk destroy` per stack in reverse order `ops -> web -> api -> data -> cdn -> waf -> auth`, (4) printed instructions for the RETAINed resources that are never deleted automatically: the data bucket, the audit archive bucket, the CloudFront log bucket and the KMS key `alias/genome-portal-data`.

### Tests for the tools

```bash
npm run typecheck -w tools
npm test -w tools                         # argument parsing, CSV escaping, day-range expansion, pagination (mocked fetch), token cache
bash -n tools/seed.sh tools/teardown.sh   # shell syntax
```

## Blog post

The design is written up in Korean on the AWS PS Tech Blog:
[Storage Browser for S3와 CloudFront 정액제로 수백 GB 유전체 데이터 배포 포털 만들기](https://www.aws-ps-tech.kr/link/118). The post walks
through the problem, the architecture and each design decision with the browser and AWS mechanics behind it, and ends
with the measurements, the cost model and a glossary. In short:

- **Why not presigned URLs by e-mail.** A presigned URL is checked only when a request reaches S3, so a transfer that
  is already running survives expiry, but every reconnect after expiry fails. Repeat downloads are metered each time,
  and nobody can see who downloaded what.
- **Browse and permissions.** Storage Browser (customer-managed auth) shows the folders; S3 Access Grants computes the
  scope. One delivery location is one grant, and the Lambda functions hold no S3 permissions of their own, so every
  download leaves a `GetDataAccess` CloudTrail event carrying user, organisation and download id. A presigned URL
  signed with a one-object credential whose `DurationSeconds` equals the URL TTL expires exactly when the URL does.
- **Routing rule.** A DynamoDB `ADD` with `ReturnValues: ALL_OLD` decides "first download via S3, every later one via
  CloudFront"; the threshold is an SSM parameter (0 = everything via CloudFront). Bucket CORS is `AllowedOrigins: *`
  because the managed cache policy does not key on `Origin`, so the origin's answer must not depend on it.
- **Split downloads above 50 GB.** 8 GiB Range parts, four in parallel, written into OPFS through
  `FileSystemSyncAccessHandle` so that progress always equals the bytes durably on disk (the File System Access API
  writes to a swap file that only becomes the real file on `close()`). Browsers with `showSaveFilePicker` merge the
  parts into the chosen file; browsers without it (Firefox, Safari, Brave, iOS) hand the verified parts to the
  browser's own download through a service-worker stream or a Blob. Quota is probed with `truncate()`, not
  `estimate()`. Measured on the dev account: a 53 GiB object passed CloudFront as 7 parts (Miss 7/7 on the first pass,
  Hit 7/7 on the second) with a matching full-object CRC32.
- **zip is a bundle, not compression.** STORE mode, streamed through a service worker; CloudFront only ever sees
  per-file GETs. Cancellation must settle (client-zip never calls `return()` on the entry generator).
- **Flat-rate plan as code.** `AWS::PricingPlanManager::Subscription`. A paid tier is created `PENDING_APPROVAL`;
  approval is manual and cannot be undone until the billing cycle ends. Pro allows managed policies only, and Parquet
  log delivery is billed outside the plan.
- **Operations.** Standard logging v2 delivery resources live in us-east-1, every Parquet field is a string, ten alarms
  go to SNS, and the topic policy must explicitly allow CloudWatch to publish.
- **Cost.** Everything via CloudFront is $15/month at any volume; the only metered item is the first-download S3
  egress, kept as a lever for the 50 TB monthly allowance rather than as a saving.

## License

MIT-0. See [LICENSE](LICENSE).
