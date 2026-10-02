import { describe, expect, it, vi } from 'vitest';
import { AuthExpiredError } from '../api/client';
import { basename, mapLimit, planZip, runZip, type ZipItem } from './zip';

const GiB = 1024 ** 3;
const limit = { singleObjectLimitBytes: 50_000_000_000 };

describe('download/zip (T3.10)', () => {
  it('excludes files above the single-object limit and keeps 1 GiB–50 GB files', () => {
    const items: ZipItem[] = [
      { key: 'p/a.fastq.gz', sizeBytes: 1 * GiB },
      { key: 'p/b.fastq.gz', sizeBytes: 1 * GiB },
      { key: 'p/c.bam', sizeBytes: 53 * GiB },
    ];
    const plan = planZip(items, limit);
    expect(plan.included.map((i) => i.key)).toEqual(['p/a.fastq.gz', 'p/b.fastq.gz']);
    expect(plan.excludedOverLimit.map((i) => i.key)).toEqual(['p/c.bam']);
    expect(plan.totalBytes).toBe(2 * GiB);
    expect(plan.tooMany).toBe(false);
  });

  it('flags more than ZIP_MAX_FILES (5000)', () => {
    const items = Array.from({ length: 5001 }, (_, i) => ({ key: `k${i}`, sizeBytes: 1 }));
    expect(planZip(items, limit).tooMany).toBe(true);
    expect(planZip(items.slice(0, 5000), limit).tooMany).toBe(false);
  });

  it('basename and mapLimit(8) ordering', async () => {
    expect(basename('a/b/c.txt')).toBe('c.txt');
    let inflight = 0;
    let peak = 0;
    const out = await mapLimit([...Array(20).keys()], 8, async (n) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 1));
      inflight -= 1;
      return n * 2;
    });
    expect(out).toEqual([...Array(20).keys()].map((n) => n * 2));
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
  });

  it('runZip issues one POST /downloads per file, streams them into a zip blob (no SW), raises activeDownloads', async () => {
    const issue = vi.fn(async ({ key }: { bucket: string; key: string }) => ({
      downloadId: `dl-${key}`,
      url: `https://s3.example/${key}`,
      path: 'S3' as const,
      mode: 'single' as const,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      sizeBytes: 5,
      count: 1,
      filename: key,
    }));
    const fetchFn = vi.fn(
      async (u: RequestInfo | URL) => new Response(new TextEncoder().encode(`data:${String(u).slice(-1)}`)),
    );
    const session = { active: 0, incrementActiveDownloads: vi.fn(), decrementActiveDownloads: vi.fn() };
    const saved: Array<{ blob: Blob; filename: string }> = [];
    const outcome = await runZip(
      {
        items: [
          { key: 'p/a', sizeBytes: 6 },
          { key: 'p/b', sizeBytes: 6 },
        ],
        bucket: 'bkt',
        archiveName: 'p',
      },
      {
        api: { issueDownload: issue },
        session,
        fetchFn,
        serviceWorker: undefined,
        saveBlob: (blob, filename) => saved.push({ blob, filename }),
      },
    );
    expect(outcome).toEqual({ status: 'complete', bytes: 12, files: 2 });
    expect(issue).toHaveBeenCalledTimes(2);
    expect(issue.mock.calls.map((c) => c[0])).toEqual([
      { bucket: 'bkt', key: 'p/a' },
      { bucket: 'bkt', key: 'p/b' },
    ]);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.filename).toBe('p.zip');
    const bytes = new Uint8Array(await saved[0]!.blob.arrayBuffer());
    expect(bytes.subarray(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04])); // PK\3\4 local file header
    expect(session.incrementActiveDownloads).toHaveBeenCalledTimes(1);
    expect(session.decrementActiveDownloads).toHaveBeenCalledTimes(1);
  });

  it('AUTH_EXPIRED while issuing → failed/AUTH_EXPIRED (no resume, rebuild required)', async () => {
    const session = { incrementActiveDownloads: vi.fn(), decrementActiveDownloads: vi.fn() };
    const outcome = await runZip(
      { items: [{ key: 'k', sizeBytes: 1 }], bucket: 'b', archiveName: 'x' },
      {
        api: {
          issueDownload: async () => {
            throw new AuthExpiredError();
          },
        },
        session,
        serviceWorker: undefined,
        saveBlob: () => undefined,
      },
    );
    expect(outcome).toEqual({ status: 'failed', reason: 'AUTH_EXPIRED' });
    expect(session.decrementActiveDownloads).toHaveBeenCalledTimes(1);
  });

  it('Blob fallback refuses more than 2 GB without a service worker', async () => {
    const outcome = await runZip(
      { items: [{ key: 'k', sizeBytes: 3 * GiB }], bucket: 'b', archiveName: 'x' },
      {
        api: { issueDownload: vi.fn() },
        session: { incrementActiveDownloads: vi.fn(), decrementActiveDownloads: vi.fn() },
        serviceWorker: undefined,
      },
    );
    expect(outcome).toEqual({ status: 'failed', reason: 'BLOB_TOO_LARGE' });
  });

  /**
   * Fake download service worker: acknowledges the stream hand-off over the MessageChannel port and then reads
   * the zip stream like the browser would while the download is in progress.
   */
  function fakeServiceWorker(): { container: ServiceWorkerContainer; errored: Promise<unknown> } {
    let reject!: (e: unknown) => void;
    const errored = new Promise<unknown>((_, r) => {
      reject = r;
    });
    const active = {
      postMessage(message: unknown, transfer?: Transferable[]) {
        const data = message as { type?: string; stream?: ReadableStream<Uint8Array> };
        if (data.type === 'keepalive' || !data.stream) return;
        const port = transfer?.find((t) => t instanceof MessagePort) as MessagePort | undefined;
        port?.postMessage({ ready: true });
        // the browser consumes the Response body in the background
        void (async () => {
          const reader = data.stream!.getReader();
          try {
            for (;;) {
              const { done } = await reader.read();
              if (done) break;
            }
          } catch (e) {
            reject(e);
          }
        })();
      },
    };
    const container = {
      getRegistration: async () => ({ active }),
    } as unknown as ServiceWorkerContainer;
    return { container, errored };
  }

  it('cancel while a file is streaming through the service worker resolves runZip with "cancelled" (dev 2026-10-01)', async () => {
    const issue = vi.fn(async ({ key }: { bucket: string; key: string }) => ({
      downloadId: `dl-${key}`,
      url: `https://cf.example/${key}`,
      path: 'CF' as const,
      mode: 'single' as const,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      sizeBytes: 1024,
      count: 2,
      filename: key,
    }));
    // a body that delivers one chunk, then stays open until the request is aborted (like a 1 GiB object mid-flight)
    const fetchFn = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(64));
          signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(body, { status: 200 });
    });
    const session = { incrementActiveDownloads: vi.fn(), decrementActiveDownloads: vi.fn() };
    const { container, errored } = fakeServiceWorker();
    const controller = new AbortController();
    const progress: number[] = [];
    document.body.innerHTML = '';

    const run = runZip(
      { items: [{ key: 'p/a.bin', sizeBytes: 1024 }], bucket: 'bkt', archiveName: 'p' },
      {
        api: { issueDownload: issue },
        session,
        fetchFn,
        serviceWorker: container,
        signal: controller.signal,
        onProgress: (p) => progress.push(p.bytesDone),
      },
    );
    // wait until the first chunk was counted (streaming phase, body open)
    await vi.waitFor(() => expect(progress.at(-1)).toBe(64));
    const reportsBeforeAbort = progress.length;
    controller.abort();

    const outcome = await Promise.race([
      run,
      new Promise<never>((_, r) =>
        setTimeout(() => r(new Error('runZip did not settle after cancel')), 2_000),
      ),
    ]);
    expect(outcome).toEqual({ status: 'cancelled' });
    // the zip stream handed to the browser is errored, so the browser's download fails instead of hanging
    await expect(errored).rejects.toBeInstanceOf(DOMException);
    expect(session.decrementActiveDownloads).toHaveBeenCalledTimes(1);
    // no progress report after the abort: a late `running` update would otherwise overwrite the caller's outcome
    expect(progress.length).toBe(reportsBeforeAbort);
  });

  it('a chunk reported after the abort is dropped even when the stream keeps flowing for a moment', async () => {
    const issue = vi.fn(async ({ key }: { bucket: string; key: string }) => ({
      downloadId: `dl-${key}`,
      url: `https://cf.example/${key}`,
      path: 'CF' as const,
      mode: 'single' as const,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      sizeBytes: 1024,
      count: 2,
      filename: key,
    }));
    // a body that ignores the abort for one more chunk (what a queued transform chunk looks like to the caller)
    let push!: () => void;
    const fetchFn = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(64));
          push = () => {
            controller.enqueue(new Uint8Array(64));
            controller.close();
          };
        },
      });
      return new Response(body, { status: 200 });
    });
    const session = { incrementActiveDownloads: vi.fn(), decrementActiveDownloads: vi.fn() };
    const { container } = fakeServiceWorker();
    const controller = new AbortController();
    const reported: number[] = [];
    const run = runZip(
      { items: [{ key: 'p/a.bin', sizeBytes: 1024 }], bucket: 'bkt', archiveName: 'p' },
      {
        api: { issueDownload: issue },
        session,
        fetchFn,
        serviceWorker: container,
        signal: controller.signal,
        onProgress: (p) => reported.push(p.bytesDone),
      },
    );
    await vi.waitFor(() => expect(reported.at(-1)).toBe(64));
    controller.abort();
    push();
    expect(await run).toEqual({ status: 'cancelled' });
    await new Promise((r) => setTimeout(r, 20));
    expect(reported.at(-1)).toBe(64); // the 128-byte report never left runZip
  });
});
