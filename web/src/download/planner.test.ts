import { SINGLE_OBJECT_LIMIT_BYTES, SPLIT_THRESHOLD_BYTES } from '@genome-portal/contract';
import { describe, expect, it, vi } from 'vitest';
import { buildCommands, shellQuote } from './commandFallback';
import { decide, hasFileSystemAccess, pickSaveFile, settingsFromConfig } from './planner';

const GiB = 1024 ** 3;
const settings = {
  splitThresholdBytes: SPLIT_THRESHOLD_BYTES,
  singleObjectLimitBytes: SINGLE_OBJECT_LIMIT_BYTES,
};
const fs = (hasFileSystemAccess: boolean) => ({ hasFileSystemAccess, settings });

describe('download/planner (T3.6) — §5.4 matrix', () => {
  it.each([
    // size, FS Access, expected
    [512 * 1024 ** 2, true, 'single'],
    [512 * 1024 ** 2, false, 'single'],
    [12 * GiB, true, 'split'],
    [12 * GiB, false, 'single'],
    [150_000_000_000, true, 'split'],
    [150_000_000_000, false, 'command'],
  ] as const)('size=%d fsAccess=%s → %s', (size, access, expected) => {
    expect(decide({ sizeBytes: size }, fs(access))).toBe(expected);
  });

  it('boundary: 1 GiB exactly is single, 1 GiB + 1 B switches to split / single+hint', () => {
    expect(decide({ sizeBytes: GiB }, fs(true))).toBe('single');
    expect(decide({ sizeBytes: GiB }, fs(false))).toBe('single');
    expect(decide({ sizeBytes: GiB - 1 }, fs(true))).toBe('single');
    expect(decide({ sizeBytes: GiB + 1 }, fs(true))).toBe('split');
    expect(decide({ sizeBytes: GiB + 1 }, fs(false))).toBe('single');
  });

  it('boundary: 50 GB exactly stays single (no FS Access), 50 GB + 1 B becomes command', () => {
    expect(decide({ sizeBytes: 50_000_000_000 }, fs(false))).toBe('single');
    expect(decide({ sizeBytes: 50_000_000_000 - 1 }, fs(false))).toBe('single');
    expect(decide({ sizeBytes: 50_000_000_000 + 1 }, fs(false))).toBe('command');
    expect(decide({ sizeBytes: 50_000_000_000 + 1 }, fs(true))).toBe('split');
    expect(decide({ sizeBytes: 50_000_000_000 - 1 }, fs(true))).toBe('split');
  });

  it('reads thresholds from config.json by default', () => {
    expect(settingsFromConfig()).toEqual(settings);
    expect(decide({ sizeBytes: 2 * GiB }, { hasFileSystemAccess: true })).toBe('split');
  });

  it("detects File System Access via 'showSaveFilePicker' in window", () => {
    expect(hasFileSystemAccess({} as Window)).toBe(false);
    expect(
      hasFileSystemAccess({ showSaveFilePicker: async () => ({}) as FileSystemFileHandle } as Window),
    ).toBe(true);
    expect(hasFileSystemAccess(undefined)).toBe(false);
  });
});

describe('download/planner — pickSaveFile test hook (T7.1)', () => {
  const handle = { name: 'h' } as unknown as FileSystemFileHandle;

  it('uses the native picker when no hook is installed (production behaviour)', async () => {
    const showSaveFilePicker = vi.fn(async () => handle);
    await expect(pickSaveFile('sample.bin', { showSaveFilePicker } as unknown as Window)).resolves.toBe(
      handle,
    );
    expect(showSaveFilePicker).toHaveBeenCalledWith({ suggestedName: 'sample.bin' });
  });

  it('prefers window.__portalTest.pickFile when present and never opens the native dialog', async () => {
    const showSaveFilePicker = vi.fn(async () => ({}) as FileSystemFileHandle);
    const pickFile = vi.fn(async () => handle);
    const win = { showSaveFilePicker, __portalTest: { pickFile } } as unknown as Window;
    await expect(pickSaveFile('sample.bin', win)).resolves.toBe(handle);
    expect(pickFile).toHaveBeenCalledWith('sample.bin');
    expect(showSaveFilePicker).not.toHaveBeenCalled();
  });

  it('ignores a __portalTest object without pickFile and errors without the API', async () => {
    const win = { __portalTest: {} } as unknown as Window;
    await expect(pickSaveFile('sample.bin', win)).rejects.toThrow(/File System Access API/);
    await expect(pickSaveFile('sample.bin', undefined)).rejects.toThrow(/File System Access API/);
  });
});

describe('download/commandFallback (T3.6)', () => {
  const url =
    'https://d111111abcdef8.cloudfront.net/projects/DEMO-0001/sample02.bam?Expires=1790000000&Signature=abc~def_ghi&Key-Pair-Id=K2JCJMDEHXQW5F';

  it('aria2c and curl command strings (snapshot)', () => {
    expect(buildCommands({ filename: 'sample02.bam', url })).toMatchInlineSnapshot(`
      {
        "aria2c": "aria2c -x 4 -s 4 -k 8G --file-allocation=none -o "sample02.bam" "https://d111111abcdef8.cloudfront.net/projects/DEMO-0001/sample02.bam?Expires=1790000000&Signature=abc~def_ghi&Key-Pair-Id=K2JCJMDEHXQW5F"",
        "curl": "curl -L -C - -o "sample02.bam" "https://d111111abcdef8.cloudfront.net/projects/DEMO-0001/sample02.bam?Expires=1790000000&Signature=abc~def_ghi&Key-Pair-Id=K2JCJMDEHXQW5F"",
      }
    `);
  });

  it('quotes filenames with spaces and escapes shell-special characters', () => {
    expect(shellQuote('my file.bam')).toBe('"my file.bam"');
    expect(shellQuote('a"b$c`d\\e')).toBe('"a\\"b\\$c\\`d\\\\e"');
    expect(shellQuote('line\nbreak')).toBe('"linebreak"');
    const cmds = buildCommands({ filename: 'sample 01 $x.vcf.gz', url: 'https://h/k' });
    expect(cmds.curl).toBe('curl -L -C - -o "sample 01 \\$x.vcf.gz" "https://h/k"');
  });
});
