import type { Page } from '@playwright/test';

/**
 * Installs `window.__portalTest.pickFile` before any page script runs: the SPA's save-target chooser
 * (`web/src/download/planner.ts#pickSaveFile`) calls it instead of `showSaveFilePicker`, and the returned handle is
 * a file in the origin-private file system (OPFS) of the test profile. It survives reloads (IndexedDB stores the
 * handle) and is deleted with the browser context.
 */
export async function installPickFileHook(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as Window & {
      __portalTest?: {
        pickFile?: (suggestedName: string) => Promise<FileSystemFileHandle>;
        picked?: string[];
      };
    };
    w.__portalTest = {
      picked: [],
      pickFile: async (suggestedName: string) => {
        const dir = await navigator.storage.getDirectory();
        w.__portalTest?.picked?.push(suggestedName);
        return dir.getFileHandle(suggestedName, { create: true });
      },
    };
  });
}

/** Names the hook was asked for since the last navigation. */
export function pickedNames(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as Window & { __portalTest?: { picked?: string[] } }).__portalTest?.picked ?? [],
  );
}

export function opfsFileSize(page: Page, name: string): Promise<number> {
  return page.evaluate(async (n) => {
    const dir = await navigator.storage.getDirectory();
    const handle = await dir.getFileHandle(n);
    return (await handle.getFile()).size;
  }, name);
}

export async function removeOpfsFile(page: Page, name: string): Promise<void> {
  await page.evaluate(async (n) => {
    const dir = await navigator.storage.getDirectory();
    await dir.removeEntry(n).catch(() => undefined);
  }, name);
}

export interface Crc32Result {
  /** base64 of the 4-byte big-endian CRC32 (S3 `x-amz-checksum-crc32` encoding) */
  base64: string;
  bytes: number;
  elapsedMs: number;
}

/**
 * Independent CRC32 of an OPFS file, computed in the page with a plain table-driven implementation (not the SPA's
 * hash-wasm path) so the assertion does not trust the code under test. ~0.5 GB/s: a 12 GiB file takes ~25–40 s.
 */
export function opfsCrc32(page: Page, name: string): Promise<Crc32Result> {
  return page.evaluate(async (n) => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    const dir = await navigator.storage.getDirectory();
    const file = await (await dir.getFileHandle(n)).getFile();
    const started = performance.now();
    let crc = 0xffffffff;
    let bytes = 0;
    const reader = file.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let i = 0; i < value.length; i++) crc = table[(crc ^ value[i]!) & 0xff]! ^ (crc >>> 8);
      bytes += value.length;
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const digest = String.fromCharCode(
      (crc >>> 24) & 0xff,
      (crc >>> 16) & 0xff,
      (crc >>> 8) & 0xff,
      crc & 0xff,
    );
    return { base64: btoa(digest), bytes, elapsedMs: performance.now() - started };
  }, name);
}

/** Split records as persisted in IndexedDB (`genome-portal` / `splits`), without the file handle. */
export async function readSplitRecords(page: Page) {
  return page.evaluate(
    () =>
      new Promise<
        Array<{
          downloadId: string;
          filename: string;
          status: string;
          reason?: string;
          /** 'opfs' (plan A: durable part files) or 'direct' (plan C fallback) */
          storage?: string;
          merged?: boolean;
          renewCount: number;
          parts: Array<{
            idx: number;
            start: number;
            end: number;
            done: boolean;
            receivedBytes: number;
            committedBytes?: number;
          }>;
        }>
      >((resolve, reject) => {
        const req = indexedDB.open('genome-portal');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('splits', 'readonly');
          const all = tx.objectStore('splits').getAll();
          all.onsuccess = () =>
            resolve(
              (all.result as Array<Record<string, unknown>>).map((r) => ({
                downloadId: r.downloadId as string,
                filename: r.filename as string,
                status: r.status as string,
                reason: r.reason as string | undefined,
                storage: r.storage as string | undefined,
                merged: r.merged as boolean | undefined,
                renewCount: r.renewCount as number,
                parts: r.parts as never,
              })),
            );
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

/**
 * Sizes of the engine's durable part files for a download (`genome-portal-splits/<downloadId>/part-NNNN`, design
 * §5.4 plan A); `undefined` when the directory does not exist (never created, or deleted after the merge).
 */
export function opfsPartSizes(page: Page, downloadId: string): Promise<number[] | undefined> {
  return page.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory();
    let dir: FileSystemDirectoryHandle;
    try {
      const splits = await root.getDirectoryHandle('genome-portal-splits');
      dir = await splits.getDirectoryHandle(id);
    } catch {
      return undefined;
    }
    const sizes: Array<[string, number]> = [];
    for await (const [name, handle] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (handle.kind === 'file') sizes.push([name, (await (handle as FileSystemFileHandle).getFile()).size]);
    }
    return sizes.sort(([a], [b]) => a.localeCompare(b)).map(([, size]) => size);
  }, downloadId);
}
