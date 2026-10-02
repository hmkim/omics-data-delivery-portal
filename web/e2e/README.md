# Genome portal e2e (Playwright) — M7

> Identifiers in this public copy (account id, CloudFront domains and distribution id, user pool id, e-mail
> addresses) are documentation placeholders; the measurements and dates are the real ones from the dev run.

Browser-level verification of the SPA against a **dev deployment** (the account and region of your `infra/config/<env>.json`):
split downloads with pause / resume / reload (T7.2), session keeping with a fake clock (T7.3), auth expiry
(T7.4), Firefox fallbacks (T7.5), CloudFront cache + zip (T7.6) and the N5 first-render measurement on
`projects/PERF-1000/` (T6.8 remainder). Requirements R1.5, R3.5, R4.9, R5.x; design §5, §10 "e2e".

```
web/playwright.config.ts          projects chromium / firefox, webServer, env handling
web/e2e/fixtures.ts               `creds` fixture (skips when the credentials file is missing)
web/e2e/helpers/auth.ts           signIn() through the Amplify Authenticator (ko)
web/e2e/helpers/portal.ts         Storage Browser / DownloadPanel / CommandDialog selectors
web/e2e/helpers/opfs.ts           pickFile hook, OPFS size + independent CRC32, IndexedDB split records
web/e2e/helpers/aws.ts            credential gate, AdminUserGlobalSignOut, Athena
web/e2e/helpers/cache.ts          R5.8 second-pass Hit check (shared by the test and the script)
web/e2e/helpers/zip.ts            zip central-directory reader (zip64) + file CRC32
web/e2e/tests/*.spec.ts           see the table below
web/e2e/scripts/athena-cache-check.ts   R5.8 check without re-downloading
web/e2e/scripts/cors-probe.sh           N4 / acceptance §3-6: CORS headers of the data distribution per viewer origin (curl)
```

Spec naming selects the browser: `*.chromium.spec.ts` runs only in the chromium project, `*.firefox.spec.ts`
only in firefox, everything else in both.

| Spec                              | Task        | Browser  | Needs sign-in | Needs AWS creds                  | Cost / duration                        |
| --------------------------------- | ----------- | -------- | ------------- | -------------------------------- | -------------------------------------- |
| `smoke.spec.ts`                   | T7.1        | both     | no            | no                               | seconds                                |
| `helpers.spec.ts`                 | T7.1        | both     | no            | no                               | seconds (self-test of the instruments) |
| `perf-1000.spec.ts`               | T7.1 / T6.8 | both     | yes           | no                               | ~30 s                                  |
| `split.chromium.spec.ts`          | T7.2        | chromium | yes           | no                               | 12 GiB once ≈ $1, 3–8 min              |
| `session.chromium.spec.ts`        | T7.3        | chromium | yes           | no                               | 12 GiB once ≈ $1, 3–8 min              |
| `session-expiry.chromium.spec.ts` | T7.4        | chromium | yes           | **yes** (AdminUserGlobalSignOut) | 12 GiB once ≈ $1, 3–8 min              |
| `firefox.firefox.spec.ts`         | T7.5        | firefox  | yes           | no                               | seconds (downloads are cancelled)      |
| `cache-zip.chromium.spec.ts`      | T7.6        | chromium | yes           | Athena + copy-object: **yes**    | 12 GiB ×2–3 ≈ $2–3, 6–15 min (+Athena) |

## Prerequisites

- Node 22, `npm install` at the repo root (installs `@playwright/test` 1.63 and the AWS SDK clients).
- Browsers: `npx playwright install chromium firefox` (no `install-deps`; the required system libraries are
  already present on the cloud desktop). Chromium 153 / Firefox 155 both launch there.
- `web/dev-config.json` (gitignored): copy `web/dev-config.example.json` and fill in the dev values — the simplest
  way is the deployed portal's own `https://<portal>/config.json`.
- The portal test user's credentials file: **line 1 e-mail, line 2 password, `chmod 600`**. The default path is the
  demo user's file on this host (`DEFAULT_CREDENTIALS_FILE` in `playwright.config.ts`); point `E2E_CREDENTIALS_FILE`
  elsewhere if needed. `tools/e2e_reset_test_user.py` (needs dev AWS credentials) rotates the demo user's password and
  writes the file to `~/.cache/genome-portal-e2e/user-login.txt` — use that path via `E2E_CREDENTIALS_FILE` on an
  agent host whose session scratch is reclaimed between runtimes. Only the Playwright process reads it (`helpers/auth.ts#readCredentials`); nothing prints it and
  Playwright traces redact `type=password` fields. Never commit it. Without the file, every signed-in test is
  **skipped** with the reason (`E2E_REQUIRE_CREDENTIALS=1` makes that a failure for CI).
- The user must have no TOTP set up (pool MFA is OPTIONAL); `signIn()` fails with a clear message otherwise.
- Admin prerequisites (done once by an operator, not by the suite): `projects/PERF-1000/` (1,000 × 1 KiB) assigned
  to org `demo`; `projects/DEMO-0001/sample-{1,12,53}gib.bin` with FULL_OBJECT CRC32 checksums.

## Running

```sh
# everything (chromium + firefox); dev server is started automatically, /api proxied to the dev portal
npm run e2e -w web
npm run e2e:chromium -w web            # chromium only
npm run e2e:firefox -w web             # firefox only
npx playwright test split --project=chromium          # one spec (run from web/)
npm run e2e:report -w web              # open the HTML report of the last run
```

Environment variables are documented at the top of `web/playwright.config.ts`. The important ones:

| Variable                    | Default                                 | Purpose                                                                                                                                     |
| --------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `E2E_BASE_URL`              | `http://localhost:5173`                 | Run against the deployed portal instead (`https://d111111abcdef8.cloudfront.net`); no dev server is started then.                           |
| `E2E_API_ORIGIN`            | `https://d111111abcdef8.cloudfront.net` | Origin the Vite dev server proxies `/api/*` to (CloudFront adds `x-origin-verify`).                                                         |
| `E2E_CREDENTIALS_FILE`      | demo user's file                        | Portal test user (see above).                                                                                                               |
| `E2E_OUTPUT_DIR`            | `web/e2e/test-results`                  | Report, traces, `results.json`, `cache-passes.json`, downloaded zips (2 GiB for the zip test → keep it on disk).                            |
| `TMPDIR`                    | OS default                              | Chromium profile + OPFS swap file live here. Needs ≥ 30 GB free (≥ 120 GB for `sample-53gib.bin`); a small tmpfs is refused before the run. |
| `E2E_TMP_MIN_GB`            | `30` / `120`                            | Free-space threshold of the `os.tmpdir()` check above.                                                                                      |
| `E2E_BIG_FILE`              | `sample-12gib.bin`                      | Object for the cache test. `sample-53gib.bin` costs ≈ $5–6 per pass — set it only deliberately.                                             |
| `E2E_ATHENA_WAIT_MIN`       | `20`                                    | How long the in-suite Athena check waits for log rows (logs arrive 5–60 min after the requests).                                            |
| `E2E_CACHE_PASSES_FILE`     | `<output>/cache-passes.json`            | Where the cache test records its passes / where the Athena check reads them.                                                                |
| `E2E_SKIP_FIREFOX=1`        | —                                       | Drop the firefox project on a host that cannot launch Firefox (report the missing library instead).                                         |
| `E2E_REQUIRE_CREDENTIALS=1` | —                                       | Fail instead of skip when the credentials file is missing.                                                                                  |

Running against the deployed portal (`E2E_BASE_URL=https://…`) requires the SPA **with the test hook** to be deployed
(commit `e2e:` series, `web/src/download/planner.ts#pickSaveFile`); the dev portal has carried it since the
2026-09-28 13:25 UTC web deploy.

Output of one run: `<output>/results.json` (per-test status + skip reasons), `<output>/playwright-report/`, traces for
failures under `<output>/test-results/`. Measured numbers are printed as `[e2e-metric] name = value` lines.

## What each test measures / asserts

- **PERF-1000** — `performance.now()` right before the location button is clicked → the first animation frame that
  shows ≥ 100 file rows (rows with the portal `방식` column). Cold context (fresh profile per test). Asserts < 2 s in
  Chromium (N5); Firefox is informational (`expect.soft`).
- **T7.2 split** — badge `분할·이어받기`; `POST /downloads` → `mode: split`, `checksumCrc32 /sXQ3A==`; the plan in
  IndexedDB is `[0, 8 GiB−1]`, `[8 GiB, 12 GiB−1]`; pause at ≥ 5 % (progress frozen for 3 s, reason USER); resume;
  reload at ≥ +10 % → record comes back `paused / NETWORK` with progress kept (−2 % tolerance = in-flight chunks);
  resume → `verifying` → `complete` with toasts; then an **independent** CRC32 of the OPFS file (plain JS, not the
  SPA's hash-wasm) must equal `/sXQ3A==`. The 1 GiB row: no badge, browser `download` event, cancelled.
- **T7.3 session** — see the fake-clock section. Asserts: renew request `Authorization` differs from the issue
  request's and has a later `exp`; Cognito `InitiateAuth` (REFRESH_TOKEN_AUTH) seen during the jump; no sign-in form;
  `data-renew-count ≥ 1`; download completes with matching CRC32; after `fastForward(61 min)` post-completion the
  sign-in form and the banner `60분 동안 조작이 없어 로그아웃되었습니다` appear and Cognito `RevokeToken` is called.
- **T7.4 auth expiry** — after `AdminUserGlobalSignOut` the clock jumps 65 min so the renew forces a token refresh
  → `paused / AUTH_EXPIRED` in IndexedDB (not `failed`), banner `세션이 끝났습니다…`, sign-in form; re-login shows the
  row with `재개` and the AUTH_EXPIRED reason; resume → complete → CRC32.
- **T7.5 Firefox** — 12 GiB: empty badge, R5.9 toast, `download` event (cancelled); 53 GiB: badge `명령어 다운로드`,
  dialog with exactly `aria2c -x 4 -s 4 -k 8G --file-allocation=none -o "sample-53gib.bin" "<url>"` and
  `curl -L -C - -o "sample-53gib.bin" "<url>"`, URL https / path `/projects/DEMO-0001/sample-53gib.bin` / signed query,
  host `*.cloudfront.net` (CF) or the bucket's S3 host; copy button → `복사됨`, clipboard read back (Firefox prefs
  `dom.events.testing.asyncClipboard` in the config).
- **T7.6 cache** — up to three UI downloads of `E2E_BIG_FILE` until two `path: CF` passes are complete (cf-threshold is
  1, so at most the first is S3); each pass CRC32-checked, panel entry removed and OPFS file deleted between passes;
  windows written to `cache-passes.json`. The Athena test (gated) queries
  `"genome-portal-logs"."genome-portal-cf-access-logs"` for the second window and requires
  `x_edge_result_type = 'Hit'` on every row.
- **T7.6 zip** — `sample-1gib.bin` + `sample-53gib.bin` → alert `개별 다운로드 필요(단일 객체 한도 초과): sample-53gib.bin`,
  summary `1개 파일, 1.0 GiB`. With `sample-1gib-copy.bin` present (gated): both 1 GiB files zipped, two
  `POST /downloads`, zip central directory lists both entries with size 1 GiB and CRC32 `44SoTA==`.

## How the fake clock interacts with Amplify (T7.3 / T7.4)

`page.clock.install()` (before the first navigation) replaces `Date`, `setTimeout`, `setInterval`, `performance` and
friends in the page. The clock keeps ticking with real time, so the transfer, React and the workers run normally.
`page.clock.fastForward('65:00')` jumps the page's time by 65 minutes and fires every timer that became due **once**:

1. `SessionManager.check()` (1-minute `setInterval`) runs once, sees idle ≥ 60 min but `activeDownloads > 0` and
   does nothing (R1.5 "no sign-out while a download runs").
2. The split engine's renew timer (`expiresAt − 5 min`, i.e. ≈ 55 min after issue) fires → `POST /downloads/{id}/renew`.
3. Amplify's `fetchAuthSession()` compares the cached ID token's `exp` with the faked `Date.now()`: 65 min > the 1-hour
   token lifetime, so it refreshes through the refresh token (Cognito `InitiateAuth` REFRESH_TOKEN_AUTH) before the
   renew request — that is why the `Authorization` header changes. Amplify's clock-drift compensation is computed at
   sign-in from `iat − Date.now()`; because the clock was installed before sign-in the drift is ≈ 0 and the expiry check
   behaves as in production. After the jump every API call refreshes again (the fake time stays ahead of any real
   token's `exp`), which is harmless.
4. After completion `decrementActiveDownloads()` resets `lastActivity` to the (fake) now; `fastForward('61:00')` fires
   the check once more → idle ≥ 60 min and no active download → `signOut()` → `RevokeToken`, banner, sign-in form.

Only the page's timers are faked: the real presigned/CloudFront URL is still valid (the renew simply issues a fresh one),
and the download workers use the real clock. In T7.4 the same jump is what turns the revoked refresh token into
`AuthExpiredError`: without it Amplify would keep using the still-valid ID token until its real expiry (~1 h).

Fake-clock caveat: `performance.now()` is faked too, so PERF-1000 must never install the clock (it does not).

## Credential-gated tests — what to run once AWS credentials are back

All of them skip cleanly with the reason when `aws sts get-caller-identity` fails **or resolves to another account**
(credentials for a different account do not count: the tests compare the caller's account with `DEV.accountId` in `e2e/helpers/env.ts`).

```sh
cd web
# T7.4 — needs cognito-idp:AdminUserGlobalSignOut on ap-northeast-2_EXAMPLE
npx playwright test session-expiry --project=chromium

# T7.6 Athena (R5.8) — needs athena:* on work group genome-portal-ops + s3 on the athena results bucket
#   (a) full run: two CF passes (≈ $2) then the Athena check, waiting up to E2E_ATHENA_WAIT_MIN for logs
npx playwright test cache-zip --project=chromium --grep "CloudFront"
#   (b) only the Athena check against passes recorded earlier (no download)
npm run e2e:athena-check -w web -- --passes <E2E_OUTPUT_DIR>/cache-passes.json --wait-min 45

# T7.6 zip — create the second 1 GiB object first (server-side copy, then verify the checksum survived)
aws s3api copy-object --bucket genome-portal-data-123456789012-ap-northeast-2 \
  --copy-source genome-portal-data-123456789012-ap-northeast-2/projects/DEMO-0001/sample-1gib.bin \
  --key projects/DEMO-0001/sample-1gib-copy.bin --checksum-algorithm CRC32 --metadata-directive COPY \
  --region ap-northeast-2
aws s3api head-object --bucket genome-portal-data-123456789012-ap-northeast-2 \
  --key projects/DEMO-0001/sample-1gib-copy.bin --checksum-mode ENABLED --region ap-northeast-2
#   → ChecksumCRC32 must be 44SoTA== with ChecksumType FULL_OBJECT. copy-object of a multipart-uploaded source may
#     not carry a full-object checksum; then re-upload with `npx tsx tools/upload.ts` (`tools/upload.ts`, verifies FULL_OBJECT CRC32) instead.
npx playwright test cache-zip --project=chromium --grep "two 1 GiB"
```

## Cost and duration notes

- Every 12 GiB pass ≈ $1 (CloudFront or S3 egress), 53 GiB ≈ $5–6 (56.9 GB × CloudFront Korea list rate; the
  account's always-free 1 TB/month CloudFront tier may absorb it). Measured 2026-09-29: a 53 GiB CloudFront pass
  takes ≈ 17.5–18.5 min end to end on the cloud desktop (≈ 4 min of Range fetches, then OPFS merge + CRC32), so the
  two-pass cache test runs ≈ 44 min; `E2E_BIG_FILE=sample-53gib.bin` sets a 100 min test timeout and 40 min per pass.
  A full chromium run downloads 12 GiB
  3–5 times (T7.2, T7.3, T7.4, T7.6 ×2–3): ≈ $4–6 and 20–40 minutes on the cloud desktop (a few hundred MB/s).
  Firefox and PERF-1000 cancel their downloads immediately. Nothing loops large downloads; the cache test stops after
  two CF passes (three attempts maximum).
- The OPFS data lives in the browser profile under `TMPDIR` and disappears with the context. Plan ≥ 2 × the largest
  file there: the split engine keeps its part files in OPFS (`genome-portal-splits/<downloadId>/`, deleted after the
  merge) and the test's pick-file hook puts the destination in OPFS as well. `/tmp` is a 16 GiB tmpfs on the cloud
  desktop — use `TMPDIR=$HOME/.cache/genome-portal-e2e-tmp`.
- `scripts/probe-opfs-quota.mjs` prints what `navigator.storage.estimate()` reports versus the OPFS size that can
  actually be reserved in such a profile (2026-09-29: 10 GiB reported, > 160 GiB enforced). The engine's storage
  choice uses a `truncate()` reservation probe for that reason; the scenario-5 test asserts `data-storage="opfs"`.
- Run the split/cache specs against the **deployed** portal (`E2E_BASE_URL=https://<portal>`) at least once: the
  data distribution's CORS defect (acceptance §3-6) was invisible from the Vite dev origin. `scripts/cors-probe.sh`
  is the quick check: it must print `access-control-allow-origin: *` for the portal origin, a foreign origin and no
  `Origin` header, on `Miss` and `Hit` alike. The distribution runs on managed policies only (Pro flat-rate plan),
  so that uniformity comes from the data bucket's `*` CORS rule, not from CloudFront.
- Global timeout per test 5 min; the split tests raise it to 20–25 min; the Athena test to `E2E_ATHENA_WAIT_MIN + 5`.

## T7.7 (CI)

Not part of this suite. Pending operator decision GitHub Actions vs CodeBuild; the suite already runs headless with
`E2E_REQUIRE_CREDENTIALS=1` and `E2E_OUTPUT_DIR` for artifacts.
