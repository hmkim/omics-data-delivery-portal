/**
 * Export delivery for split downloads in browsers without the File System Access API (design §5.4, D8):
 * the verified OPFS part files are handed to the browser's ordinary download manager.
 *
 * Two paths, chosen at run time:
 * - **stream**: the parts are concatenated into one `ReadableStream` and transferred to the portal's export service
 *   worker (`/portal-export/export-sw.js`). A hidden iframe navigates to `/portal-export/<id>`; the worker answers
 *   with `Content-Disposition: attachment` and `Content-Length`, so the browser shows a normal download with a known
 *   size. The stream ends when the browser has taken every byte, which is when the parts may be deleted.
 *   Needs transferable streams (Chromium 87+, Firefox 103+, Safari 27+).
 * - **blob**: `new Blob([part files])` — the parts are OPFS `File` references, nothing is copied — behind an object
 *   URL clicked through `<a download>`. The browser copies the blob into its download folder on its own schedule; the
 *   caller cannot observe completion and keeps the parts (`handed`).
 */

export const EXPORT_SW_URL = '/portal-export/export-sw.js';
export const EXPORT_SW_SCOPE = '/portal-export/';
/**
 * The hidden iframe that starts the download MUST stay in the DOM for the whole transfer — removing it while the
 * browser is still pulling the response truncates the saved file in Firefox (a 60 s fixed timer cut a 106 s / 12 GiB
 * download off at ~5.4 GB). So there is deliberately no fixed-duration timer: the frame lives until the source stream
 * closes (the browser took the last byte), however many hours a 150 GB download runs, and only then lingers this
 * short grace so the browser can finalize and flush the file before its initiating frame — and the response — go away.
 */
export const EXPORT_FINALIZE_GRACE_MS = 3_000;
/** SW keepalive ping interval (Firefox stops an idle worker after 30 s; each ping extends it by 15 s). */
export const EXPORT_KEEPALIVE_MS = 10_000;

export type ExportOutcome =
  /** every byte went through the stream; the parts are no longer needed */
  | { kind: 'streamed' }
  /** the browser took the Blob; it reads the parts while it writes the file */
  | { kind: 'handed' }
  /** the browser (or the page) cancelled the stream before the end */
  | { kind: 'aborted'; message?: string };

export interface ExportInput {
  downloadId: string;
  filename: string;
  /** exact byte length of the concatenated parts (Content-Length) */
  size: number;
  /** part Blobs in file order */
  parts: Blob[];
  /** bytes handed to the browser so far (stream path only) */
  onProgress?: (bytes: number) => void;
  /** Blob path: the object URL created for the download, so the owner can revoke it later */
  onObjectUrl?: (url: string) => void;
  signal?: AbortSignal;
}

export type ExportDelivery = (input: ExportInput) => Promise<ExportOutcome>;

export interface ConcatHooks {
  /** cumulative byte count after every chunk */
  onProgress?: (bytes: number) => void;
  /** every part was enqueued and the stream closed (the consumer pulled the last chunk) */
  onClose?: () => void;
  /** the consumer cancelled the stream before the end */
  onCancel?: (reason: unknown) => void;
}

/**
 * One readable stream over `parts` in order. Pulls lazily from each part's own stream so only one chunk is in memory
 * at a time. The hooks let the owner see how the stream ended even after it has been transferred to another realm:
 * `onClose` fires when the last chunk has been pulled, `onCancel` when the consumer gave up.
 */
export function concatParts(parts: Blob[], hooks: ConcatHooks = {}): ReadableStream<Uint8Array> {
  let idx = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (!reader) {
          const part = parts[idx];
          if (!part) {
            controller.close();
            hooks.onClose?.();
            return;
          }
          reader = (part.stream() as ReadableStream<Uint8Array>).getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          reader = undefined;
          idx += 1;
          continue;
        }
        total += value.byteLength;
        hooks.onProgress?.(total);
        controller.enqueue(value);
        return;
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason).catch(() => undefined);
      reader = undefined;
      hooks.onCancel?.(reason);
    },
  });
}

let transferableStreamsMemo: boolean | undefined;

/**
 * Can a `ReadableStream` be transferred with `postMessage`? Safari before 27 throws `DataCloneError`. Probed once
 * with a throw-away channel; `env` overrides are for tests.
 */
export function supportsTransferableStreams(env?: {
  MessageChannel?: typeof MessageChannel;
  ReadableStream?: typeof ReadableStream;
}): boolean {
  if (!env && transferableStreamsMemo !== undefined) return transferableStreamsMemo;
  const MC = env ? env.MessageChannel : globalThis.MessageChannel;
  const RS = env ? env.ReadableStream : globalThis.ReadableStream;
  let ok = false;
  if (typeof MC === 'function' && typeof RS === 'function') {
    const stream = new RS();
    const { port1, port2 } = new MC();
    try {
      port1.postMessage(stream, [stream as unknown as Transferable]);
      ok = true;
    } catch {
      ok = false;
    } finally {
      port1.close();
      port2.close();
    }
  }
  if (!env) transferableStreamsMemo = ok;
  return ok;
}

/** Register the export service worker once per page (idempotent; failures are non-fatal: the Blob path remains). */
export async function registerExportServiceWorker(
  container: ServiceWorkerContainer | undefined = globalThis.navigator?.serviceWorker,
): Promise<ServiceWorkerRegistration | undefined> {
  if (!container) return undefined;
  try {
    return await container.register(EXPORT_SW_URL, { scope: EXPORT_SW_SCOPE });
  } catch (err) {
    console.warn('[portal] export service worker registration failed; falling back to Blob exports', err);
    return undefined;
  }
}

export interface BrowserDeliveryDeps {
  serviceWorker?: ServiceWorkerContainer | undefined;
  doc?: Document;
  transferable?: () => boolean;
  /** test seam: force one path */
  force?: 'stream' | 'blob';
  /** test seam: grace after the stream closes before the iframe is removed (default `EXPORT_FINALIZE_GRACE_MS`) */
  finalizeGraceMs?: number;
}

/** Stream through the export service worker. Resolves `undefined` when no active worker is available. */
async function deliverViaStream(
  container: ServiceWorkerContainer,
  doc: Document,
  input: ExportInput,
  graceMs: number,
): Promise<ExportOutcome | undefined> {
  const reg = await container.getRegistration(EXPORT_SW_SCOPE).catch(() => undefined);
  const active = reg?.active;
  if (!active) return undefined;

  const requestId = `${input.downloadId}-${Date.now()}`;
  let settle: (outcome: ExportOutcome) => void = () => undefined;
  const finished = new Promise<ExportOutcome>((resolve) => {
    settle = resolve;
  });
  // the source itself reports how it ended; this works across the realm boundary once the stream is transferred
  const observed = concatParts(input.parts, {
    onProgress: input.onProgress,
    onClose: () => settle({ kind: 'streamed' }),
    onCancel: (reason) =>
      settle({
        kind: 'aborted',
        message: reason instanceof Error ? reason.message : 'cancelled by the browser',
      }),
  });

  const { port1, port2 } = new MessageChannel();
  const ready = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000);
    port1.onmessage = () => {
      clearTimeout(timer);
      resolve(true);
    };
  });
  try {
    active.postMessage(
      { downloadId: requestId, filename: input.filename, size: input.size, stream: observed },
      [observed as unknown as Transferable, port2],
    );
  } catch {
    port1.close();
    await observed.cancel().catch(() => undefined);
    return undefined; // streams not transferable after all → Blob path
  }
  if (!(await ready)) {
    port1.close();
    await observed.cancel().catch(() => undefined);
    return undefined;
  }
  port1.close();

  // A navigation inside the SW scope (not an <a download> click: anchor downloads bypass a worker that does not
  // control the page). The worker answers with Content-Disposition: attachment, the SPA stays where it is.
  const frame = doc.createElement('iframe');
  frame.hidden = true;
  frame.setAttribute('aria-hidden', 'true');
  frame.title = input.filename;
  frame.src = `${EXPORT_SW_SCOPE}${encodeURIComponent(requestId)}`;
  doc.body.appendChild(frame);
  const keepalive = setInterval(() => active.postMessage({ type: 'keepalive' }), EXPORT_KEEPALIVE_MS);
  const onAbort = () => {
    settle({ kind: 'aborted', message: 'aborted' });
    void observed.cancel().catch(() => undefined);
  };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const outcome = await finished;
    // The frame stayed up for the entire pull (never a fixed timer — a 150 GB download runs for hours). Now that the
    // source has closed, let the browser finalize and flush the file before the initiating frame disappears.
    if (outcome.kind === 'streamed' && graceMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, graceMs));
    }
    return outcome;
  } finally {
    clearInterval(keepalive);
    frame.remove();
    input.signal?.removeEventListener('abort', onAbort);
  }
}

function deliverViaBlob(doc: Document, input: ExportInput): ExportOutcome {
  const blob = new Blob(input.parts, { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  input.onObjectUrl?.(url);
  const a = doc.createElement('a');
  a.href = url;
  a.download = input.filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  doc.body.appendChild(a);
  a.click();
  doc.body.removeChild(a);
  return { kind: 'handed' };
}

/** Browser delivery: stream through the export SW when possible, otherwise a Blob URL download. */
export function createBrowserExportDelivery(deps: BrowserDeliveryDeps = {}): ExportDelivery {
  const transferable = deps.transferable ?? supportsTransferableStreams;
  return async (input) => {
    const doc = deps.doc ?? globalThis.document;
    const container =
      deps.serviceWorker === undefined && typeof navigator !== 'undefined'
        ? navigator.serviceWorker
        : deps.serviceWorker;
    // `window.__portalTest.forceExport` is the Playwright suite's hook (never set by production code)
    const force =
      deps.force ??
      (globalThis.window as (Window & typeof globalThis) | undefined)?.__portalTest?.forceExport;
    const wantStream = force ? force === 'stream' : transferable();
    if (wantStream && container) {
      const graceMs = deps.finalizeGraceMs ?? EXPORT_FINALIZE_GRACE_MS;
      const outcome = await deliverViaStream(container, doc, input, graceMs);
      if (outcome) return outcome;
      if (force === 'stream') return { kind: 'aborted', message: 'export service worker unavailable' };
    }
    return deliverViaBlob(doc, input);
  };
}
