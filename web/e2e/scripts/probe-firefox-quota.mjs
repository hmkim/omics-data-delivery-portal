// Firefox OPFS quota probe: can a worker reserve 12 GiB (+ margin) and 2 GiB via truncate()+flush(), before and
// after navigator.storage.persist(), with and without the storage-prompt test prefs the e2e Firefox project sets.
// Firefox's group limit is a share of free disk, not Chromium's 10 GiB-capped estimate. Needs Vite on :5173.
// Usage: node e2e/scripts/probe-firefox-quota.mjs
import { firefox } from '@playwright/test';
const prefs = {
  'dom.storageManager.prompt.testing': true,
  'dom.storageManager.prompt.testing.allow': true,
};
for (const withPrefs of [false, true]) {
  const browser = await firefox.launch({ headless: true, firefoxUserPrefs: withPrefs ? prefs : {} });
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/');
  const r = await page.evaluate(async () => {
    const out = {};
    out.estimateBefore = await navigator.storage.estimate();
    out.persistedBefore = await navigator.storage.persisted();
    const probe = (bytes) =>
      new Promise((resolve) => {
        const code = `self.onmessage = async (e) => { const r = {}; try { const root = await navigator.storage.getDirectory(); const d = await root.getDirectoryHandle('probe-q', { create: true }); const f = await d.getFileHandle('p', { create: true }); const h = await f.createSyncAccessHandle(); const t0 = performance.now(); try { h.truncate(e.data); h.flush(); r.size = h.getSize(); } finally { try { h.truncate(0); } catch {} h.close(); } r.ms = performance.now() - t0; await root.removeEntry('probe-q', { recursive: true }); r.ok = true; } catch (err) { r.err = String(err); r.name = err && err.name; } postMessage(r); };`;
        const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
        w.onmessage = (ev) => resolve(ev.data);
        w.onerror = (ev) => resolve({ workerError: ev.message });
        w.postMessage(bytes);
      });
    out.probe12g = await probe(12 * 1024 ** 3 + 256 * 1024 ** 2);
    out.probe2g = await probe(2 * 1024 ** 3);
    out.persistResult = await Promise.race([
      navigator.storage.persist(),
      new Promise((r) => setTimeout(() => r('timeout'), 5000)),
    ]);
    out.persistedAfter = await navigator.storage.persisted();
    out.probe12gAfterPersist = await probe(12 * 1024 ** 3 + 256 * 1024 ** 2);
    out.estimateAfter = await navigator.storage.estimate();
    return out;
  });
  console.log(withPrefs ? 'WITH persist prefs' : 'NO prefs', JSON.stringify(r, null, 1));
  await browser.close();
}
