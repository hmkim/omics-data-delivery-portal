/// <reference lib="webworker" />
/**
 * Split download worker (R5.2). One worker per running part: `fetch(Range)` the byte range and deliver it to one of
 * two sinks (design §5.4):
 *
 * - **OPFS sink** (storage `opfs`): the worker owns a `FileSystemSyncAccessHandle` on its part file, writes every
 *   received piece in place and `flush()`es every `chunkBytes`; after each flush it posts `progress` with the number of
 *   bytes that are now durable from the part start. Nothing large crosses the thread boundary.
 * - **post sink** (storage `direct`, legacy): ≤ `chunkBytes` chunks are transferred to the engine, which writes them
 *   into the destination `FileSystemWritableFileStream`. Back-pressure: at most `maxInflight` un-acked chunks.
 */
import { OPFS_ROOT_DIR, partFileName } from './partStorage';

export interface OpfsSinkSpec {
  kind: 'opfs';
  downloadId: string;
  /** absolute byte offset of the part start in the object; positions are stored part-relative */
  partStart: number;
}

export interface WorkerStartMessage {
  type: 'start';
  partIdx: number;
  url: string;
  /** absolute byte offset in the object where this request begins (part start + receivedBytes) */
  from: number;
  /** inclusive absolute end offset */
  to: number;
  chunkBytes: number;
  maxInflight: number;
  /** absent → post sink */
  sink?: OpfsSinkSpec;
}
export interface WorkerAbortMessage {
  type: 'abort';
}
export interface WorkerAckMessage {
  type: 'ack';
}
/**
 * Capacity probe (design §5.4 storage choice): can OPFS hold `bytes` more for this download right now? The worker
 * truncates a scratch file in the download's part directory to that size — the quota is enforced on `truncate()`
 * without writing data — then truncates it back and deletes it. `navigator.storage.estimate()` cannot answer this:
 * Chromium caps the reported quota (dev, 2026-09-29: 10 GiB reported, > 160 GiB enforced).
 */
export interface WorkerProbeMessage {
  type: 'probe';
  downloadId: string;
  bytes: number;
}
export type WorkerInbound = WorkerStartMessage | WorkerAbortMessage | WorkerAckMessage | WorkerProbeMessage;

export interface WorkerChunkMessage {
  type: 'chunk';
  partIdx: number;
  position: number;
  data: ArrayBuffer;
}
/** OPFS sink: `writtenBytes` from the part start are flushed to disk. */
export interface WorkerProgressMessage {
  type: 'progress';
  partIdx: number;
  writtenBytes: number;
}
export interface WorkerPartDoneMessage {
  type: 'part-done';
  partIdx: number;
}
export interface WorkerErrorMessage {
  type: 'error';
  partIdx: number;
  /** HTTP status when the failure was a non-206 response */
  status?: number;
  message: string;
  /** the sink (not the network) failed */
  fileError?: boolean;
  /** the sink failed because the origin's storage quota is exhausted (`QuotaExceededError`) */
  quota?: boolean;
}
export interface WorkerAbortedMessage {
  type: 'aborted';
  partIdx: number;
}
/** answer to `probe`: `ok` when the reservation succeeded; `quota` when it failed for lack of quota */
export interface WorkerProbeResultMessage {
  type: 'probe-result';
  ok: boolean;
  quota?: boolean;
  message?: string;
}
export type WorkerOutbound =
  | WorkerChunkMessage
  | WorkerProgressMessage
  | WorkerPartDoneMessage
  | WorkerErrorMessage
  | WorkerAbortedMessage
  | WorkerProbeResultMessage;

type Post = (message: WorkerOutbound, transfer?: Transferable[]) => void;

/** Durable sink used by the OPFS path (a fake in unit tests). Positions are absolute object offsets. */
export interface DurableSink {
  write(position: number, data: Uint8Array): void;
  /** make everything written so far durable; returns the bytes durable from the part start */
  flush(): number;
  close(): void;
}

/**
 * The origin's storage quota is exhausted. Chromium/Safari throw `QuotaExceededError`; Firefox surfaces the
 * quota check inside `FileSystemSyncAccessHandle.truncate()` as an XPCOM exception named
 * `NS_ERROR_FILE_NO_DEVICE_SPACE` ("File error: No device space"; Firefox 155, 2026-10-14 probe) — it is not a
 * `DOMException` and does not say "quota".
 */
export function isQuotaError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'QuotaExceededError') return true;
  const text =
    err instanceof Error
      ? `${err.name} ${err.message}`
      : typeof err === 'object' && err !== null
        ? `${String((err as { name?: unknown }).name ?? '')} ${String((err as { message?: unknown }).message ?? '')} ${String(err)}`
        : String(err);
  return /quota|NS_ERROR_FILE_NO_DEVICE_SPACE|no device space/i.test(text);
}

/**
 * `createSyncAccessHandle()` is exclusive per file. Right after a reload the previous page's workers may still hold
 * the handles for a moment (dev, 2026-09-29: resume 1–2 s after the reload → "Access Handles cannot be created if
 * there is another open Access Handle or Writable stream associated with the same file"). Chromium reports this as
 * `NoModificationAllowedError`; Safari/Firefox use `InvalidStateError`/`NoModificationAllowedError` with similar text.
 */
export function isLockContention(err: unknown): boolean {
  return (
    (err instanceof DOMException &&
      (err.name === 'NoModificationAllowedError' || err.name === 'InvalidStateError')) ||
    (err instanceof Error &&
      /another open access handle|writable stream associated|locked/i.test(err.message))
  );
}

/** Retry `fn` while it fails with lock contention, sleeping `delaysMs[i]` between attempts (≈ 6 s in total). */
export async function withLockRetry<T>(
  fn: () => Promise<T>,
  delaysMs: readonly number[] = [100, 200, 400, 800, 1600, 3200],
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const delay = delaysMs[attempt];
      if (delay === undefined || !isLockContention(err)) throw err;
      await sleep(delay);
    }
  }
}

/**
 * Open the part file and position it at `from`: any bytes beyond the resume offset were never acknowledged to the
 * engine (the engine reconciles `receivedBytes` with the file size before launching) and are dropped.
 */
export async function openOpfsSink(spec: OpfsSinkSpec, partIdx: number, from: number): Promise<DurableSink> {
  const root = await navigator.storage.getDirectory();
  const splits = await root.getDirectoryHandle(OPFS_ROOT_DIR, { create: true });
  const dir = await splits.getDirectoryHandle(spec.downloadId, { create: true });
  const fileHandle = await dir.getFileHandle(partFileName(partIdx), { create: true });
  const handle = await withLockRetry(() => fileHandle.createSyncAccessHandle());
  const offset = from - spec.partStart;
  const size = handle.getSize();
  if (size < offset) {
    handle.close();
    throw new Error(`part file holds ${size} bytes but the resume offset is ${offset}`);
  }
  if (size > offset) handle.truncate(offset);
  return {
    write(position, data) {
      handle.write(data, { at: position - spec.partStart });
    },
    flush() {
      handle.flush();
      return handle.getSize();
    },
    close() {
      handle.close();
    },
  };
}

/**
 * Try to reserve `bytes` in the download's OPFS directory (see `WorkerProbeMessage`). Leaves nothing behind.
 */
export async function probeOpfsCapacity(
  downloadId: string,
  bytes: number,
): Promise<WorkerProbeResultMessage> {
  const root = await navigator.storage.getDirectory();
  const splits = await root.getDirectoryHandle(OPFS_ROOT_DIR, { create: true });
  const dir = await splits.getDirectoryHandle(downloadId, { create: true });
  const fileHandle = await dir.getFileHandle('probe', { create: true });
  const handle = await withLockRetry(() => fileHandle.createSyncAccessHandle());
  try {
    handle.truncate(bytes);
    handle.flush();
    handle.truncate(0);
    return { type: 'probe-result', ok: true };
  } catch (err) {
    return {
      type: 'probe-result',
      ok: false,
      quota: isQuotaError(err),
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    handle.close();
    await dir.removeEntry('probe').catch(() => undefined);
  }
}

/**
 * Pure part-transfer routine, also used by unit tests. `waitForAck` resolves when the engine acknowledged one chunk
 * write (post sink only). `sink` selects the OPFS path.
 */
export async function transferPart(
  msg: WorkerStartMessage,
  deps: {
    fetchFn: typeof fetch;
    post: Post;
    signal: AbortSignal;
    waitForAck: () => Promise<void>;
    sink?: DurableSink;
  },
): Promise<void> {
  const { partIdx, url, from, to, chunkBytes, maxInflight } = msg;
  const { fetchFn, post, signal, waitForAck, sink } = deps;
  let inflight = 0;
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: { Range: `bytes=${from}-${to}` },
      signal,
      cache: 'no-store',
      credentials: 'omit',
      mode: 'cors',
    });
  } catch (err) {
    sink?.close();
    if (signal.aborted) return post({ type: 'aborted', partIdx });
    return post({ type: 'error', partIdx, message: err instanceof Error ? err.message : String(err) });
  }
  if (response.status !== 206) {
    response.body?.cancel().catch(() => undefined);
    sink?.close();
    return post({
      type: 'error',
      partIdx,
      status: response.status,
      message: `Expected 206 Partial Content, got ${response.status}`,
    });
  }
  if (!response.body) {
    sink?.close();
    return post({ type: 'error', partIdx, status: response.status, message: 'Empty response body' });
  }

  const reader = response.body.getReader();
  let position = from;
  const expected = to - from + 1;
  let received = 0;

  if (sink) {
    // ---- OPFS path: write in place, flush + report every chunkBytes -------------------------------------------
    let sinceFlush = 0;
    const flushAndReport = () => {
      const writtenBytes = sink.flush();
      post({ type: 'progress', partIdx, writtenBytes });
      sinceFlush = 0;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        try {
          sink.write(position, value);
        } catch (err) {
          reader.cancel().catch(() => undefined);
          sink.close();
          return post({
            type: 'error',
            partIdx,
            fileError: true,
            quota: isQuotaError(err),
            message: err instanceof Error ? err.message : String(err),
          });
        }
        position += value.byteLength;
        received += value.byteLength;
        sinceFlush += value.byteLength;
        if (sinceFlush >= chunkBytes) flushAndReport();
      }
    } catch (err) {
      // network read failed or aborted: keep what was written, make it durable, report it
      try {
        if (sinceFlush > 0) flushAndReport();
      } catch {
        // best effort
      }
      sink.close();
      if (signal.aborted) return post({ type: 'aborted', partIdx });
      return post({ type: 'error', partIdx, message: err instanceof Error ? err.message : String(err) });
    }
    try {
      if (sinceFlush > 0 || received === 0) flushAndReport();
      sink.close();
    } catch (err) {
      return post({
        type: 'error',
        partIdx,
        fileError: true,
        quota: isQuotaError(err),
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (received !== expected) {
      return post({
        type: 'error',
        partIdx,
        message: `Short read: expected ${expected} bytes, received ${received}`,
      });
    }
    return post({ type: 'part-done', partIdx });
  }

  // ---- post path: assemble ≤ chunkBytes chunks and transfer them to the engine ---------------------------------
  let buffer = new Uint8Array(chunkBytes);
  let filled = 0;

  const flush = async () => {
    if (filled === 0) return;
    while (inflight >= maxInflight) {
      await waitForAck();
      inflight -= 1;
    }
    const out = buffer.buffer.slice(0, filled);
    post({ type: 'chunk', partIdx, position, data: out }, [out]);
    inflight += 1;
    position += filled;
    buffer = new Uint8Array(chunkBytes);
    filled = 0;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let offset = 0;
      while (offset < value.byteLength) {
        const space = chunkBytes - filled;
        const take = Math.min(space, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        received += take;
        if (filled === chunkBytes) await flush();
      }
    }
    await flush();
  } catch (err) {
    if (signal.aborted) return post({ type: 'aborted', partIdx });
    return post({ type: 'error', partIdx, message: err instanceof Error ? err.message : String(err) });
  }
  if (received !== expected) {
    return post({
      type: 'error',
      partIdx,
      message: `Short read: expected ${expected} bytes, received ${received}`,
    });
  }
  // wait for all outstanding writes before declaring the part done, so `receivedBytes` never runs ahead of the disk
  while (inflight > 0) {
    await waitForAck();
    inflight -= 1;
  }
  post({ type: 'part-done', partIdx });
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------
const isWorkerScope = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;

if (isWorkerScope) {
  const scope = self as unknown as DedicatedWorkerGlobalScope;
  const controller = new AbortController();
  let ackResolvers: Array<() => void> = [];
  let pendingAcks = 0;
  const waitForAck = () =>
    new Promise<void>((resolve) => {
      if (pendingAcks > 0) {
        pendingAcks -= 1;
        resolve();
      } else {
        ackResolvers.push(resolve);
      }
    });
  scope.onmessage = (event: MessageEvent<WorkerInbound>) => {
    const msg = event.data;
    if (msg.type === 'abort') {
      controller.abort();
      return;
    }
    if (msg.type === 'ack') {
      const next = ackResolvers.shift();
      if (next) next();
      else pendingAcks += 1;
      return;
    }
    if (msg.type === 'probe') {
      void probeOpfsCapacity(msg.downloadId, msg.bytes)
        .catch((err: unknown): WorkerProbeResultMessage => ({
          type: 'probe-result',
          ok: false,
          quota: isQuotaError(err),
          message: err instanceof Error ? err.message : String(err),
        }))
        .then((result) => scope.postMessage(result));
      return;
    }
    if (msg.type === 'start') {
      ackResolvers = [];
      pendingAcks = 0;
      const post: Post = (m, transfer) => scope.postMessage(m, transfer ?? []);
      void (async () => {
        let sink: DurableSink | undefined;
        if (msg.sink) {
          try {
            sink = await openOpfsSink(msg.sink, msg.partIdx, msg.from);
          } catch (err) {
            return post({
              type: 'error',
              partIdx: msg.partIdx,
              fileError: true,
              quota: isQuotaError(err),
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
        await transferPart(msg, {
          fetchFn: (input, init) => fetch(input, init),
          post,
          signal: controller.signal,
          waitForAck,
          sink,
        });
      })();
    }
  };
}
