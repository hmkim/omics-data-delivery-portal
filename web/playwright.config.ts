import { defineConfig, devices, type Project } from '@playwright/test';
import { statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Playwright e2e configuration (M7 / T7.1).
 *
 * Environment (all optional):
 * - `E2E_BASE_URL`         portal under test. Default `http://localhost:5173` → the Vite dev server is started
 *                          (`npm run dev`) with `/api` proxied to `E2E_API_ORIGIN`. Set it to the deployed portal
 *                          (`https://<web-distribution>.cloudfront.net`) to run against the real deployment; no
 *                          dev server is started then.
 * - `E2E_API_ORIGIN`       origin the dev server proxies `/api/*` to (CloudFront adds `x-origin-verify`).
 *                          Default: the dev portal distribution.
 * - `E2E_CREDENTIALS_FILE` 0600 file with the portal test user (line 1 e-mail, line 2 password). Read ONLY by
 *                          the test process inside `signIn()`. Default: `$PORTAL_SCRATCH/gp/user-login.txt`.
 * - `E2E_OUTPUT_DIR`       where reports, traces and downloaded files go. Default `web/e2e/test-results`
 *                          (on disk: the zip test downloads 2 GiB there).
 * - `E2E_BIG_FILE`         object used by the CloudFront cache test (T7.6). Default `sample-12gib.bin`;
 *                          `sample-53gib.bin` costs ≈ $5–6 per pass — only set it deliberately.
 * - `E2E_SKIP_FIREFOX=1`   drop the firefox project (host cannot launch Firefox).
 * - `TMPDIR`               Chromium's profile — and with it the OPFS the split engine writes into — lives in
 *                          `os.tmpdir()`. The split tests need ≥ 2 × the largest file free there (Chromium commits an
 *                          OPFS writable through a swap file), i.e. ≥ 30 GB for the 12 GiB default and ≥ 120 GB for
 *                          `sample-53gib.bin`. A tmpfs scratch of a few GiB is refused up front (`E2E_TMP_MIN_GB`).
 */
const scratch = process.env.PORTAL_SCRATCH;
export const OUTPUT_DIR = process.env.E2E_OUTPUT_DIR ?? resolve(import.meta.dirname, 'e2e', 'test-results');

// Default location of the test user's file: `$PORTAL_SCRATCH/gp/user-login.txt` when PORTAL_SCRATCH is set,
// otherwise `web/e2e/user-login.txt` (gitignored). `tools/e2e_reset_test_user.py` creates it.
export const DEFAULT_CREDENTIALS_FILE = scratch
  ? resolve(scratch, 'gp', 'user-login.txt')
  : resolve(import.meta.dirname, 'e2e', 'user-login.txt');

const bigFileGiB = /53gib/.test(process.env.E2E_BIG_FILE ?? '') ? 53 : 12;
const tmpMinGb = Number(process.env.E2E_TMP_MIN_GB ?? (bigFileGiB === 53 ? 120 : 30));
{
  const st = statfsSync(tmpdir());
  const freeGb = (Number(st.bavail) * Number(st.bsize)) / 1e9;
  if (freeGb < tmpMinGb) {
    throw new Error(
      `os.tmpdir() (${tmpdir()}) has ${freeGb.toFixed(1)} GB free; the split downloads need ≥ ${tmpMinGb} GB there ` +
        '(Chromium keeps its profile and the OPFS swap file in the temp dir). Point TMPDIR at a disk with room, ' +
        'e.g. TMPDIR=$HOME/.cache/genome-portal-e2e-tmp, or lower E2E_TMP_MIN_GB when you know what you are doing.',
    );
  }
}
export const DEFAULT_PORTAL_ORIGIN = 'https://d111111abcdef8.cloudfront.net';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(baseURL);
const apiOrigin = process.env.E2E_API_ORIGIN ?? DEFAULT_PORTAL_ORIGIN;

const projects: Project[] = [
  {
    name: 'chromium',
    use: { ...devices['Desktop Chrome'] },
    // Firefox-only scenarios live in *.firefox.spec.ts
    testIgnore: /\.firefox\.spec\.ts$/,
  },
];
if (process.env.E2E_SKIP_FIREFOX !== '1') {
  projects.push({
    name: 'firefox',
    use: {
      ...devices['Desktop Firefox'],
      launchOptions: {
        // lets the test read the clipboard back after the copy button (Firefox has no clipboard permission API)
        firefoxUserPrefs: {
          'dom.events.testing.asyncClipboard': true,
          'dom.events.asyncClipboard.readText': true,
        },
      },
    },
    // Chromium-only scenarios (split engine, fake clock, auth expiry, cache/zip) live in *.chromium.spec.ts
    testIgnore: /\.chromium\.spec\.ts$/,
  });
}

export default defineConfig({
  testDir: resolve(import.meta.dirname, 'e2e', 'tests'),
  outputDir: resolve(OUTPUT_DIR, 'test-results'),
  // one shared portal user, shared download counters and one network pipe: never run tests in parallel
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 5 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: resolve(OUTPUT_DIR, 'playwright-report'), open: 'never' }],
    ['json', { outputFile: resolve(OUTPUT_DIR, 'results.json') }],
  ],
  use: {
    baseURL,
    locale: 'ko-KR',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    acceptDownloads: true,
  },
  projects,
  webServer: isLocal
    ? {
        command: 'npm run dev',
        cwd: import.meta.dirname,
        url: `${baseURL.replace(/\/$/, '')}/config.json`,
        reuseExistingServer: true,
        timeout: 60_000,
        env: { VITE_API_ORIGIN: apiOrigin },
        stdout: 'ignore',
        stderr: 'pipe',
      }
    : undefined,
});
