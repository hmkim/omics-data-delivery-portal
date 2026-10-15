// D8 capability probe: which of the split engine's building blocks each Playwright browser exposes, on the main
// thread AND inside a worker (createSyncAccessHandle is worker-only in Firefox, so a main-thread prototype check
// under-reports it -- that is why the planner probes from a worker). Needs the Vite dev server on :5173.
// Usage: node e2e/scripts/probe-d8-capability.mjs
import { firefox, chromium } from '@playwright/test';
for (const [name, type] of [
  ['firefox', firefox],
  ['chromium', chromium],
]) {
  const browser = await type.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/');
  const r = await page.evaluate(async () => {
    const main = {
      getDirectory: typeof navigator.storage?.getDirectory,
      FileSystemFileHandle: typeof globalThis.FileSystemFileHandle,
      syncOnMainProto:
        typeof globalThis.FileSystemFileHandle === 'function' &&
        'createSyncAccessHandle' in FileSystemFileHandle.prototype,
      showSaveFilePicker: typeof window.showSaveFilePicker,
      FileSystemSyncAccessHandle: typeof globalThis.FileSystemSyncAccessHandle,
    };
    const worker = await new Promise((resolve) => {
      const code = `self.onmessage = async () => { const r = { syncOnWorkerProto: typeof FileSystemFileHandle === 'function' && 'createSyncAccessHandle' in FileSystemFileHandle.prototype, getDirectory: typeof navigator.storage?.getDirectory, FileSystemSyncAccessHandle: typeof self.FileSystemSyncAccessHandle }; try { const root = await navigator.storage.getDirectory(); const d = await root.getDirectoryHandle('probe-d8', { create: true }); const f = await d.getFileHandle('p', { create: true }); const h = await f.createSyncAccessHandle(); r.writeReturns = typeof h.write(new Uint8Array(4), { at: 0 }); r.flushReturns = typeof h.flush(); h.close(); await root.removeEntry('probe-d8', { recursive: true }); r.ok = true; } catch (e) { r.err = String(e); } postMessage(r); };`;
      const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
      w.onmessage = (e) => resolve(e.data);
      w.onerror = (e) => resolve({ workerError: e.message });
      w.postMessage(1);
    });
    return { main, worker, ua: navigator.userAgent };
  });
  console.log(name, JSON.stringify(r, null, 1));
  await browser.close();
}
