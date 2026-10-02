import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, test as base, type BrowserContext } from '@playwright/test';
import { type PortalCredentials, readCredentials } from './helpers/auth';

/**
 * Shared fixtures.
 *
 * `creds` — the portal test user. When the credentials file is missing the test is SKIPPED with the reason (so a
 * host without the 0600 file can still run the credential-free smoke tests); set `E2E_REQUIRE_CREDENTIALS=1` to turn
 * that into a failure (CI).
 *
 * `context` (chromium only) — a PERSISTENT context in a fresh on-disk profile under `os.tmpdir()`. Playwright's
 * default contexts are off-the-record: Chromium keeps their Origin Private File System in memory with a quota sized
 * from RAM, so the split engine's first write beyond ~1 GiB fails with "would cause the application to exceed its
 * storage quota" (seen 2026-09-28). A persistent profile stores OPFS on disk with the disk-sized quota the real
 * portal users get. The runner's trace / screenshot options still apply: Playwright instruments every context a
 * fixture creates, persistent ones included.
 */
export const test = base.extend<{ creds: PortalCredentials }>({
  // eslint-disable-next-line no-empty-pattern
  creds: async ({}, use, testInfo) => {
    let creds: PortalCredentials | undefined;
    let reason = '';
    try {
      creds = readCredentials();
    } catch (err) {
      reason = (err as Error).message;
    }
    if (!creds) {
      if (process.env.E2E_REQUIRE_CREDENTIALS === '1') throw new Error(reason);
      testInfo.skip(true, reason);
      return;
    }
    await use(creds);
  },

  context: async ({ browserName, browser, contextOptions, launchOptions }, use) => {
    if (browserName !== 'chromium') {
      const ctx = await browser.newContext(contextOptions);
      await use(ctx);
      await ctx.close();
      return;
    }
    const userDataDir = mkdtempSync(join(tmpdir(), 'genome-portal-e2e-profile-'));
    let ctx: BrowserContext | undefined;
    try {
      ctx = await chromium.launchPersistentContext(userDataDir, {
        ...launchOptions,
        ...contextOptions,
        headless: true,
        // 'chromium' = the full browser in new-headless mode; the default headless shell is what CI images ship.
        ...(process.env.E2E_CHROMIUM_CHANNEL ? { channel: process.env.E2E_CHROMIUM_CHANNEL } : {}),
      });
      await use(ctx);
    } finally {
      await ctx?.close().catch(() => undefined);
      rmSync(userDataDir, { recursive: true, force: true });
    }
  },

  page: async ({ context }, use) => {
    const page = context.pages()[0] ?? (await context.newPage());
    await use(page);
  },
});

export { expect } from '@playwright/test';
