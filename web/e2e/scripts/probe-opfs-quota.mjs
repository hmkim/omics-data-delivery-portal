// Probe the storage facts the split engine's storage choice depends on, in the same kind of Chromium profile the
// e2e fixture uses (persistent context under os.tmpdir()). Usage: node e2e/scripts/probe-opfs-quota.mjs [url]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'https://d111111abcdef8.cloudfront.net/';
const userDataDir = mkdtempSync(join(tmpdir(), 'genome-portal-probe-'));
const ctx = await chromium.launchPersistentContext(userDataDir, { headless: true });
try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const facts = await page.evaluate(async () => {
    const est = await navigator.storage.estimate();
    const persisted = await navigator.storage.persisted();
    let opfs = 'n/a';
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('probe', { create: true });
      const fh = await dir.getFileHandle('p0', { create: true });
      // sync access handles only exist in workers; probe that from a blob worker
      const code = `self.onmessage = async () => { try { const root = await navigator.storage.getDirectory(); const dir = await root.getDirectoryHandle('probe'); const fh = await dir.getFileHandle('p0'); const h = await fh.createSyncAccessHandle(); h.write(new Uint8Array(1024 * 1024), { at: 0 }); h.flush(); const size = h.getSize(); const limits = []; for (const gib of [5, 9, 11, 13, 20, 40, 80, 160, 320]) { try { h.truncate(gib * 1024 ** 3); h.flush(); limits.push([gib, 'ok']); } catch (e) { limits.push([gib, e.name]); break; } } h.truncate(0); h.close(); postMessage({ ok: true, size, limits }); } catch (e) { postMessage({ ok: false, err: String(e) }); } };`;
      const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
      opfs = await new Promise((resolve) => {
        w.onmessage = (e) => resolve(JSON.stringify(e.data));
        w.onerror = (e) => resolve('worker error: ' + e.message);
        w.postMessage('go');
      });
      await root.removeEntry('probe', { recursive: true });
      void fh;
    } catch (e) {
      opfs = 'error: ' + String(e);
    }
    return {
      quota: est.quota,
      usage: est.usage,
      quotaGiB: (est.quota ?? 0) / 1024 ** 3,
      persisted,
      opfs,
      ua: navigator.userAgent,
    };
  });
  console.log(JSON.stringify({ userDataDir, ...facts }, null, 2));
} finally {
  await ctx.close();
  rmSync(userDataDir, { recursive: true, force: true });
}
