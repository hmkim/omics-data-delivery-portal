import { ZIP_MAX_FILES, type DownloadResponse } from '@genome-portal/contract';
import { makeZip } from 'client-zip';
import { AuthExpiredError, type ApiClient } from '../api/client';

/**
 * Multi-file zip download (R4.9, design §5.3). Each file gets its own `POST /downloads` (counted individually),
 * the signed URLs are fetched and streamed through client-zip, and the archive is written to disk through the
 * Amplify download service worker (`/amplify-storage-download/`), or collected as a Blob where no SW is available.
 * Zip streams have no resume: an interruption or AUTH_EXPIRED marks the batch failed and the user rebuilds it.
 */
export interface ZipItem {
  key: string;
  sizeBytes: number;
  /** path inside the archive; defaults to the key basename */
  relativePath?: string;
  lastModified?: Date;
}

export interface ZipPlan {
  included: ZipItem[];
  excludedOverLimit: ZipItem[];
  tooMany: boolean;
  totalBytes: number;
}

export const ZIP_CONCURRENT_ISSUES = 8;
/** Blob fallback ceiling (browser memory); above this the zip cannot be created without the service worker. */
export const BLOB_FALLBACK_MAX_BYTES = 2 * 1024 ** 3;
export const SW_SCOPE = '/amplify-storage-download/';
/** The hidden iframe that starts the SW download is removed once the browser has surely taken the response over. */
const IFRAME_LINGER_MS = 60_000;

export function planZip(
  items: ZipItem[],
  settings: { singleObjectLimitBytes: number; maxFiles?: number },
): ZipPlan {
  const maxFiles = settings.maxFiles ?? ZIP_MAX_FILES;
  const excludedOverLimit = items.filter((i) => i.sizeBytes > settings.singleObjectLimitBytes);
  const included = items.filter((i) => i.sizeBytes <= settings.singleObjectLimitBytes);
  return {
    included,
    excludedOverLimit,
    tooMany: included.length > maxFiles,
    totalBytes: included.reduce((s, i) => s + i.sizeBytes, 0),
  };
}

export function basename(key: string): string {
  return key.split('/').filter(Boolean).pop() ?? key;
}

export type ZipOutcome =
  | { status: 'complete'; bytes: number; files: number }
  | { status: 'cancelled' }
  | { status: 'failed'; reason: 'AUTH_EXPIRED' | 'NETWORK' | 'BLOB_TOO_LARGE' | 'ERROR'; message?: string };

export interface ZipProgress {
  issued: number;
  filesDone: number;
  bytesDone: number;
  total: number;
  phase: 'issuing' | 'streaming' | 'done';
}

export interface ZipRunDeps {
  api: Pick<ApiClient, 'issueDownload'>;
  session: { incrementActiveDownloads(): void; decrementActiveDownloads(): void };
  fetchFn?: typeof fetch;
  serviceWorker?: ServiceWorkerContainer | undefined;
  /** overridable for tests: deliver a finished Blob to the user */
  saveBlob?: (blob: Blob, filename: string) => void;
  onProgress?: (p: ZipProgress) => void;
  signal?: AbortSignal;
  concurrency?: number;
}

/** Run up to `limit` async jobs at once, preserving result order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

function countingStream(onBytes: (n: number) => void): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream({
    transform(chunk, controller) {
      onBytes(chunk.byteLength);
      controller.enqueue(chunk);
    },
  });
}

function anchorBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function collectBlob(stream: ReadableStream<Uint8Array>): Promise<Blob> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return new Blob(chunks as BlobPart[], { type: 'application/zip' });
}

/**
 * Hands the zip stream to the download service worker (same protocol as Storage Browser's own zip handler):
 * postMessage({downloadId, filename, stream}) with a MessageChannel; when the SW acknowledges, navigate a hidden
 * iframe to `/amplify-storage-download/<id>` so the browser shows a normal streaming download.
 * Resolves `true` when the SW took the stream, `false` when no active registration exists.
 */
async function deliverViaServiceWorker(
  container: ServiceWorkerContainer,
  stream: ReadableStream<Uint8Array>,
  filename: string,
  signal?: AbortSignal,
): Promise<{ handed: boolean; stopKeepalive: () => void }> {
  const reg = await container.getRegistration(SW_SCOPE);
  if (!reg?.active) return { handed: false, stopKeepalive: () => undefined };
  const active = reg.active;
  const downloadId = `${filename}-${Date.now()}`;
  const { port1, port2 } = new MessageChannel();
  const ready = new Promise<void>((resolve) => {
    port1.onmessage = () => {
      // A NAVIGATION to the scope URL, not an `<a download>` click: Chromium hands anchor downloads to the download
      // manager without consulting a service worker unless the page itself is controlled by it, and this page
      // (`/`) is outside the SW's `/amplify-storage-download/` scope — the click came back as the SPA's index.html
      // (dev, 2026-09-28). A hidden iframe navigation is matched by scope; the SW answers with
      // `Content-Disposition: attachment`, so the browser downloads and the SPA stays where it is. Should the SW ever
      // not answer, the iframe just renders a blank SPA and nothing is lost.
      const frame = document.createElement('iframe');
      frame.hidden = true;
      frame.setAttribute('aria-hidden', 'true');
      frame.title = filename;
      frame.src = `${SW_SCOPE}${encodeURIComponent(downloadId)}`;
      document.body.appendChild(frame);
      setTimeout(() => frame.remove(), IFRAME_LINGER_MS);
      port1.close();
      resolve();
    };
  });
  active.postMessage({ downloadId, filename, stream }, [stream as unknown as Transferable, port2]);
  const keepalive = setInterval(() => active.postMessage({ type: 'keepalive' }), 10_000);
  signal?.addEventListener('abort', () => clearInterval(keepalive), { once: true });
  await ready;
  return { handed: true, stopKeepalive: () => clearInterval(keepalive) };
}

export async function runZip(
  input: { items: ZipItem[]; bucket: string; archiveName: string },
  deps: ZipRunDeps,
): Promise<ZipOutcome> {
  const { items, bucket } = input;
  const filename = input.archiveName.endsWith('.zip') ? input.archiveName : `${input.archiveName}.zip`;
  const fetchFn = deps.fetchFn ?? ((u: RequestInfo | URL, i?: RequestInit) => fetch(u, i));
  const concurrency = deps.concurrency ?? ZIP_CONCURRENT_ISSUES;
  const totalBytes = items.reduce((s, i) => s + i.sizeBytes, 0);
  const progress: ZipProgress = {
    issued: 0,
    filesDone: 0,
    bytesDone: 0,
    total: items.length,
    phase: 'issuing',
  };
  // Chunks already queued in the counting transform are still delivered after the abort; reporting them would
  // overwrite the cancelled outcome in the caller (see PortalDownloadView).
  const report = () => {
    if (deps.signal?.aborted) return;
    deps.onProgress?.({ ...progress });
  };
  const signal = deps.signal;
  const container = deps.serviceWorker;
  const hasSw = !!container;

  if (!hasSw && totalBytes > BLOB_FALLBACK_MAX_BYTES) {
    return { status: 'failed', reason: 'BLOB_TOO_LARGE' };
  }

  deps.session.incrementActiveDownloads();
  let stopKeepalive = () => undefined as void;
  try {
    // 1. issue every URL (each one is a counted download event, R4.9)
    let issued: DownloadResponse[];
    try {
      issued = await mapLimit(items, concurrency, async (item) => {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        const res = await deps.api.issueDownload({ bucket, key: item.key });
        progress.issued += 1;
        report();
        return res;
      });
    } catch (err) {
      if (err instanceof AuthExpiredError) return { status: 'failed', reason: 'AUTH_EXPIRED' };
      if (err instanceof DOMException && err.name === 'AbortError') return { status: 'cancelled' };
      return {
        status: 'failed',
        reason: 'NETWORK',
        message: err instanceof Error ? err.message : String(err),
      };
    }
    progress.phase = 'streaming';
    report();

    // 2. stream every object into the zip, in selection order
    let streamError: unknown;
    let finished = false;
    let resolveFinished!: () => void;
    const finishedPromise = new Promise<void>((r) => {
      resolveFinished = r;
    });
    const entries = async function* () {
      try {
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i] as ZipItem;
          const res = issued[i] as DownloadResponse;
          const response = await fetchFn(res.url, {
            signal,
            mode: 'cors',
            credentials: 'omit',
            cache: 'no-store',
          });
          if (!response.ok || !response.body) {
            response.body?.cancel().catch(() => undefined);
            throw new Error(`HTTP ${response.status} for ${item.key}`);
          }
          const counted = response.body.pipeThrough(
            countingStream((n) => {
              progress.bytesDone += n;
              report();
            }),
          );
          yield {
            name: item.relativePath ?? basename(item.key),
            input: counted,
            size: item.sizeBytes,
            lastModified: item.lastModified ?? new Date(),
          };
          progress.filesDone += 1;
          report();
        }
        finished = true;
      } catch (err) {
        streamError = err;
        throw err;
      } finally {
        resolveFinished();
      }
    };
    const entryIterator = entries();
    const zipStream = makeZip(entryIterator, { buffersAreUTF8: true });
    // Cancel while a body is streaming (dev, 2026-10-01): the abort errors the fetch body, client-zip's reader
    // rejects and the zip stream handed to the browser is errored — but client-zip wraps our iterator WITHOUT a
    // `return()`, so the generator stays suspended at its `yield`, its `finally` never runs and `finishedPromise`
    // never settles: the panel kept showing "zip 생성 중" with a live Cancel button. Settle on the abort signal too,
    // and close the generator ourselves so its fetch body is released.
    const aborted = new Promise<void>((r) => {
      if (!signal) return;
      if (signal.aborted) r();
      else signal.addEventListener('abort', () => r(), { once: true });
    });
    const settled = Promise.race([finishedPromise, aborted]).then(() => {
      if (signal?.aborted && !finished) void entryIterator.return(undefined).catch(() => undefined);
    });

    // 3. deliver
    if (container) {
      const handoff = await deliverViaServiceWorker(container, zipStream, filename, signal);
      stopKeepalive = handoff.stopKeepalive;
      if (!handoff.handed) {
        if (totalBytes > BLOB_FALLBACK_MAX_BYTES) return { status: 'failed', reason: 'BLOB_TOO_LARGE' };
        const blob = await collectBlob(zipStream);
        (deps.saveBlob ?? anchorBlob)(blob, filename);
      } else {
        await settled;
      }
    } else {
      const blob = await collectBlob(zipStream);
      (deps.saveBlob ?? anchorBlob)(blob, filename);
    }

    if (signal?.aborted && !finished) return { status: 'cancelled' };
    if (streamError) {
      if (streamError instanceof DOMException && streamError.name === 'AbortError')
        return { status: 'cancelled' };
      return {
        status: 'failed',
        reason: 'NETWORK',
        message: streamError instanceof Error ? streamError.message : String(streamError),
      };
    }
    if (!finished) return { status: 'cancelled' };
    progress.phase = 'done';
    report();
    return { status: 'complete', bytes: progress.bytesDone, files: progress.filesDone };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return { status: 'cancelled' };
    return { status: 'failed', reason: 'ERROR', message: err instanceof Error ? err.message : String(err) };
  } finally {
    stopKeepalive();
    deps.session.decrementActiveDownloads();
  }
}
