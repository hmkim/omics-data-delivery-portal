# Acceptance (T8.1) — requirements §9 scenarios on dev

> Identifiers in this public copy (account id, CloudFront domains and distribution id, user pool id, e-mail
> addresses) are documentation placeholders; the measurements and dates are the real ones from the dev run.

Account 123456789012, `ap-northeast-2`, portal `https://d111111abcdef8.cloudfront.net`, data distribution
`EDFDVBD6EXAMPLE`. Evidence dates: 2026-09-28 (UTC). Sources: the integration suite (`INTEG=1 npm test -w infra`,
commit `72d3988`), the Playwright suite (`web/e2e`, commits `9f1585b`…`e7c617f`), CloudTrail, Athena
(`genome-portal-logs`), CloudWatch alarm history. No file **contents** are recorded anywhere below (N9): only keys,
sizes and checksums.

Fixtures: `projects/DEMO-0001/sample-{1,12,53}gib.bin` (+ `sample-1gib-copy.bin`), all `FULL_OBJECT` CRC32
(`44SoTA==`, `/sXQ3A==`, `/yAtGQ==`); org `demo` → `DEMO-0001/`, `PERF-1000/` (1,000 × 1 KiB); orgs `integ-a/b`
with `INTEG-A/`, `INTEG-B/`. The 150 GB object of scenarios 4 and 9 is stood in for by 53 GiB (largest fixture; the
19-part / 4-parallel plan for 150 GB is covered by the planner unit test `splitEngine.test.ts` "150 GiB → 19 parts").

**Result: 10 of 11 scenarios pass. Scenario 5 (resume after the tab was closed mid-transfer) FAILS with a data-loss
defect — see §5.** T8.1 therefore stays open until the fix lands.

## 1. Scenario table

| #   | Scenario (requirements §9)                                                                                     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Result                                 |
| --- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1   | Admin creates org + user, assigns a prefix → the user sees only that location                                  | T6.1/T6.6: `POST /api/admin/orgs`, `.../users`, `.../locations` create org `integ-a`, users, assignment + one Access Grant (`list-access-grants`: `READ` on `projects/INTEG-A/*`). `GET /api/locations` as the demo user returns exactly the two `demo` locations (`DEMO-0001/`, `PERF-1000/`), integ-a sees `INTEG-A/` (+ `PERF-1000/`) and not `INTEG-B/`. e2e smoke/perf: LocationsView lists 2 rows for demo; first render of the 1,000-object listing 1,045 ms (Chromium) / 1,059 ms (Firefox) < 2 s.                                                                                                                                                                                                                                                                                         | Pass                                   |
| 2   | Chrome, 12 GB, first download → S3 URL, save-location dialog, split 8 GB×2, row "1회 · 다음: CloudFront"       | T6.4: first `POST /downloads` on a fresh object → `path=S3`, `count=1`, `nextPath=CF`; T2.9 smoke: S3 Range 206. e2e T7.2 (1 GiB → ordinary download, no badge, 5.3 s) and the 12 GiB split start: `mode=split`, 2 parts, save-picker hook invoked, panel `data-parts="2"`, 160 MiB/s on the desktop; row status columns read back count / next path (`waitForRowStatus`).                                                                                                                                                                                                                                                                                                                                                                                                                         | Pass                                   |
| 3   | Second user, same file → CloudFront signed URL, toast, row "2회"; third → cache hit                            | T6.4: second issue → `path=CF`, `count=2`; two concurrent issues on a fresh object → exactly one `S3`. e2e T7.6: two CloudFront passes of 12 GiB (`cache-passes.json`, 13:52–13:57 UTC), CRC32 `/sXQ3A==` both; Athena on `genome-portal-cf-access-logs` for the second pass: `x_edge_result_type = {"Hit": 2}` (both 8 GiB / 4 GiB part ranges), no S3 origin fetch. Toast text `table.pathCF` / `toast.viaCF` rendered (unit + e2e). 53 GiB (56.9 GB, above the 50 GB single-object limit) repeated on 2026-09-29 (`cache-passes-53gib.json`, 05:09–05:49 UTC): pass 1 `Miss` on all 7 Range parts (CloudFront fetched each 8 GiB part from the origin), pass 2 `Hit` 7/7, CRC32 `/yAtGQ==` both — the R5 premise that > 50 GB objects flow through CloudFront as 8 GiB parts holds in practice. | Pass                                   |
| 4   | 150 GB in Chrome → auto split (19×8 GB, 4 parallel), URL renew mid-transfer, CRC32 shown; Safari → aria2c/curl | Planner: `planParts(150 GB)` = 19 parts, concurrency 4 (unit). Renew mid-transfer: e2e T7.3 forces the renew timer (`expiresAt−5 min`) → `POST /downloads/{id}/renew` 200 with a refreshed ID token; T6.4 renew keeps the path. CRC32 verified and displayed after every completed split (T7.3, T7.4, T7.6: `/sXQ3A==`). Firefox (stands in for Safari — no File System Access): 53 GiB → `명령어로 다운로드` dialog with valid `aria2c`/`curl` strings against `d222222abcdef8.cloudfront.net`, copy button works, row badge `명령어 다운로드`.                                                                                                                                                                                                                                                   | Pass (150 GB by planner test + 53 GiB) |
| 5   | Close the tab during a split download, revisit → completed parts skipped, resume                               | **PASS (2026-09-29 00:2x UTC, after D7).** e2e T7.2 on the deployed portal, 12 GiB via CloudFront, `storage=opfs`: pause at 5 % (3.3 s) → resume → reload at 17 % (2,302,019,106 B persisted) → record restored as `paused/INTERRUPTED` with **exactly 2,302,019,106 B** (no rollback; part files ≥ progress) → resume → remaining parts 77.1 s → merge of the 2 part files into the destination 95.9 s → SPA CRC32 59.1 s → `complete`; independent CRC32 of the saved file `/sXQ3A==` (matches the seed); part directory deleted. Before D7 the same run ended `failed / CHECKSUM_MISMATCH` (got `ST+XWA==`), see §5.                                                                                                                                                                            |
| 6   | User calls another org's key directly → 403, audit event                                                       | T6.3: `List`/`Get` on `projects/INTEG-B/` with integ-a credentials → `AccessDenied`; `POST /downloads` for a key outside the org → 403 `NOT_ASSIGNED`/`NO_GRANT`; `audit-events` row `ACCESS_DENIED` with user, org, key; `AccessDenied` metric → alarm `genome-portal-access-denied-5min` (threshold 50/5 min).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Pass                                   |
| 7   | Admin resets the object's count → next download is S3 again                                                    | T6.4: `POST /api/admin/objects/reset` → count 0 → next issue `path=S3`; `cf-threshold=0` → every issue `CF`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Pass                                   |
| 8   | Monthly CloudFront transfer passes 25 TB → "50 % of allowance" alert                                           | Alarms `genome-portal-usage-allowance-{50,80,100,200}pct` on `UsageAllowancePct` (opsDaily, 24 h period, `notBreaching`). Notification path exercised with `set-alarm-state` on the 50 % alarm: **first attempt failed** ("CloudWatch Alarms is not authorized to perform: SNS:Publish", also at 05:08 UTC after deploy) → topic policy fixed (`1198bfe`, ops redeployed 13:59 UTC) → 14:03:57 UTC "Successfully executed action … genome-portal-alerts", e-mail to the subscribed address. Alarm reset to OK.                                                                                                                                                                                                                                                                                     | Pass (after fix)                       |
| 9   | 150 GB split, 3 h idle → session kept, hourly URL renew, completes; 60 min idle after → sign-out               | e2e T7.3 (12 GiB, fake clock): `+01:05:00` idle during the transfer → no sign-out, renew 200, ID token refreshed (`GetTokensFromRefreshToken`, jti changed), transfer completes (79 s after the jump), CRC32 OK; `+01:01:00` idle after completion → `signOut()` (`RevokeToken`) and the sign-in form.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Pass                                   |
| 10  | Safari, 12 GB → ordinary download + "이어받기 미지원" notice, no row badge (Chrome shows "분할·이어받기")      | e2e T7.5 (Firefox): 12 GiB → browser download started (then cancelled by the test), toast R5.9 shown, `방식` badge empty; Chromium row for the same object shows `분할·이어받기` (T7.2/T7.6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Pass                                   |
| 11  | Admin disables the user mid-download → paused (not failed) at the next renew; re-login → resume                | e2e T7.4: `AdminUserGlobalSignOut` during the split → the client's refresh fails, the row goes `paused / AUTH_EXPIRED` (no failure state), sign-in form within 0.5 s → re-login → resume offered → completes in 108 s, CRC32 `/sXQ3A==`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Pass                                   |

## 2. Cross-cutting measurements

| Measurement                             | Value                                                                                                                                                                                                                                                                                        |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /downloads` latency (T6.8, 200×)  | p50 ≈ 200 ms, p95 298 ms (< 500 ms)                                                                                                                                                                                                                                                          |
| `GetDataAccess` 12 h credentials (T6.2) | `expiresAt − now` = 43,200.2 s from Lambda (no role-chaining cap)                                                                                                                                                                                                                            |
| URL lifetime (T6.5)                     | 3,599.6–3,599.9 s at TTL 3,600; 403 15 s after a 900 s TTL, S3 and CloudFront alike                                                                                                                                                                                                          |
| CloudTrail `GetDataAccess` (T6.7)       | `auditContext = user=…;org=…;dl=<downloadId>`, visible after 122 s                                                                                                                                                                                                                           |
| Split throughput, desktop → CloudFront  | 160 MiB/s (12 GiB in ~80 s); S3 direct pass 189 s while another download ran                                                                                                                                                                                                                 |
| CloudFront cache                        | second pass all `Hit` (Athena), 95.7 s                                                                                                                                                                                                                                                       |
| CloudFront cache, 53 GiB (> 50 GB)      | 7 × 8 GiB Range parts; pass 1 `Miss` 7/7 (origin fetch), pass 2 `Hit` 7/7, 56.9 GB served per pass; 1,052 s / 1,095 s end to end incl. OPFS merge + CRC32 `/yAtGQ==` (2026-09-29, `docs/evidence/cache-passes-53gib.json`, Athena breakdown in `docs/evidence/cache53-athena-breakdown.sql`) |
| zip of 2 × 1 GiB (SW streaming)         | 19.8 s, entries with correct sizes and CRC32; 53 GiB item excluded with R4.9 message                                                                                                                                                                                                         |

## 3. Defects found and fixed during acceptance (all in `main`)

1. Split engine: a rejected write left the record `running` forever (`2a33988`).
2. Alerts topic: CloudWatch alarms could not publish (`1198bfe`) — scenario 8 would have been silent.
3. zip: the service-worker download was started with an `<a download>` click, which Chromium routes past the
   service worker when the page is outside the SW scope; the "zip" saved was the SPA's `index.html`. Fixed with a
   hidden iframe navigation (`e7c617f`).
4. CloudFront log analytics: parquet columns are strings (Glue schema + `try_cast`, `6cfd63e`).
5. Split engine, scenario 5: progress persisted ahead of the destination's swap-file commit → corrupt resume after a
   reload. Redesigned per D7 (§5, `96ef2bc`).
6. Data distribution CORS: the managed `CORS-With-Preflight` policy does **not** override origin headers, and S3 answers
   with the requesting origin (`Access-Control-Allow-Origin: http://localhost:5173` from the dev-server runs) while
   `CachingOptimized` keeps `Origin` out of the cache key — so the cached response was served to the portal origin and
   every Range fetch from the deployed portal failed (`net::ERR_FAILED`, "Failed to fetch"). All earlier browser runs
   had been made from `localhost:5173`, which happened to be the cached origin. Fixed with a custom response headers
   policy (`*`, `OriginOverride: true`, S3's `Access-Control-Allow-Credentials` removed), applied to cache hits too —
   verified with `curl -H Origin:<portal>` on a `Hit from cloudfront` response (`96ef2bc`).
   **Superseded 2026-09-29 (T1.6b):** custom response headers policies are a Business+ feature, so the Pro plan
   subscription would have been rejected (N4). The distribution is back on the managed `CORS-With-Preflight` policy and
   the data bucket's CORS rule is `AllowedOrigins: *`, so S3's answer — and therefore CloudFront's cached copy — is the
   same for every viewer origin. Re-verified after a `/*` invalidation with `web/e2e/scripts/cors-probe.sh`: portal
   origin, a foreign origin and no `Origin` header all get `access-control-allow-origin: *` (no `Allow-Credentials`) on
   both `Miss` and `Hit from cloudfront`. `OPTIONS` preflight to the data distribution returns 403 (S3 rejects it
   without the forwarded CORS request headers) — unchanged from before and not on any browser path: the split worker
   only sends `Range`, which is CORS-safelisted, so Chromium never preflights.
7. Split engine: resuming 1–2 s after a reload failed with `NoModificationAllowedError` ("another open Access Handle")
   because the previous page's workers still held the part-file locks; the worker now retries the handle open with
   backoff (≈ 6 s) before reporting `FILE_ERROR`.
8. **Header logo broken (user report 2026-10-01).** `config.json` pointed at `/brand/logo.svg` but nothing had ever
   been deployed at that key — design §5.5 said "uploaded to `/brand/` at deploy time" and no deploy step existed — so
   the static bucket answered 403 and the header showed the broken-image glyph plus the alt text. Fixed three ways:
   the SPA ships a neutral default `web/public/brand/logo.svg` (so the default URL resolves), `infra/config/<env>.json`
   gained `brand.logoFile` (uploaded to `brand.logoUrl` as a third `BucketDeployment` source, binary-safe via a
   content-addressed staging dir; `loadConfig` rejects a site-relative `logoUrl` that nothing serves), and the header
   hides the image on `onError` instead of rendering a broken one.
9. **zip Cancel left the panel in "zip 생성 중" (user report 2026-10-01, 1 GiB zip).** Two defects with the same
   symptom. (a) `cancel()` aborts the `AbortController`; the fetch body errors and the zip stream handed to the
   service worker errors too (the browser's download fails), but `runZip` awaited a promise resolved only in the
   entries generator's `finally` — and client-zip wraps that generator in an iterator **without** `return()`, so the
   generator stayed suspended at its `yield` and the promise never settled. Fixed in `zip.ts`: settle on the abort
   signal as well and close the generator explicitly. (b) Found by repeating the cancel on the deployed build after
   (a) — still stuck in about half of the runs: a chunk already queued in the counting transform reported progress
   _after_ `runZip` had resolved `cancelled`; React batched that late `running` update behind `done` and the last
   write won. Fixed twice over: `runZip` stops reporting once aborted, and the view applies progress through a
   functional updater that only touches a running phase. A dedicated `zip.cancelled` message now says the browser's
   download list shows the zip as failed. Regression tests: `zip.test.ts` (fake SW container, abort mid-stream, no
   report after abort) and `PortalDownloadView.test.tsx` (late report after a cancelled outcome); e2e
   `zip-cancel.chromium.spec.ts` against the deployed portal.
10. Review finding (same session): the locations table showed the data **bucket name**, which embeds the AWS account
    id, to customer users; every organisation sees exactly one bucket so the column carried no information. The
    column is dropped in `PortalDataTable` (`withoutBucketColumn`). The account id still appears in the public
    `config.json` (`accountId`, needed by the Storage Browser adapter) — low sensitivity, noted in the security review.

## 4. Environment notes for re-running

- Playwright must use a **persistent** Chromium profile (`web/e2e/fixtures.ts`): incognito contexts keep OPFS in
  memory with a RAM-sized quota, so every ≥ 1 GiB split write failed with `QuotaExceededError`.
- `TMPDIR` needs ≥ 2 × the largest file (OPFS part files + the destination, both in the profile for the test's
  pick-file hook); the 16 GiB tmpfs `/tmp` is refused — the runs above used `~/.cache/genome-portal-e2e-tmp`.
- `navigator.storage.estimate()` in this Chromium profile reports a **10 GiB** quota while truncating an OPFS file
  succeeds up to > 160 GiB (`web/e2e/scripts/probe-opfs-quota.mjs`); the engine therefore reserves the size with a
  quota-enforced `truncate()` probe instead of trusting the estimate.
- Run against the deployed portal (`E2E_BASE_URL`), not only the Vite dev server: defect 6 was invisible from
  `localhost:5173`.
- The test user's 0600 credentials file lives in `~/.cache/genome-portal-e2e/` (`tools/e2e_reset_test_user.py`
  rotates the password and rewrites it); the session scratch it used to live in is reclaimed with each runtime.
- Vended `Admin` sessions on this account last 1 h regardless of the requested duration; the credential-gated tests
  (T7.4, Athena) skip with the re-run command when the session has expired.

## 5. Scenario 5 (T7.2 resume after an unclean stop) — root cause and resolution

**Root cause (found 2026-09-28).** `FileSystemWritableFileStream` writes go to a **swap file** and reach the real file
only when `close()` succeeds (File System Access spec; Chromium `.crswap`). The engine held one writable per session
and committed it only on pause/complete, but persisted per-part `receivedBytes` to IndexedDB after every chunk. After
a reload (no `close()`) the record claimed 17 % while the file held the 5 % committed at the last pause; resuming from
17 % left a hole → CRC32 mismatch. A clean pause → resume (both with `close()`) was correct, which is why T7.3/T7.4
passed through their pauses.

**Decision D7 (user, 2026-09-29): plan A with plan C as fallback.** Options considered — A durable OPFS part files +
one merge; B `close()` at every part boundary (Chromium copies the whole file into the new swap on
`keepExistingData: true` → ≈ 1.4 TB of local I/O for 150 GB, rejected); C honest progress only (resume from the last
committed byte; loses everything since the last explicit pause after an unclean stop).

**Implementation (design §5.4, `web/src/download/{partStorage,splitEngine,splitWorker,store}.ts`).**

- `storage: 'opfs'` (default): each part worker owns a `FileSystemSyncAccessHandle` on
  `genome-portal-splits/<downloadId>/part-NNNN`, writes in place and `flush()`es every 64 MiB, then reports the
  durable byte count; the engine's persisted progress is that report, so IndexedDB can never run ahead of the disk.
  When every part is complete a new `merging` phase streams the part files into the destination
  (`createWritable({ keepExistingData: false })` → one `close()`), deletes them, then verifies. `load()` turns a record
  left `running`/`merging` into `paused/INTERRUPTED` **without** rolling progress back; resume reconciles the record
  against the part files (a shorter/missing part is re-received and the user is told how much, `reconciled`) and the
  worker truncates any unacknowledged tail. A pause or interruption during the merge keeps the part files and the
  resume merges again without re-downloading.
- `storage: 'direct'` (fallback, chosen up front when OPFS is missing or `navigator.storage.estimate()` shows less than
  file size + 256 MiB free — incognito windows, small system drives): the previous write path, now with
  `committedBytes` tracked per part on every successful `close()`. After an unclean stop `load()` rolls
  `receivedBytes` back to it, so the resume is always correct but re-receives data since the last pause; the start
  toast says so (`storage-fallback`). Legacy records without the new fields load as `direct` with `committedBytes =
receivedBytes`.
- Runtime switch: an OPFS write that throws `QuotaExceededError` pauses the download with `STORAGE_QUOTA`; resuming
  copies the durable part bytes into the destination (one `close()`), flips the record to `direct` (`migrated`) and
  continues.
- UI: `data-storage` on the row, "파일 병합 중" status + merge percentage, storage-specific disk hint (R5.7), reasons
  `INTERRUPTED` / `STORAGE_QUOTA`.

**Unit evidence (`web/`, 96 tests).** `splitEngine.test.ts` (28): scenario-5 shape in OPFS mode — a second engine over
the same store/OPFS after a "dead tab" loads `paused/INTERRUPTED` with 512+512 B kept and resumes with
`Range: 512-1023` / `1536-2047`, final destination has no hole; direct-mode reload rolls 500/1024/0 back to the
committed 150/0/0; pause during merge → resume merges without re-downloading; evicted part → `reconciled` 1,200 B and
re-receive; part missing at merge time → re-receive + second merge; quota mid-part → `STORAGE_QUOTA` → migration →
completes as `direct` with the migrated bytes intact; storage choice (quota margin, unavailable, unknown estimate).
`splitWorker.test.ts` (8): OPFS sink flush cadence (148/296/300 B at 128 B chunks), part-relative positions on resume,
quota error mapping, network failure flushes the received bytes before reporting.

**dev evidence (Chromium, deployed portal, 12 GiB CF path) — see §1 row 5 and the metrics below.**

| Step (`web/e2e/tests/split.chromium.spec.ts`, 12 GiB, CloudFront path)    | Result                                                                 |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| storage chosen                                                            | `opfs` (probe reserved 12 GiB + 256 MiB; estimate said 10 GiB)         |
| start → 5 % → pause (clean)                                               | 3.3 s; part files == persisted `receivedBytes`                         |
| resume → +10 % → **reload** (no pause, no `close()`)                      | 8.5 s, at 17 % = 2,302,019,106 B                                       |
| after reload                                                              | `paused / INTERRUPTED`, 2,302,019,106 B kept (Δ = 0), parts ≥ progress |
| resume → remaining parts                                                  | 77.1 s (`Range` from the durable offsets)                              |
| merge 2 parts → destination (`merging`, toast "파일로 병합하는 중입니다") | 95.9 s (12 GiB, OPFS → OPFS in the test profile)                       |
| SPA CRC32 verification                                                    | 59.1 s → `complete`, `merged=true`, part directory deleted             |
| independent CRC32 of the saved file                                       | `/sXQ3A==` in 51.4 s = seed checksum                                   |
| total wall time incl. pauses                                              | 244.2 s                                                                |

Two more defects surfaced on the way to this pass and are fixed in the same commit series (§3 items 6–7): the data
distribution served a cached, origin-specific `Access-Control-Allow-Origin` (all Range fetches from the deployed
portal failed), and a resume 1–2 s after the reload hit the previous page's still-open sync access handles.
