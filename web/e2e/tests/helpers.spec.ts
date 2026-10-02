import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { installPickFileHook, opfsCrc32, opfsFileSize, pickedNames, removeOpfsFile } from '../helpers/opfs';
import { fileCrc32Base64, listZipEntries } from '../helpers/zip';

/**
 * Credential-free self-test of the suite's own measuring instruments (they must not be trusted blindly either):
 * the OPFS pick-file hook, the in-page CRC32 and the zip central-directory reader, each against Node's zlib CRC32.
 */
function crc32Base64(buf: Buffer): string {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(crc32(buf) >>> 0);
  return b.toString('base64');
}

function deterministicBytes(n: number, seed: number): Buffer {
  const out = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

test('pickFile hook returns an OPFS handle and opfsCrc32 matches zlib', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the split engine (and the hook) is Chromium-only');
  await installPickFileHook(page);
  await page.goto('/');
  const bytes = deterministicBytes(3 * 1024 * 1024 + 17, 42);
  const expected = crc32Base64(bytes);
  await page.evaluate(
    async ({ name, b64 }) => {
      const hook = (
        window as Window & { __portalTest?: { pickFile?: (n: string) => Promise<FileSystemFileHandle> } }
      ).__portalTest?.pickFile;
      if (!hook) throw new Error('hook missing');
      const handle = await hook(name);
      const w = await handle.createWritable();
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      await w.write(arr);
      await w.close();
    },
    { name: 'selftest.bin', b64: bytes.toString('base64') },
  );
  expect(await pickedNames(page)).toEqual(['selftest.bin']);
  expect(await opfsFileSize(page, 'selftest.bin')).toBe(bytes.length);
  const crc = await opfsCrc32(page, 'selftest.bin');
  expect(crc.bytes).toBe(bytes.length);
  expect(crc.base64).toBe(expected);
  await removeOpfsFile(page, 'selftest.bin');
});

test('listZipEntries reads names, sizes and CRC32 from a zip central directory', async () => {
  const dir = mkdtempSync(join(process.env.PORTAL_SCRATCH ?? tmpdir(), 'e2e-zip-'));
  const a = deterministicBytes(70_001, 1);
  const b = deterministicBytes(1_234_567, 2);
  writeFileSync(join(dir, 'a.bin'), a);
  writeFileSync(join(dir, 'b.bin'), b);
  const zipPath = join(dir, 'test.zip');
  try {
    await promisify(execFile)('python3', [
      '-m',
      'zipfile',
      '-c',
      zipPath,
      join(dir, 'a.bin'),
      join(dir, 'b.bin'),
    ]);
  } catch (err) {
    test.skip(true, `python3 zipfile unavailable: ${(err as Error).message}`);
  }
  const entries = await listZipEntries(zipPath);
  expect(entries.map((e) => [e.name, e.uncompressedSize, e.crc32Base64])).toEqual([
    ['a.bin', a.length, crc32Base64(a)],
    ['b.bin', b.length, crc32Base64(b)],
  ]);
  expect(await fileCrc32Base64(join(dir, 'b.bin'))).toBe(crc32Base64(b));
});
