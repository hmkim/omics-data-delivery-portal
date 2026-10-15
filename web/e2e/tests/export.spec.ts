import { statSync } from 'node:fs';
import { expect, test } from '../fixtures';
import { signIn } from '../helpers/auth';
import { DEV, formatMs, GiB, metric, OBJECTS } from '../helpers/env';
import { fileCrc32, opfsPartSizes, readSplitRecords } from '../helpers/opfs';
import {
  clickDownload,
  expectSplitStatus,
  fileRow,
  methodBadge,
  notice,
  openLocation,
  pauseSplit,
  resumeSplit,
  splitPercent,
  splitRow,
  splitState,
  waitForProgressAbove,
  waitForRowStatus,
} from '../helpers/portal';

/**
 * D8 (design §5.4, docs/design-notes/2026-10-14_split_export_firefox_safari.md): split downloads in browsers without
 * the File System Access API. Parts are received into OPFS (plan A), verified, then handed to the browser's ordinary
 * download — through the export service worker where streams are transferable (Firefox), or as a Blob URL (the
 * Safari ≤ 26 path, exercised here in Chromium with `showSaveFilePicker` removed and the Blob path forced).
 *
 * The Firefox test downloads the 2 GiB object (single part), the Chromium test the 12 GiB object (two parts); both
 * take the CloudFront path after the first count and compare the file the BROWSER saved against the S3 full-object
 * CRC32 with Node's zlib — nothing from the SPA is trusted for the check.
 *
 * Why 2 GiB in Firefox: Playwright's Firefox build (Juggler NetworkObserver) copies every in-flight response body
 * into the browser parent process until the request finishes (needed for `response.body()`), so one 8 GiB part GET
 * grows the parent by 8 GB. The 12 GiB run (2026-10-14) reached 10.3 GB RSS, drove the host into 90 % iowait and
 * never finished. This is a test-harness limitation, not a product one: a stock Firefox streams to disk.
 */

/** Chromium stand-in for Brave / Safari: no save picker, Blob hand-over. */
async function removeFileSystemAccess(page: Parameters<typeof signIn>[0], forceExport: 'stream' | 'blob') {
  await page.addInitScript((force) => {
    const w = window as Window & { showSaveFilePicker?: unknown; __portalTest?: { forceExport?: string } };
    delete w.showSaveFilePicker;
    w.__portalTest = { ...(w.__portalTest ?? {}), forceExport: force };
  }, forceExport);
}

test.describe('D8 export delivery — split downloads without File System Access', () => {
  test('Firefox: 2 GiB → OPFS part → pause → resume → reload → resume → verify → SW stream download → CRC32', async ({
    page,
    creds,
    browserName,
  }) => {
    test.skip(browserName !== 'firefox', 'Firefox has OPFS + transferable streams and no save picker');
    test.setTimeout(30 * 60_000);
    const target = OBJECTS.gib2;
    await signIn(page, creds);
    await openLocation(page, DEV.locations.demo);
    const row = fileRow(page, target.name);
    await waitForRowStatus(row);
    expect(await methodBadge(row)).toBe('분할·이어받기'); // was '' (ordinary download) before D8

    // the browser download starts only at the very end; the listener must be in place before then
    const downloadEvent = page.waitForEvent('download', { timeout: 28 * 60_000 });
    const started = Date.now();
    const issued = await clickDownload(page, row);
    expect(issued.sizeBytes).toBe(target.sizeBytes);
    expect(issued.mode).toBe('split');
    metric('export(firefox): 2GiB download path', issued.path);

    const split = splitRow(page, target.name);
    await expectSplitStatus(split, 'running', 60_000);
    await expect(split).toHaveAttribute('data-delivery', 'export');
    await expect(split).toHaveAttribute('data-storage', 'opfs');
    await expect(notice(page, '분할 다운로드를 시작했습니다')).toBeVisible();
    await expect(notice(page, '저장 위치 선택 없음')).toBeVisible(); // diskHintExport
    const planned = (await readSplitRecords(page)).find((r) => r.downloadId === issued.downloadId);
    expect(planned?.storage).toBe('opfs');
    expect(planned?.parts.map((p) => [p.start, p.end])).toEqual([[0, target.sizeBytes - 1]]); // one 8 GiB-sized part

    // pause mid-transfer: the part files hold exactly the persisted progress
    const pctBeforePause = await waitForProgressAbove(split, 5, 5 * 60_000);
    const tPause = Date.now();
    metric('export(firefox): start → 5% (pause)', formatMs(tPause - started));
    await pauseSplit(split);
    expect((await splitState(split)).reason).toBe('USER');
    const pausedPct = await splitPercent(split);
    expect(pausedPct).toBeGreaterThanOrEqual(pctBeforePause);
    const pausedRecord = (await readSplitRecords(page)).find((r) => r.downloadId === issued.downloadId);
    expect(await opfsPartSizes(page, issued.downloadId)).toEqual(
      pausedRecord?.parts.map((p) => p.receivedBytes),
    );

    // resume, then reload mid-transfer (scenario 5 in Firefox: no close(), the tab simply goes away)
    await resumeSplit(split);
    const pctBeforeReload = await waitForProgressAbove(split, pausedPct + 10, 5 * 60_000);
    const before = (await readSplitRecords(page)).find((r) => r.downloadId === issued.downloadId);
    const bytesBeforeReload = before!.parts.reduce((s, p) => s + p.receivedBytes, 0);
    metric('export(firefox): reload point', `${pctBeforeReload}% (${bytesBeforeReload} B)`);
    await page.reload();

    const afterReload = splitRow(page, target.name);
    await expectSplitStatus(afterReload, 'paused', 60_000);
    expect((await splitState(afterReload)).reason).toBe('INTERRUPTED');
    const after = (await readSplitRecords(page)).find((r) => r.downloadId === issued.downloadId);
    const bytesAfterReload = after!.parts.reduce((s, p) => s + p.receivedBytes, 0);
    expect(bytesAfterReload).toBeGreaterThanOrEqual(bytesBeforeReload); // durable progress, nothing rolled back
    const partSizes = await opfsPartSizes(page, issued.downloadId);
    expect(partSizes!.map((s, i) => s >= after!.parts[i]!.receivedBytes)).toEqual([true]);
    metric('export(firefox): progress kept across reload', `${bytesBeforeReload} B → ${bytesAfterReload} B`);

    // resume → remaining parts → verification of the parts → hand-over to the browser download
    await resumeSplit(afterReload);
    const tResume = Date.now();
    await expect(afterReload).toHaveAttribute('data-status', /verifying|exporting|complete/, {
      timeout: 12 * 60_000,
    });
    const tVerifying = Date.now();
    await expect(afterReload).toHaveAttribute('data-status', /exporting|complete/, { timeout: 10 * 60_000 });
    const tExporting = Date.now();
    await expect(notice(page, '브라우저 다운로드로 전달합니다')).toBeVisible();
    metric('export(firefox): resume after reload → all parts received', formatMs(tVerifying - tResume));
    metric('export(firefox): CRC32 over the OPFS parts', formatMs(tExporting - tVerifying));

    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe(target.name);
    const savedPath = await download.path(); // resolves when the browser finished writing the file
    const tSaved = Date.now();
    metric('export(firefox): browser download of the stream', formatMs(tSaved - tExporting));
    expect(statSync(savedPath).size).toBe(target.sizeBytes);
    const crc = await fileCrc32(savedPath);
    metric(
      'export(firefox): CRC32 of the saved file',
      `${crc.base64} (${crc.bytes} B in ${formatMs(crc.elapsedMs)})`,
    );
    expect(crc.base64).toBe(target.crc32);

    await expectSplitStatus(afterReload, 'complete', 5 * 60_000);
    await expect(afterReload).toHaveAttribute('data-export-mode', 'stream');
    await expect(notice(page, `무결성 검증 완료: ${target.name}`)).toBeVisible();
    await expect(notice(page, `다운로드 완료: ${target.name}`)).toBeVisible();
    const stored = (await readSplitRecords(page)).find((r) => r.downloadId === issued.downloadId);
    expect(stored?.status).toBe('complete');
    expect(stored?.parts.every((p) => p.done)).toBe(true);
    expect(await opfsPartSizes(page, issued.downloadId)).toBeUndefined(); // stream ended → parts deleted
    metric('export(firefox): total wall time (incl. pause)', formatMs(Date.now() - started));
  });

  test('Chromium without File System Access (Brave / Safari ≤ 26 stand-in): 12 GiB → Blob hand-over → CRC32; parts kept until removed', async ({
    page,
    creds,
    browserName,
  }) => {
    test.skip(
      browserName !== 'chromium',
      'uses the Chromium persistent profile with the save picker removed',
    );
    test.setTimeout(30 * 60_000);
    await removeFileSystemAccess(page, 'blob');
    await signIn(page, creds);
    await openLocation(page, DEV.locations.demo);
    const row = fileRow(page, OBJECTS.gib12.name);
    await waitForRowStatus(row);
    expect(await methodBadge(row)).toBe('분할·이어받기');
    expect(await page.evaluate(() => typeof window.showSaveFilePicker)).toBe('undefined');

    const downloadEvent = page.waitForEvent('download', { timeout: 28 * 60_000 });
    const started = Date.now();
    const issued = await clickDownload(page, row);
    expect(issued.sizeBytes).toBe(12 * GiB);
    metric('export(blob): 12GiB download path', issued.path);

    const split = splitRow(page, OBJECTS.gib12.name);
    await expectSplitStatus(split, 'running', 60_000);
    await expect(split).toHaveAttribute('data-delivery', 'export');
    await expect(split).toHaveAttribute('data-storage', 'opfs');
    await expect(split).toHaveAttribute('data-status', /verifying|exporting|complete/, {
      timeout: 15 * 60_000,
    });
    const tVerifying = Date.now();
    metric('export(blob): all parts received', formatMs(tVerifying - started));
    await expect(split).toHaveAttribute('data-status', /exporting|complete/, { timeout: 10 * 60_000 });
    const tExporting = Date.now();
    metric('export(blob): CRC32 over the OPFS parts', formatMs(tExporting - tVerifying));

    // the Blob hand-over is instantaneous for the engine: complete + blob, parts kept, "hand over again" offered
    await expectSplitStatus(split, 'complete', 5 * 60_000);
    await expect(split).toHaveAttribute('data-export-mode', 'blob');
    await expect(split.getByTestId('export-keep-hint')).toBeVisible();
    await expect(split.getByTestId('export-again')).toBeVisible();
    await expect(notice(page, '브라우저 다운로드로 전달했습니다')).toBeVisible();
    expect((await opfsPartSizes(page, issued.downloadId))?.reduce((s, b) => s + b, 0)).toBe(12 * GiB);

    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe(OBJECTS.gib12.name);
    const savedPath = await download.path();
    const tSaved = Date.now();
    metric('export(blob): browser copy of the Blob', formatMs(tSaved - tExporting));
    expect(statSync(savedPath).size).toBe(12 * GiB);
    const crc = await fileCrc32(savedPath);
    metric(
      'export(blob): CRC32 of the saved file',
      `${crc.base64} (${crc.bytes} B in ${formatMs(crc.elapsedMs)})`,
    );
    expect(crc.base64).toBe(OBJECTS.gib12.crc32);

    // removing the entry is what releases the kept parts
    await split.getByRole('button', { name: '목록에서 제거' }).click();
    await expect(page.getByTestId('split-download')).toHaveCount(0);
    expect(await opfsPartSizes(page, issued.downloadId)).toBeUndefined();
    expect((await readSplitRecords(page)).find((r) => r.downloadId === issued.downloadId)).toBeUndefined();
    metric('export(blob): total wall time', formatMs(Date.now() - started));
  });
});
