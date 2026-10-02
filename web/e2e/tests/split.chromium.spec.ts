import { expect, test } from '../fixtures';
import { signIn } from '../helpers/auth';
import { DEV, formatMs, GiB, metric, OBJECTS } from '../helpers/env';
import {
  installPickFileHook,
  opfsCrc32,
  opfsFileSize,
  opfsPartSizes,
  pickedNames,
  readSplitRecords,
} from '../helpers/opfs';
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

test.describe.configure({ mode: 'serial' });

test.describe('T7.2 Chromium downloads (R5.1–R5.4, scenarios 2·5)', () => {
  test('1 GiB → ordinary browser download, no badge', async ({ page, creds }) => {
    await signIn(page, creds);
    await openLocation(page, DEV.locations.demo);
    const row = fileRow(page, OBJECTS.gib1.name);
    await expect(row).toBeVisible();
    await waitForRowStatus(row);
    expect(await methodBadge(row)).toBe('');

    const downloadEvent = page.waitForEvent('download', { timeout: 60_000 });
    const issued = await clickDownload(page, row);
    expect(issued.sizeBytes).toBe(GiB);
    expect(issued.mode).toBe('single');
    expect(issued.checksumCrc32).toBe(OBJECTS.gib1.crc32);
    await expect(notice(page, /S3에서 직접 전송합니다|CloudFront\(CDN\)를 통해 전송합니다/)).toBeVisible();

    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe(OBJECTS.gib1.name);
    expect(new URL(download.url()).pathname).toContain('/projects/DEMO-0001/sample-1gib.bin');
    await download.cancel(); // no need to finish 1 GiB; the split panel stays empty
    await expect(page.getByTestId('split-download')).toHaveCount(0);
    metric('1GiB download path', issued.path);
  });

  test('12 GiB → split (2 parts) → pause → resume → reload → resume → complete → CRC32', async ({
    page,
    creds,
  }) => {
    test.setTimeout(20 * 60_000);
    await installPickFileHook(page);
    await signIn(page, creds);
    await openLocation(page, DEV.locations.demo);
    const row = fileRow(page, OBJECTS.gib12.name);
    await waitForRowStatus(row);
    expect(await methodBadge(row)).toBe('분할·이어받기');

    const started = Date.now();
    const issued = await clickDownload(page, row);
    expect(issued.sizeBytes).toBe(12 * GiB);
    expect(issued.mode).toBe('split');
    expect(issued.checksumCrc32).toBe(OBJECTS.gib12.crc32);
    metric('12GiB download path', issued.path);

    const split = splitRow(page, OBJECTS.gib12.name);
    await expectSplitStatus(split, 'running', 60_000);
    expect(await pickedNames(page)).toContain(OBJECTS.gib12.name); // hook was used instead of showSaveFilePicker
    await expect(notice(page, '분할 다운로드를 시작했습니다')).toBeVisible();
    // plan A (design §5.4): the persistent profile has disk-backed OPFS, so parts go to durable part files
    await expect(split).toHaveAttribute('data-storage', 'opfs');

    // plan: 8 GiB + 4 GiB
    const planned = await readSplitRecords(page);
    const record = planned.find((r) => r.downloadId === issued.downloadId);
    expect(record?.storage).toBe('opfs');
    expect(record?.parts.map((p) => [p.start, p.end])).toEqual([
      [0, 8 * GiB - 1],
      [8 * GiB, 12 * GiB - 1],
    ]);
    expect((await splitState(split)).parts).toBe(2);

    // pause mid-transfer
    const pctBeforePause = await waitForProgressAbove(split, 5, 5 * 60_000);
    const tPause = Date.now();
    metric('split: start → 5% (first pause)', formatMs(tPause - started));
    await pauseSplit(split);
    expect((await splitState(split)).reason).toBe('USER');
    const pausedPct = await splitPercent(split);
    await page.waitForTimeout(3000);
    expect(await splitPercent(split)).toBe(pausedPct); // nothing moves while paused
    expect(pausedPct).toBeGreaterThanOrEqual(pctBeforePause);
    // the destination is untouched until the merge; the part files hold exactly the persisted progress
    const pausedRecord = (await readSplitRecords(page)).find((r) => r.downloadId === issued.downloadId);
    const pausedPartSizes = await opfsPartSizes(page, issued.downloadId);
    expect(pausedPartSizes).toEqual(pausedRecord?.parts.map((p) => p.receivedBytes));

    // resume, then reload the page mid-transfer (scenario 5: no pause, no close() — the tab simply goes away)
    await resumeSplit(split);
    await expect(notice(page, '일시정지된 다운로드를 이어받습니다')).toBeVisible();
    const pctBeforeReload = await waitForProgressAbove(split, pausedPct + 10, 5 * 60_000);
    const recordBeforeReload = (await readSplitRecords(page)).find((r) => r.downloadId === issued.downloadId);
    const bytesBeforeReload = recordBeforeReload!.parts.reduce((s, p) => s + p.receivedBytes, 0);
    const tReload = Date.now();
    metric('split: resume → +10% (reload point)', `${formatMs(tReload - tPause)} at ${pctBeforeReload}%`);
    await page.reload();

    // the persisted record comes back paused/INTERRUPTED; with durable part files nothing after the last pause is
    // lost (before plan A the destination's swap file was discarded here and the resume produced a corrupt file)
    const afterReload = splitRow(page, OBJECTS.gib12.name);
    await expectSplitStatus(afterReload, 'paused', 60_000);
    const persisted = await splitState(afterReload);
    expect(persisted.reason).toBe('INTERRUPTED');
    const recordAfterReload = (await readSplitRecords(page)).find((r) => r.downloadId === issued.downloadId);
    const bytesAfterReload = recordAfterReload!.parts.reduce((s, p) => s + p.receivedBytes, 0);
    expect(bytesAfterReload).toBeGreaterThanOrEqual(bytesBeforeReload); // durable progress is not rolled back
    expect(bytesAfterReload).toBeGreaterThan(pausedRecord!.parts.reduce((s, p) => s + p.receivedBytes, 0));
    const partSizesAfterReload = await opfsPartSizes(page, issued.downloadId);
    expect(partSizesAfterReload!.map((s, i) => s >= recordAfterReload!.parts[i]!.receivedBytes)).toEqual([
      true,
      true,
    ]);
    const pctAfterReload = await splitPercent(afterReload);
    expect(pctAfterReload).toBeGreaterThanOrEqual(pctBeforeReload - 1); // percent is floored
    metric(
      'split: progress kept across reload',
      `${pctBeforeReload}% → ${pctAfterReload}% (${bytesBeforeReload} B → ${bytesAfterReload} B)`,
    );

    // resume from the persisted state: transfer the rest → merge the parts into the destination → verify
    await resumeSplit(afterReload);
    const tResume = Date.now();
    await expect(afterReload).toHaveAttribute('data-status', /merging|verifying|complete/, {
      timeout: 12 * 60_000,
    });
    const tMerging = Date.now();
    await expect(notice(page, '파일로 병합하는 중입니다')).toBeVisible();
    await expect(afterReload).toHaveAttribute('data-status', /verifying|complete/, { timeout: 10 * 60_000 });
    const tVerifying = Date.now();
    await expectSplitStatus(afterReload, 'complete', 5 * 60_000);
    const tComplete = Date.now();
    metric('split: resume after reload → all parts received', formatMs(tMerging - tResume));
    metric('split: merge 12 GiB of parts into the destination', formatMs(tVerifying - tMerging));
    metric('split: SPA checksum verification', formatMs(tComplete - tVerifying));
    metric('split: total wall time (incl. pauses)', formatMs(tComplete - started));
    const final = await splitState(afterReload);
    expect(final.reason).toBe('');
    expect(final.progressText).toContain('파트 2/2');
    await expect(notice(page, `무결성 검증 완료: ${OBJECTS.gib12.name}`)).toBeVisible();
    await expect(notice(page, `다운로드 완료: ${OBJECTS.gib12.name}`)).toBeVisible();

    // independent verification of the OPFS file
    expect(await opfsFileSize(page, OBJECTS.gib12.name)).toBe(12 * GiB);
    const crc = await opfsCrc32(page, OBJECTS.gib12.name);
    metric(
      'split: independent CRC32 of OPFS file',
      `${crc.base64} (${crc.bytes} B in ${formatMs(crc.elapsedMs)})`,
    );
    expect(crc.base64).toBe(OBJECTS.gib12.crc32);

    const stored = (await readSplitRecords(page)).find((r) => r.downloadId === issued.downloadId);
    expect(stored?.status).toBe('complete');
    expect(stored?.merged).toBe(true);
    expect(stored?.parts.every((p) => p.done)).toBe(true);
    expect(await opfsPartSizes(page, issued.downloadId)).toBeUndefined(); // part files deleted after the merge
  });
});
