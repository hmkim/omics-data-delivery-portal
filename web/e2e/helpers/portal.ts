import { expect, type Locator, type Page } from '@playwright/test';
import type { DownloadResponse } from '@genome-portal/contract';

/** LocationsView → click the folder button of a location (`projects/DEMO-0001/`). Resolves when the file table shows. */
export async function openLocation(page: Page, prefix: string): Promise<void> {
  const row = page.getByRole('row').filter({ hasText: prefix });
  await expect(row.first()).toBeVisible({ timeout: 60_000 });
  await row.first().getByRole('button', { name: prefix }).click();
  // the LocationDetailView table has our three portal columns
  await expect(page.getByRole('columnheader', { name: '방식' })).toBeVisible({ timeout: 60_000 });
}

/** Back to the location list (Storage Browser navigation "홈"). */
export async function goHome(page: Page): Promise<void> {
  await page.getByRole('button', { name: '홈' }).first().click();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: /projects\// })
      .first(),
  ).toBeVisible();
}

/**
 * File row in the LocationDetailView table. A row's text is its cells' textContent concatenated without separators
 * ("…/sample-1gib.binsample-1gib.binfilebin…"), so a whitespace-bounded regex on the row never matches, and the name
 * button's text carries an aria-hidden glyph ("📄 sample-1gib.bin"). Anchor on the button's exact accessible name,
 * `"<name> file"` (Storage Browser's preview button), which keeps `sample-1gib.bin` apart from `sample-1gib-copy.bin`.
 */
export function fileRow(page: Page, fileName: string): Locator {
  return page
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: `${fileName} file`, exact: true }) });
}

/** The row's "방식" badge text ("분할·이어받기" / "명령어 다운로드" / ""). */
export async function methodBadge(row: Locator): Promise<string> {
  return (await row.getByTestId('portal-method').innerText()).trim();
}

/** Waits for the row status columns (count / next path) to be filled by `POST /objects/status`. */
export async function waitForRowStatus(row: Locator): Promise<{ count: number; nextPath: 'S3' | 'CF' }> {
  const next = row.getByTestId('portal-next');
  await expect(next).not.toHaveText('…', { timeout: 30_000 });
  const nextText = (await next.innerText()).trim();
  const count = Number((await row.getByTestId('portal-count').innerText()).trim());
  return { count, nextPath: nextText === 'CloudFront' ? 'CF' : 'S3' };
}

/**
 * Clicks the row's download button and returns the parsed `POST /api/downloads` response
 * (`downloadId`, `path`, `url`, `expiresAt`, `sizeBytes`, `checksumCrc32`, …).
 */
export async function clickDownload(page: Page, row: Locator): Promise<DownloadResponse> {
  const issued = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/api\/downloads$/.test(new URL(r.url()).pathname) && r.ok(),
    { timeout: 60_000 },
  );
  await row.getByRole('button', { name: 'download' }).click();
  return (await issued).json() as Promise<DownloadResponse>;
}

/** Select a file's checkbox in the listing. */
export async function selectFile(row: Locator): Promise<void> {
  // Amplify's CheckboxField hides the <input> behind a styled <span>; a plain check() times out on
  // "intercepts pointer events", so click the label and confirm the input toggled.
  const input = row.getByRole('checkbox');
  if (await input.isChecked()) return;
  await row.locator('label.amplify-checkbox').first().click();
  await expect(input).toBeChecked();
}

/** Storage Browser actions menu (kebab) → "다운로드" (opens our PortalDownloadView = zip). */
export async function openZipView(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Menu Toggle' }).click();
  await page.getByRole('menuitem', { name: '다운로드' }).click();
  await expect(page.getByRole('heading', { name: '일괄 다운로드(zip)' })).toBeVisible();
}

// ---------------------------------------------------------------------------
// split download panel
// ---------------------------------------------------------------------------

export type SplitStatus = 'running' | 'paused' | 'verifying' | 'complete' | 'failed';

export function splitRow(page: Page, fileName: string): Locator {
  return page.getByTestId('split-download').filter({ hasText: fileName });
}

export async function splitState(row: Locator): Promise<{
  status: SplitStatus;
  reason: string;
  parts: number;
  renewCount: number;
  progressText: string;
}> {
  const [status, reason, parts, renewCount, progressText] = await Promise.all([
    row.getAttribute('data-status'),
    row.getAttribute('data-reason'),
    row.getAttribute('data-parts'),
    row.getAttribute('data-renew-count'),
    row.innerText(),
  ]);
  return {
    status: status as SplitStatus,
    reason: reason ?? '',
    parts: Number(parts),
    renewCount: Number(renewCount),
    progressText,
  };
}

export async function expectSplitStatus(row: Locator, status: SplitStatus, timeout: number): Promise<void> {
  await expect(row).toHaveAttribute('data-status', status, { timeout });
}

/** Received bytes as the panel shows them ("1.2 GiB / 12 GiB (10%)") → percent. */
export async function splitPercent(row: Locator): Promise<number> {
  const text = await row.innerText();
  const m = /\((\d+)%\)/.exec(text);
  return m ? Number(m[1]) : 0;
}

/** Waits until progress passes `percent` (so pause/reload happen mid-transfer, never at 0). */
export async function waitForProgressAbove(row: Locator, percent: number, timeout: number): Promise<number> {
  await expect
    .poll(async () => splitPercent(row), { timeout, intervals: [500, 1000] })
    .toBeGreaterThanOrEqual(percent);
  return splitPercent(row);
}

export async function pauseSplit(row: Locator): Promise<void> {
  await row.getByRole('button', { name: '일시정지' }).click();
  await expectSplitStatus(row, 'paused', 60_000);
}

export async function resumeSplit(row: Locator): Promise<void> {
  await row.getByRole('button', { name: '재개' }).click();
  await expectSplitStatus(row, 'running', 60_000);
}

/** Toast / banner text visible anywhere on the page (first match; toasts can stack). */
export function notice(page: Page, text: string | RegExp): Locator {
  return page.getByText(text).first();
}
