import { expect, test } from '../fixtures';
import { signIn } from '../helpers/auth';
import { DEV, GiB, metric, OBJECTS } from '../helpers/env';
import {
  clickDownload,
  fileRow,
  methodBadge,
  notice,
  openLocation,
  waitForRowStatus,
} from '../helpers/portal';

/**
 * T7.5 — Firefox has no File System Access API (design §5.4). Since D8 it still splits (OPFS parts + export
 * delivery, see export.spec.ts), so the row badges read "분할·이어받기" for 12 GiB and 53 GiB alike. The legacy
 * behaviour — 12 GiB as an ordinary download with the R5.9 toast, 53 GiB (> 50 GB single-object limit) through the
 * aria2c/curl command dialog with the "명령어 다운로드" badge — remains for browsers WITHOUT OPFS and is exercised here
 * with `navigator.storage.getDirectory` removed before the SPA loads (Firefox ≤ 110, storage disabled).
 */

/** Firefox without OPFS (capability `none`): the pre-D8 fallback column of the §5.4 matrix. */
async function disableOpfs(page: Parameters<typeof signIn>[0]) {
  await page.addInitScript(() => {
    const storage = navigator.storage as StorageManager & { getDirectory?: unknown };
    Object.defineProperty(storage, 'getDirectory', { value: undefined, configurable: true });
  });
}

test.describe('T7.5 Firefox (R5.6, R5.9, R3.5, scenarios 4·10)', () => {
  test.skip(({ browserName }) => browserName !== 'firefox', 'Firefox-only scenario');

  test('with OPFS (default): 12 GiB and 53 GiB rows carry the split badge (D8), no command dialog', async ({
    page,
    creds,
  }) => {
    await signIn(page, creds);
    await openLocation(page, DEV.locations.demo);
    const row12 = fileRow(page, OBJECTS.gib12.name);
    await waitForRowStatus(row12);
    expect(await methodBadge(row12)).toBe('분할·이어받기');
    const row53 = fileRow(page, OBJECTS.gib53.name);
    await waitForRowStatus(row53);
    expect(await methodBadge(row53)).toBe('분할·이어받기');
    expect(
      await page.evaluate(
        () =>
          typeof navigator.storage.getDirectory === 'function' &&
          typeof window.showSaveFilePicker === 'undefined',
      ),
    ).toBe(true);
  });

  test('without OPFS: 12 GiB → ordinary download + R5.9 toast + empty 방식 badge', async ({
    page,
    creds,
  }) => {
    await disableOpfs(page);
    await signIn(page, creds);
    await openLocation(page, DEV.locations.demo);
    const row = fileRow(page, OBJECTS.gib12.name);
    await waitForRowStatus(row);
    expect(await methodBadge(row)).toBe('');

    const downloadEvent = page.waitForEvent('download', { timeout: 60_000 });
    const issued = await clickDownload(page, row);
    expect(issued.sizeBytes).toBe(12 * GiB);
    expect(issued.mode).toBe('split'); // the server's hint; the planner downgrades to single without FS Access
    await expect(notice(page, '이 브라우저는 이어받기를 지원하지 않습니다')).toBeVisible();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe(OBJECTS.gib12.name);
    await download.cancel();
    await expect(page.getByTestId('split-download')).toHaveCount(0);
    metric('firefox 12GiB path', issued.path);
  });

  test('without OPFS: 53 GiB → command dialog with valid aria2c / curl strings, copy works, 명령어 다운로드 badge', async ({
    page,
    creds,
  }) => {
    await disableOpfs(page);
    await signIn(page, creds);
    await openLocation(page, DEV.locations.demo);
    const row = fileRow(page, OBJECTS.gib53.name);
    await waitForRowStatus(row);
    expect(await methodBadge(row)).toBe('명령어 다운로드');

    const issued = await clickDownload(page, row);
    // the response `mode` is the server's size hint (split above the 1 GiB threshold); 'command' is the client's
    // decision for a browser without File System Access — asserted through the dialog and the badge below
    expect(issued.mode).toBe('split');
    expect(issued.sizeBytes).toBe(53 * GiB);
    const dialog = page.getByRole('dialog', { name: '명령어로 다운로드' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('단일 객체 한도(46.6 GiB)'); // formatBytes(50_000_000_000)
    await expect(dialog).toContainText(OBJECTS.gib53.name);

    const aria2c = await dialog.getByRole('textbox', { name: /aria2c/ }).inputValue();
    const curl = await dialog.getByRole('textbox', { name: /curl/ }).inputValue();
    const url = new URL(issued.url);
    const quotedUrl = `"${issued.url}"`;
    expect(aria2c).toBe(
      `aria2c -x 4 -s 4 -k 8G --file-allocation=none -o "${OBJECTS.gib53.name}" ${quotedUrl}`,
    );
    expect(curl).toBe(`curl -L -C - -o "${OBJECTS.gib53.name}" ${quotedUrl}`);
    expect(url.protocol).toBe('https:');
    expect(url.pathname).toBe(`/${OBJECTS.gib53.key}`);
    if (issued.path === 'CF') expect(url.hostname).toMatch(/\.cloudfront\.net$/);
    else expect(url.hostname).toMatch(new RegExp(`^${DEV.dataBucket}\\.s3[.-]`));
    expect(url.search.length).toBeGreaterThan(20); // signed query string present
    expect(curl).toContain(' -C - '); // resume flag (Range on retry)
    expect(aria2c).toContain(' -k 8G '); // 8 GiB pieces, 4 connections
    metric('firefox 53GiB command host', url.hostname);
    await expect(dialog).toContainText('URL 만료 시각');

    // copy button → clipboard (Firefox prefs in playwright.config allow readText from content)
    const copy = dialog.getByRole('button', { name: '복사' }).first();
    await copy.click();
    await expect(dialog.getByRole('button', { name: '복사됨' })).toBeVisible();
    const clipboard = await page.evaluate(() =>
      navigator.clipboard.readText().catch((e: Error) => `ERR:${e.name}`),
    );
    if (clipboard.startsWith('ERR:')) {
      test.info().annotations.push({
        type: 'note',
        description: `clipboard.readText not permitted (${clipboard}); asserted via 복사됨 state`,
      });
    } else {
      expect(clipboard).toBe(aria2c);
    }

    await dialog.getByRole('button', { name: '닫기' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('split-download')).toHaveCount(0);
  });
});
