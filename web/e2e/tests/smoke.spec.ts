import { expect, test } from '@playwright/test';

/**
 * Credential-free smoke (both browsers): the SPA boots from `/config.json`, Amplify is configured, the Authenticator
 * renders in Korean and nothing throws. Verifies the dev server / proxy / browser launch before the signed-in suites.
 */
test('portal boots and shows the Korean sign-in form', async ({ page, browserName }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  const configResponse = page.waitForResponse((r) => new URL(r.url()).pathname === '/config.json');
  await page.goto('/');
  const config = (await (await configResponse).json()) as Record<string, unknown>;
  expect(config.userPoolId).toMatch(/^ap-northeast-2_/);
  expect(config.apiBase).toBe('/api');

  await expect(page.locator('input[name="username"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('input[name="password"]')).toBeVisible();
  await expect(page.locator('button[type="submit"]')).toHaveText(/로그인|Sign in/);
  await expect(page).toHaveTitle(/Genome Data Portal/);
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('ko');

  // planner precondition for the two browser projects (design §5.4 matrix)
  const hasFsAccess = await page.evaluate(() => typeof window.showSaveFilePicker === 'function');
  expect(hasFsAccess).toBe(browserName === 'chromium');

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('unauthenticated /api/locations is rejected through the proxy', async ({ request }) => {
  const res = await request.get('/api/locations');
  expect([401, 403]).toContain(res.status());
});
