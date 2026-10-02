import { existsSync, writeFileSync } from 'node:fs';
import { expect, test } from '../fixtures';
import { signIn } from '../helpers/auth';
import { awsGate } from '../helpers/aws';
import { checkSecondPassHits, readCachePasses, type CachePass, type CachePassesFile } from '../helpers/cache';
import { bigFile, DEV, formatMs, GiB, metric, OBJECTS, outputPath } from '../helpers/env';
import { installPickFileHook, opfsCrc32, removeOpfsFile } from '../helpers/opfs';
import {
  clickDownload,
  expectSplitStatus,
  fileRow,
  openLocation,
  openZipView,
  selectFile,
  splitRow,
  waitForRowStatus,
} from '../helpers/portal';
import { listZipEntries } from '../helpers/zip';

const PASSES_FILE = process.env.E2E_CACHE_PASSES_FILE ?? outputPath('cache-passes.json');
const COPY_COMMAND = [
  `aws s3api copy-object --bucket ${DEV.dataBucket}`,
  `  --copy-source ${DEV.dataBucket}/${OBJECTS.gib1.key}`,
  `  --key ${OBJECTS.gib1Copy.key} --checksum-algorithm CRC32`,
  `  --metadata-directive COPY --region ${DEV.region}`,
  `# then verify the checksum was carried over (must be FULL_OBJECT ${OBJECTS.gib1.crc32}):`,
  `aws s3api head-object --bucket ${DEV.dataBucket} --key ${OBJECTS.gib1Copy.key} --checksum-mode ENABLED --region ${DEV.region}`,
  `# copy-object of a multipart-uploaded source may not carry a FULL_OBJECT CRC32 → fallback: re-upload with tools/upload.ts`,
].join('\n');

test.describe.configure({ mode: 'serial' });

test.describe('T7.6 CloudFront cache (R5.8)', () => {
  test(`two CloudFront passes of ${bigFile().name} through the UI`, async ({ page, creds }) => {
    const object = bigFile();
    // 53 GiB: ~7 min download + ~7 min merge + ~4.5 min verify per pass, plus the page-side CRC32 read below
    test.setTimeout((object.sizeBytes > 20 * GiB ? 100 : 30) * 60_000);
    await installPickFileHook(page);
    await signIn(page, creds);
    await openLocation(page, DEV.locations.demo);
    const row = fileRow(page, object.name);
    const status = await waitForRowStatus(row);
    metric(`cache: ${object.name} count/next before the test`, `${status.count} / ${status.nextPath}`);

    const passes: CachePass[] = [];
    // cf-threshold is 1: at most the first download takes S3, so 3 attempts always yield 2 CF passes
    for (let attempt = 1; attempt <= 3 && passes.filter((p) => p.path === 'CF').length < 2; attempt++) {
      const startedAt = new Date();
      const issued = await clickDownload(page, row);
      const split = splitRow(page, object.name).first();
      await expectSplitStatus(split, 'running', 60_000);
      await expectSplitStatus(split, 'complete', (object.sizeBytes > 20 * GiB ? 40 : 12) * 60_000);
      const completedAt = new Date();
      passes.push({
        downloadId: issued.downloadId,
        path: issued.path,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        url: issued.url.split('?')[0]!,
      });
      metric(
        `cache: pass ${attempt}`,
        `${issued.path} in ${formatMs(completedAt.getTime() - startedAt.getTime())}`,
      );
      const crc = await opfsCrc32(page, object.name);
      expect(crc.base64).toBe(object.crc32);
      // clean up before the next pass: drop the panel entry and the OPFS file
      await split.getByRole('button', { name: '목록에서 제거' }).click();
      await removeOpfsFile(page, object.name);
    }
    const cf = passes.filter((p) => p.path === 'CF');
    expect(cf.length).toBe(2);
    const record: CachePassesFile = { object: object.name, uriStem: `/${object.key}`, passes };
    writeFileSync(PASSES_FILE, JSON.stringify(record, null, 2));
    metric('cache: passes recorded to', PASSES_FILE);
  });

  // eslint-disable-next-line no-empty-pattern
  test('Athena: every part range of the second CloudFront pass is a Hit', async ({}, testInfo) => {
    const gate = await awsGate();
    test.skip(
      !gate.ok,
      `${gate.ok ? '' : gate.reason}\n  npm run e2e:athena-check -w web -- --passes ${PASSES_FILE}   (no re-download)\n  or: npx playwright test cache-zip --project=chromium --grep Athena`,
    );
    test.skip(
      !existsSync(PASSES_FILE),
      `no cache passes recorded (${PASSES_FILE}); run the "two CloudFront passes" test first`,
    );
    const waitMinutes = Number(process.env.E2E_ATHENA_WAIT_MIN ?? 20);
    testInfo.setTimeout((waitMinutes + 5) * 60_000);

    const record = readCachePasses(PASSES_FILE);
    expect(record.passes.filter((p) => p.path === 'CF').length).toBe(2);
    const result = await checkSecondPassHits(record, waitMinutes);
    expect(result.rows.length, 'CloudFront access-log rows for the second pass').toBeGreaterThan(0);
    metric('cache: second-pass requests by x_edge_result_type', JSON.stringify(result.byType));
    for (const m of result.misses.slice(0, 20)) {
      console.log(
        '  non-Hit:',
        m.date,
        m.time,
        m.x_edge_result_type,
        m.sc_range_start,
        '-',
        m.sc_range_end,
        m.x_edge_request_id,
      );
    }
    expect(result.misses, 'all second-pass part ranges are cache hits').toEqual([]);
  });
});

test.describe('T7.6 zip (R4.9)', () => {
  test('53 GiB item is excluded from a zip selection with the R4.9 message', async ({ page, creds }) => {
    await signIn(page, creds);
    await openLocation(page, DEV.locations.demo);
    await selectFile(fileRow(page, OBJECTS.gib1.name));
    await selectFile(fileRow(page, OBJECTS.gib53.name));
    await openZipView(page);
    const excluded = page.getByRole('alert').filter({ hasText: '개별 다운로드 필요(단일 객체 한도 초과)' });
    await expect(excluded).toBeVisible();
    await expect(excluded).toContainText(OBJECTS.gib53.name);
    await expect(page.getByText(/1개 파일, 1\.0 GiB/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'zip 다운로드 시작' })).toBeEnabled();
    await page.getByRole('button', { name: '닫기' }).click();
  });

  test('zip of two 1 GiB objects (+ excluded 53 GiB) contains both files with matching CRC32', async ({
    page,
    creds,
  }) => {
    test.setTimeout(20 * 60_000);
    await signIn(page, creds);
    await openLocation(page, DEV.locations.demo);
    const copyRow = fileRow(page, OBJECTS.gib1Copy.name);
    // the listing renders after openLocation resolves; count() does not wait, so give the rows a moment
    await fileRow(page, OBJECTS.gib1.name).waitFor({ state: 'visible', timeout: 30_000 });
    const copyExists = await copyRow
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(
      !copyExists,
      `${OBJECTS.gib1Copy.key} does not exist yet; create it with AWS credentials:\n${COPY_COMMAND}\nthen: npx playwright test cache-zip --project=chromium --grep "two 1 GiB"`,
    );

    await selectFile(fileRow(page, OBJECTS.gib1.name));
    await selectFile(copyRow);
    await selectFile(fileRow(page, OBJECTS.gib53.name));
    await openZipView(page);
    await expect(page.getByRole('alert').filter({ hasText: OBJECTS.gib53.name })).toBeVisible();
    await expect(page.getByText(/2개 파일, 2\.0 GiB/)).toBeVisible();

    const issues: string[] = [];
    page.on('response', (r) => {
      if (r.request().method() === 'POST' && /\/api\/downloads$/.test(new URL(r.url()).pathname))
        issues.push(r.url());
    });
    const downloadEvent = page.waitForEvent('download', { timeout: 5 * 60_000 });
    const started = Date.now();
    await page.getByRole('button', { name: 'zip 다운로드 시작' }).click();
    const download = await downloadEvent;
    const target = outputPath('downloads', download.suggestedFilename() || 'download.zip');
    await download.saveAs(target);
    const failure = await download.failure();
    expect(failure, `zip download failed: ${failure}`).toBeNull();
    metric('zip: two 1 GiB files streamed in', formatMs(Date.now() - started));
    await expect(page.getByRole('alert').filter({ hasText: 'zip 다운로드가 완료되었습니다' })).toBeVisible({
      timeout: 60_000,
    });
    expect(issues.length, 'each zipped file is issued (counted) through POST /downloads').toBe(2);

    const entries = await listZipEntries(target);
    metric(
      'zip: entries',
      JSON.stringify(entries.map((e) => ({ name: e.name, size: e.uncompressedSize, crc32: e.crc32Base64 }))),
    );
    expect(entries.map((e) => e.name.split('/').pop()).sort()).toEqual(
      [OBJECTS.gib1Copy.name, OBJECTS.gib1.name].sort(),
    );
    for (const e of entries) {
      expect(e.uncompressedSize).toBe(GiB);
      expect(e.crc32Base64).toBe(OBJECTS.gib1.crc32);
    }
  });
});
