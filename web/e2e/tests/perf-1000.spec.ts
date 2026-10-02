import { expect, test } from '../fixtures';
import { signIn } from '../helpers/auth';
import { DEV, metric } from '../helpers/env';

/**
 * T6.8 remainder / requirement N5: a location with 1,000 objects shows its first page (100 rows) within 2 s.
 * Measured in the page's own clock: `performance.now()` right before the location button is clicked → the first
 * `waitForFunction` tick that sees ≥ 100 file rows with the portal columns. Each test gets a fresh (cold) browser
 * context: no HTTP cache, no IndexedDB, no service worker.
 */
test('PERF-1000: location opened → first 100 rows rendered < 2 s', async ({ page, browserName, creds }) => {
  test.setTimeout(180_000);
  await signIn(page, creds);

  const row = page.getByRole('row').filter({ hasText: DEV.locations.perf });
  await expect(row.first()).toBeVisible();
  const button = row.first().getByRole('button', { name: DEV.locations.perf });
  await button.hover(); // move the pointer first so the click below is the only thing on the critical path

  const t0 = await page.evaluate(() => performance.now());
  await button.click({ noWaitAfter: true });
  const t1 = await page.waitForFunction(
    () => {
      const rows = document.querySelectorAll('tbody tr');
      let files = 0;
      for (const r of rows) if (r.querySelector('[data-testid="portal-method"]')) files += 1;
      return files >= 100 ? performance.now() : false;
    },
    undefined,
    { timeout: 60_000, polling: 'raf' },
  );
  const firstRenderMs = Number(await t1.jsonValue()) - t0;
  const rowsRendered = await page.locator('tbody tr').count();
  metric(`PERF-1000 first-render (${browserName})`, firstRenderMs.toFixed(0), 'ms');
  metric(`PERF-1000 rows on first page (${browserName})`, rowsRendered);
  test.info().annotations.push({
    type: 'metric',
    description: `first-render ${firstRenderMs.toFixed(0)} ms, ${rowsRendered} rows`,
  });

  expect(rowsRendered).toBeGreaterThanOrEqual(100);
  if (browserName === 'chromium') expect(firstRenderMs).toBeLessThan(2000);
  else
    expect.soft(firstRenderMs, 'N5 is specified for Chromium; Firefox is informational').toBeLessThan(2000);
});
