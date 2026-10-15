// Firefox SW-stream export probe: does removing the hidden navigation iframe BEFORE the browser finished saving
// abort/truncate the download? Streams 2 GiB through the export SW twice -- iframe removed 3 s after navigation,
// then iframe kept. Finding (2026-10-14): with the iframe removed early, Firefox never settles the download at all
// (download.path() hangs; the first version of this probe hung 2.4 h on it), and the real engine truncated a 12 GiB
// file at 5.4 GB when its fixed 60 s linger timer removed the iframe mid-download. The iframe must outlive the
// stream (exportDelivery.ts, "iframe lifetime" invariant). Needs Vite on :5173 serving /portal-export/export-sw.js.
// Usage: node e2e/scripts/probe-firefox-sw-export.mjs
import { firefox } from '@playwright/test';
import { statSync } from 'node:fs';
const GiB = 1024 ** 3;
const SIZE = 2 * GiB;
const PATH_TIMEOUT_MS = 180_000; // a settled 2 GiB download reports its path within seconds; a hang means "truncated"
async function run(removeFrameAfterMs) {
  const browser = await firefox.launch({ headless: true });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  await page.goto('http://localhost:5173/');
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.register('/portal-export/export-sw.js', {
      scope: '/portal-export/',
    });
    await navigator.serviceWorker.ready;
    if (!reg.active) await new Promise((r) => setTimeout(r, 1000));
  });
  const dl = page.waitForEvent('download', { timeout: 120_000 });
  const t0 = Date.now();
  const result = await page.evaluate(
    async ({ size, removeAfter }) => {
      const reg = await navigator.serviceWorker.getRegistration('/portal-export/');
      const active = reg.active;
      let produced = 0;
      let closed = false;
      const chunk = new Uint8Array(4 * 1024 * 1024).fill(7);
      const stream = new ReadableStream({
        pull(controller) {
          if (produced >= size) {
            controller.close();
            closed = true;
            return;
          }
          const n = Math.min(chunk.byteLength, size - produced);
          controller.enqueue(n === chunk.byteLength ? chunk.slice() : chunk.slice(0, n));
          produced += n;
        },
        cancel(reason) {
          window.__cancelReason = String(reason);
        },
      });
      const id = 'probe-' + Date.now();
      const { port1, port2 } = new MessageChannel();
      const ready = new Promise((resolve) => {
        port1.onmessage = () => resolve(true);
      });
      active.postMessage({ downloadId: id, filename: 'probe.bin', size, stream }, [stream, port2]);
      await ready;
      const frame = document.createElement('iframe');
      frame.hidden = true;
      frame.src = '/portal-export/' + encodeURIComponent(id);
      document.body.appendChild(frame);
      const keepalive = setInterval(() => active.postMessage({ type: 'keepalive' }), 10_000);
      if (removeAfter >= 0) setTimeout(() => frame.remove(), removeAfter);
      // wait until the stream is fully pulled or 90 s
      const started = Date.now();
      while (!closed && Date.now() - started < 90_000) await new Promise((r) => setTimeout(r, 200));
      clearInterval(keepalive);
      return { produced, closed, cancelReason: window.__cancelReason, pullMs: Date.now() - started };
    },
    { size: SIZE, removeAfter: removeFrameAfterMs },
  );
  const download = await dl;
  const failure = await download.failure();
  let size = -1;
  try {
    const path = await Promise.race([
      download.path(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`download not settled after ${PATH_TIMEOUT_MS} ms`)),
          PATH_TIMEOUT_MS,
        ),
      ),
    ]);
    size = statSync(path).size;
  } catch (e) {
    size = `path error: ${e.message}`;
  }
  console.log(
    JSON.stringify({ removeFrameAfterMs, ...result, failure, savedSize: size, totalMs: Date.now() - t0 }),
  );
  await browser.close();
}
await run(3000); // frame removed 3 s after navigation
await run(-1); // frame kept
