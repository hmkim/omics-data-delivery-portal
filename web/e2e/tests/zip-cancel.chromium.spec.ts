import { expect } from '@playwright/test';
import { signIn } from '../helpers/auth';
import { fileRow, openLocation, openZipView, selectFile } from '../helpers/portal';
import { test } from '../fixtures';

/**
 * zip cancel (R4.9, user report 2026-10-01): cancelling a zip while a file is streaming must leave the panel in the
 * cancelled state — not "zip 생성 중" with a live Cancel button. Two defects produced that symptom: `runZip` never
 * settled (client-zip wraps the entries generator without `return()`), and a chunk still queued in the counting
 * transform reported progress after the cancelled outcome and overwrote it. Costs one counted 1 GiB download event,
 * cancelled after a few MiB. Also checks the header logo really loads (naturalWidth > 0) and that the sign-in →
 * browse → zip flow produces no page errors or console errors.
 */
test('zip cancel leaves the running state; logo loads; no page/console errors', async ({ page, creds }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  await page.goto('/');
  await signIn(page, creds);
  await expect(page.getByText(creds.email)).toBeVisible({ timeout: 60_000 });

  const logo = page.getByTestId('brand-logo');
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);

  await openLocation(page, 'projects/DEMO-0001/');
  const row = fileRow(page, 'sample-1gib.bin');
  await expect(row).toBeVisible({ timeout: 60_000 });
  await selectFile(row);
  await openZipView(page);
  await page.getByRole('button', { name: 'zip 다운로드 시작' }).click();
  const streaming = page.getByText(/zip 생성 중/);
  await expect(streaming).toHaveText(/MiB/, { timeout: 60_000 }); // streaming phase, body open
  await page.getByRole('button', { name: '취소' }).click();

  await expect(page.getByText(/zip 생성을 취소했습니다/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: '취소' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'zip 다운로드 시작' })).toBeVisible();
  await expect(page.getByRole('button', { name: '다시 받기' })).toBeVisible();
  await expect(page.getByRole('button', { name: '닫기' })).toBeEnabled();

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});
