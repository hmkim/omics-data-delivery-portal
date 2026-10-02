import {
  PART_SIZE_BYTES,
  RENEW_LEAD_MS,
  planParts,
  type DownloadResponse,
  type RenewResponse,
} from '@genome-portal/contract';
import { AuthExpiredError } from '../api/client';
import { verifyFile, type ChecksumOutcome } from './checksum';
import {
  chooseStorage,
  opfsPartStorage,
  type PartStorage,
  type StorageChoice,
  type StorageMode,
} from './partStorage';
import {
  type SplitPartState,
  type SplitPauseReason,
  type SplitReason,
  type SplitRecord,
  type SplitStore,
} from './store';
import type { OpfsSinkSpec, WorkerInbound, WorkerOutbound } from './splitWorker';

// ---------------------------------------------------------------------------
// Part runner abstraction (worker in the browser, fake in tests)
// ---------------------------------------------------------------------------

export type PartRunOutcome =
  | { kind: 'done' }
  | { kind: 'aborted' }
  | { kind: 'error'; status?: number; message: string; fileError?: boolean; quota?: boolean };

export interface RunPartInput {
  partIdx: number;
  url: string;
  from: number;
  to: number;
  /** storage `direct`: resolves once the chunk is written into the destination stream; rejecting aborts the part */
  onChunk?: (position: number, data: ArrayBuffer) => Promise<void>;
  /** storage `opfs`: `writtenBytes` from the part start are now durable in the part file */
  onProgress?: (writtenBytes: number) => void;
  /** storage `opfs`: the worker writes its own part file */
  sink?: OpfsSinkSpec;
}

export interface PartRunHandle {
  abort(): void;
  done: Promise<PartRunOutcome>;
}

export type PartRunner = (input: RunPartInput) => PartRunHandle;

export const CHUNK_BYTES = 64 * 1024 * 1024;
export const MAX_INFLIGHT_CHUNKS = 2;

/** Browser runner: one module Worker per part. */
export function createWorkerPartRunner(
  chunkBytes = CHUNK_BYTES,
  maxInflight = MAX_INFLIGHT_CHUNKS,
): PartRunner {
  return ({ partIdx, url, from, to, onChunk, onProgress, sink }) => {
    const worker = new Worker(new URL('./splitWorker.ts', import.meta.url), { type: 'module' });
    const send = (m: WorkerInbound) => worker.postMessage(m);
    const done = new Promise<PartRunOutcome>((resolve) => {
      worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
        const m = event.data;
        switch (m.type) {
          case 'chunk':
            if (!onChunk) {
              send({ type: 'abort' });
              resolve({ kind: 'error', fileError: true, message: 'no chunk sink for this part' });
              break;
            }
            onChunk(m.position, m.data)
              .then(() => send({ type: 'ack' }))
              .catch((err: unknown) => {
                send({ type: 'abort' });
                resolve({
                  kind: 'error',
                  fileError: true,
                  message: err instanceof Error ? err.message : String(err),
                });
              });
            break;
          case 'progress':
            onProgress?.(m.writtenBytes);
            break;
          case 'part-done':
            resolve({ kind: 'done' });
            break;
          case 'aborted':
            resolve({ kind: 'aborted' });
            break;
          case 'error':
            resolve({
              kind: 'error',
              status: m.status,
              message: m.message,
              fileError: m.fileError,
              quota: m.quota,
            });
            break;
        }
      };
      worker.onerror = (event) => resolve({ kind: 'error', message: event.message || 'worker error' });
    }).finally(() => worker.terminate());
    send({ type: 'start', partIdx, url, from, to, chunkBytes, maxInflight, sink });
    return { abort: () => send({ type: 'abort' }), done };
  };
}

/**
 * Browser implementation of `PartStorage.canHold`: asks a short-lived split worker to reserve `bytes` in OPFS for
 * the download (see `WorkerProbeMessage`). Resolves `undefined` when the worker cannot answer, so the caller falls
 * back to the browser's estimate.
 */
export function createWorkerCapacityProbe(timeoutMs = 10_000) {
  return (downloadId: string, bytes: number): Promise<boolean | undefined> =>
    new Promise<boolean | undefined>((resolve) => {
      const worker = new Worker(new URL('./splitWorker.ts', import.meta.url), { type: 'module' });
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      const finish = (result: boolean | undefined) => {
        clearTimeout(timer);
        worker.terminate();
        resolve(result);
      };
      worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
        const m = event.data;
        if (m.type !== 'probe-result') return;
        // a failure that is not about quota (e.g. OPFS locked) leaves the question open
        finish(m.ok ? true : m.quota ? false : undefined);
      };
      worker.onerror = () => finish(undefined);
      const msg: WorkerInbound = { type: 'probe', downloadId, bytes };
      worker.postMessage(msg);
    });
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface SplitEngineDeps {
  store: SplitStore;
  renew: (downloadId: string) => Promise<RenewResponse>;
  runPart: PartRunner;
  pickFile: (suggestedName: string) => Promise<FileSystemFileHandle>;
  session: { incrementActiveDownloads(): void; decrementActiveDownloads(): void };
  /** where in-flight bytes live; default: the origin-private file system */
  partStorage?: PartStorage;
  verify?: (file: Blob, expected: string | undefined) => Promise<ChecksumOutcome>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  partSize?: number;
  /** transient (non-403) part failures before the download is paused with reason NETWORK */
  maxPartRetries?: number;
  onEvent?: (event: SplitEngineEvent) => void;
}

export type SplitEngineEvent =
  | { type: 'started'; record: SplitRecord; resumed: boolean }
  /** a new download could not use OPFS and writes straight into the destination (plan C) */
  | { type: 'storage-fallback'; record: SplitRecord; choice: StorageChoice }
  /** resume found part data missing from OPFS (evicted or removed); those bytes are re-received */
  | { type: 'reconciled'; record: SplitRecord; lostBytes: number }
  /** an OPFS download hit the storage quota and, on resume, was moved to `direct` storage */
  | { type: 'migrated'; record: SplitRecord }
  | { type: 'renewed'; record: SplitRecord }
  | { type: 'merging'; record: SplitRecord }
  | { type: 'paused'; record: SplitRecord; reason: SplitPauseReason }
  | { type: 'complete'; record: SplitRecord; checksum: ChecksumOutcome }
  | { type: 'failed'; record: SplitRecord; reason: SplitReason; message?: string }
  | { type: 'cancelled'; downloadId: string };

export interface SplitSnapshot {
  record: SplitRecord;
  receivedBytes: number;
  partsDone: number;
  /** bytes/second over the last 30 s window; undefined until 30 s of running data exists */
  speedBps?: number;
  /** seconds; undefined while measuring */
  etaSeconds?: number;
  /** merge progress 0..1 while `merging` */
  mergeProgress?: number;
  /** checksum verification progress 0..1 */
  verifyProgress?: number;
}

interface ActiveRun {
  record: SplitRecord;
  /** direct storage: the destination stream for this session; opfs storage: the merge stream */
  writable?: FileSystemWritableFileStream;
  handles: Map<number, PartRunHandle>;
  stopRequested?: SplitPauseReason | 'CANCEL';
  renewTimer?: unknown;
  renewing?: Promise<void>;
  samples: Array<{ t: number; bytes: number }>;
  mergedBytes: number;
  mergeAbort?: AbortController;
  verifyProgress?: number;
  retries: Map<number, number>;
  /** resume of a `STORAGE_QUOTA` pause: move the OPFS parts into the destination first */
  migrate?: boolean;
  /** settles when run() has written the final record state and released the session counter */
  finished: Promise<void>;
}

export const THROUGHPUT_WINDOW_MS = 30_000;
/** merge progress is published every this many bytes */
const MERGE_EMIT_BYTES = 64 * 1024 * 1024;

/** `Range` start for a part when resuming (R5.4): part start + bytes already on disk. */
export function rangeStartFor(part: { start: number; receivedBytes: number }): number {
  return part.start + part.receivedBytes;
}

export function partLength(part: Pick<SplitPartState, 'start' | 'end'>): number {
  return part.end - part.start + 1;
}

export function receivedBytesOf(record: Pick<SplitRecord, 'parts'>): number {
  return record.parts.reduce((sum, p) => sum + (p.done ? partLength(p) : p.receivedBytes), 0);
}

export function storageOf(record: Pick<SplitRecord, 'storage'>): StorageMode {
  return record.storage ?? 'direct';
}

/** Delay until the renew should fire: `expiresAt - RENEW_LEAD_MS - now`, never negative. */
export function renewDelayMs(expiresAtIso: string, now: number): number {
  return Math.max(0, new Date(expiresAtIso).getTime() - RENEW_LEAD_MS - now);
}

export function buildRecord(
  issued: DownloadResponse,
  bucket: string,
  key: string,
  fileHandle: FileSystemFileHandle,
  now: number,
  partSize = PART_SIZE_BYTES,
  storage: StorageMode = 'direct',
): SplitRecord {
  const { parts } = planParts(issued.sizeBytes, partSize);
  return {
    downloadId: issued.downloadId,
    bucket,
    key,
    filename: issued.filename,
    size: issued.sizeBytes,
    path: issued.path,
    url: issued.url,
    expiresAt: issued.expiresAt,
    checksumCrc32: issued.checksumCrc32,
    parts: parts.map((p) => ({
      idx: p.idx,
      start: p.start,
      end: p.end,
      done: false,
      receivedBytes: 0,
      committedBytes: 0,
    })),
    fileHandle,
    storage,
    status: 'paused',
    createdAt: now,
    updatedAt: now,
    renewCount: 0,
  };
}

/**
 * `direct` storage after an unclean stop: the destination only holds what the last `close()` committed, so the
 * progress goes back to `committedBytes` (plan C). Returns the number of bytes given up.
 */
export function rollBackToCommitted(record: SplitRecord): number {
  let lost = 0;
  for (const part of record.parts) {
    const committed = part.committedBytes ?? part.receivedBytes;
    const len = partLength(part);
    const had = part.done ? len : part.receivedBytes;
    part.receivedBytes = Math.min(committed, len);
    part.done = part.receivedBytes === len;
    part.committedBytes = part.receivedBytes;
    lost += had - part.receivedBytes;
  }
  return lost;
}

function commitAll(record: SplitRecord): void {
  for (const part of record.parts) {
    if (part.done) part.receivedBytes = partLength(part);
    part.committedBytes = part.receivedBytes;
  }
}

class PartMissingError extends Error {
  constructor(
    readonly partIdx: number,
    readonly foundBytes: number,
    readonly expectedBytes: number,
  ) {
    super(`part ${partIdx}: expected ${expectedBytes} bytes in OPFS, found ${foundBytes}`);
    this.name = 'PartMissingError';
  }
}

export class SplitEngine {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly listeners = new Set<() => void>();
  private records: SplitRecord[] = [];
  private loaded = false;
  private changeVersion = 0;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly verify: (file: Blob, expected: string | undefined) => Promise<ChecksumOutcome>;
  private readonly partStorage: PartStorage;
  private readonly partSize: number;
  private readonly maxPartRetries: number;

  constructor(private readonly deps: SplitEngineDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.verify = deps.verify ?? verifyFile;
    this.partStorage = deps.partStorage ?? opfsPartStorage;
    this.partSize = deps.partSize ?? PART_SIZE_BYTES;
    this.maxPartRetries = deps.maxPartRetries ?? 3;
  }

  // ----- observation -----------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Records known to this tab (loaded from the store on first `load()`), newest first. */
  getSnapshots(): SplitSnapshot[] {
    return this.records.map((record) => this.snapshotOf(record));
  }

  getSnapshot(downloadId: string): SplitSnapshot | undefined {
    const record = this.records.find((r) => r.downloadId === downloadId);
    return record ? this.snapshotOf(record) : undefined;
  }

  /** Number of downloads currently transferring or merging (paused ones do not count, §5.6). */
  get runningCount(): number {
    return [...this.runs.values()].filter(
      (r) => r.record.status === 'running' || r.record.status === 'merging',
    ).length;
  }

  /**
   * Load persisted records. One left `running` / `merging` / `verifying` was interrupted by a closed tab or a
   * crashed browser: it becomes `paused / INTERRUPTED`. With `direct` storage nothing after the last `close()`
   * reached the destination, so its progress rolls back to `committedBytes`; with `opfs` storage the persisted
   * progress is already durable (and is checked against the part files when the download resumes).
   */
  async load(): Promise<SplitRecord[]> {
    const stored = await this.deps.store.list();
    for (const rec of stored) {
      let dirty = false;
      if (rec.storage === undefined) {
        rec.storage = 'direct';
        dirty = true;
      }
      for (const part of rec.parts) {
        if (part.committedBytes === undefined) {
          part.committedBytes = part.done ? partLength(part) : part.receivedBytes;
          dirty = true;
        }
      }
      if (rec.status === 'running' || rec.status === 'merging' || rec.status === 'verifying') {
        if (storageOf(rec) === 'direct' && !rec.merged) rollBackToCommitted(rec);
        rec.status = 'paused';
        rec.reason = 'INTERRUPTED';
        rec.message = undefined;
        dirty = true;
      }
      if (dirty) await this.deps.store.put(rec);
    }
    this.records = stored;
    this.loaded = true;
    this.emit();
    return stored;
  }

  // ----- commands ----------------------------------------------------------

  /** New split download: choose the destination file and the storage, persist the plan, start transferring. */
  async start(issued: DownloadResponse, bucket: string, key: string): Promise<SplitRecord> {
    if (!this.loaded) await this.load();
    const fileHandle = await this.deps.pickFile(issued.filename);
    const choice = await chooseStorage(issued.downloadId, issued.sizeBytes, this.partStorage);
    if (choice.mode === 'opfs') await this.partStorage.persist();
    const record = buildRecord(issued, bucket, key, fileHandle, this.now(), this.partSize, choice.mode);
    await this.upsert(record);
    if (choice.mode === 'direct') this.deps.onEvent?.({ type: 'storage-fallback', record, choice });
    void this.run(record, false);
    return record;
  }

  /** Resume a paused download (R5.4): re-request file permission, then continue from `receivedBytes`. */
  async resume(downloadId: string): Promise<void> {
    const record = await this.getRecord(downloadId);
    if (!record || this.runs.has(downloadId)) return;
    if (record.status !== 'paused' && record.status !== 'failed') return;
    const permission = await requestReadWrite(record.fileHandle);
    if (permission !== 'granted') {
      record.status = 'paused';
      record.reason = 'PERMISSION';
      await this.upsert(record);
      return;
    }
    const migrate = record.reason === 'STORAGE_QUOTA' && storageOf(record) === 'opfs';
    if (record.status === 'failed') {
      // "download again": every part is re-received from its start
      record.parts = record.parts.map((p) => ({ ...p, done: false, receivedBytes: 0, committedBytes: 0 }));
      record.merged = false;
      if (storageOf(record) === 'opfs')
        await this.partStorage.deleteAll(record.downloadId).catch(() => undefined);
    }
    void this.run(record, true, migrate);
  }

  async pause(downloadId: string, reason: SplitPauseReason = 'USER'): Promise<void> {
    const run = this.runs.get(downloadId);
    if (!run) return;
    await this.stopRun(run, reason);
  }

  /** Pause every running download (AUTH_EXPIRED path from `auth/session.ts`). */
  async pauseAll(reason: SplitPauseReason): Promise<void> {
    await Promise.all([...this.runs.values()].map((run) => this.stopRun(run, reason)));
  }

  /** Cancel: stop, delete the OPFS parts and the partial destination file (R1.6 / DownloadPanel). */
  async cancel(downloadId: string): Promise<void> {
    const run = this.runs.get(downloadId);
    if (run) await this.stopRun(run, 'CANCEL');
    const record = await this.getRecord(downloadId);
    if (record) {
      if (storageOf(record) === 'opfs') await this.partStorage.deleteAll(downloadId).catch(() => undefined);
      await discardFile(record.fileHandle);
      await this.deps.store.delete(downloadId);
    }
    this.records = this.records.filter((r) => r.downloadId !== downloadId);
    this.deps.onEvent?.({ type: 'cancelled', downloadId });
    this.emit();
  }

  /** Remove a finished (complete / failed) entry from the list without touching the destination file. */
  async remove(downloadId: string): Promise<void> {
    if (this.runs.has(downloadId)) return;
    const record = await this.getRecord(downloadId);
    if (record && storageOf(record) === 'opfs') {
      await this.partStorage.deleteAll(downloadId).catch(() => undefined);
    }
    await this.deps.store.delete(downloadId);
    this.records = this.records.filter((r) => r.downloadId !== downloadId);
    this.emit();
  }

  // ----- internals -----------------------------------------------------------

  private async getRecord(downloadId: string): Promise<SplitRecord | undefined> {
    if (!this.loaded) await this.load();
    return this.records.find((r) => r.downloadId === downloadId) ?? (await this.deps.store.get(downloadId));
  }

  private async upsert(record: SplitRecord): Promise<void> {
    record.updatedAt = this.now();
    await this.deps.store.put(record);
    const idx = this.records.findIndex((r) => r.downloadId === record.downloadId);
    if (idx === -1) this.records = [record, ...this.records];
    else this.records[idx] = record;
    this.emit();
  }

  /** Monotonic change counter for `useSyncExternalStore` (snapshots themselves are computed on read). */
  get version(): number {
    return this.changeVersion;
  }

  private emit(): void {
    this.changeVersion += 1;
    for (const l of this.listeners) l();
  }

  private snapshotOf(record: SplitRecord): SplitSnapshot {
    const receivedBytes = receivedBytesOf(record);
    const run = this.runs.get(record.downloadId);
    let speedBps: number | undefined;
    let etaSeconds: number | undefined;
    if (run && record.status === 'running') {
      const samples = run.samples;
      const first = samples[0];
      const last = samples[samples.length - 1];
      if (first && last && last.t - first.t >= THROUGHPUT_WINDOW_MS) {
        const bps = ((last.bytes - first.bytes) * 1000) / (last.t - first.t);
        if (bps > 0) {
          speedBps = bps;
          etaSeconds = Math.max(0, (record.size - receivedBytes) / bps);
        }
      }
    }
    return {
      record,
      receivedBytes,
      partsDone: record.parts.filter((p) => p.done).length,
      speedBps,
      etaSeconds,
      mergeProgress:
        run && record.status === 'merging' && record.size > 0
          ? Math.min(1, run.mergedBytes / record.size)
          : undefined,
      verifyProgress: run?.verifyProgress,
    };
  }

  private recordSample(run: ActiveRun): void {
    const t = this.now();
    run.samples.push({ t, bytes: receivedBytesOf(run.record) });
    // keep a little more than the window so the oldest sample spans ≥ 30 s
    while (run.samples.length > 2 && t - (run.samples[1]?.t ?? t) >= THROUGHPUT_WINDOW_MS) {
      run.samples.shift();
    }
  }

  private run(record: SplitRecord, resumed: boolean, migrate = false): Promise<void> {
    const run: ActiveRun = {
      record,
      handles: new Map(),
      samples: [],
      mergedBytes: 0,
      retries: new Map(),
      migrate,
      finished: Promise.resolve(),
    };
    this.runs.set(record.downloadId, run);
    run.finished = this.execute(run, resumed);
    return run.finished;
  }

  /**
   * One session of a download: (migrate →) reconcile → transfer parts → (merge | commit) → verify → complete.
   * Every exit path removes the run, releases the session counter and persists a final status.
   */
  private async execute(run: ActiveRun, resumed: boolean): Promise<void> {
    const { record } = run;
    const storage = storageOf(record);
    record.reason = undefined;
    record.message = undefined;
    record.status = record.merged ? 'verifying' : 'running';
    await this.upsert(record);
    this.deps.session.incrementActiveDownloads();
    this.deps.onEvent?.({ type: 'started', record, resumed });
    let sessionReleased = false;
    const release = () => {
      if (sessionReleased) return;
      sessionReleased = true;
      this.deps.session.decrementActiveDownloads();
    };
    const finish = async (
      outcome: 'paused' | 'failed' | 'cancelled',
      reason?: SplitReason,
      message?: string,
    ) => {
      this.clearRenew(run);
      this.runs.delete(record.downloadId);
      release();
      if (outcome === 'cancelled') return;
      if (outcome === 'paused') await this.markPaused(record, reason as SplitPauseReason, message);
      else await this.markFailed(record, reason as SplitReason, message);
    };

    if (!record.merged) {
      if (run.migrate && storage === 'opfs') {
        try {
          await this.migrateToDirect(run);
        } catch (err) {
          await finish('paused', 'FILE_ERROR', errorMessage(err));
          return;
        }
      }
      // transfer → (merge) until the destination is committed; a part missing from OPFS at merge time loops back
      for (;;) {
        const currentStorage = storageOf(record);
        if (currentStorage === 'opfs') {
          try {
            await this.reconcileOpfs(record);
          } catch (err) {
            await finish('paused', 'FILE_ERROR', errorMessage(err));
            return;
          }
        } else {
          try {
            run.writable = await record.fileHandle.createWritable({ keepExistingData: true });
          } catch (err) {
            await finish('paused', permissionOrFileError(err), errorMessage(err));
            return;
          }
        }
        if (record.status !== 'running') {
          record.status = 'running';
          await this.upsert(record);
        }
        run.samples = [{ t: this.now(), bytes: receivedBytesOf(record) }];

        try {
          if (renewDelayMs(record.expiresAt, this.now()) === 0) await this.renewNow(run);
          this.scheduleRenew(run);
          await this.transferParts(run);
        } catch (err) {
          if (err instanceof AuthExpiredError) run.stopRequested ??= 'AUTH_EXPIRED';
          else if (!run.stopRequested) run.stopRequested = 'NETWORK';
          if (!record.message && err instanceof Error) record.message = err.message;
        }
        this.clearRenew(run);
        await this.abortAll(run);

        if (run.stopRequested) {
          await this.settleStopped(run, finish);
          return;
        }

        // every part is complete
        if (currentStorage === 'opfs') {
          record.status = 'merging';
          run.mergedBytes = 0;
          await this.upsert(record);
          this.deps.onEvent?.({ type: 'merging', record });
          const merge = await this.merge(run);
          if (merge === 'parts-missing') continue; // reconcile + re-receive the missing part(s)
          if (run.stopRequested) {
            await this.settleStopped(run, finish);
            return;
          }
          if (merge !== 'ok') {
            await finish('paused', merge.reason, merge.message);
            return;
          }
        } else {
          try {
            await this.closeWritable(run);
            commitAll(record);
          } catch (err) {
            rollBackToCommitted(record);
            await finish('paused', 'FILE_ERROR', errorMessage(err));
            return;
          }
        }
        break;
      }
      record.merged = true;
      record.status = 'verifying';
      await this.upsert(record);
      if (storageOf(record) === 'opfs')
        await this.partStorage.deleteAll(record.downloadId).catch(() => undefined);
    } else if (record.status !== 'verifying') {
      record.status = 'verifying';
      await this.upsert(record);
    }

    let outcome: ChecksumOutcome;
    try {
      const file = await record.fileHandle.getFile();
      run.verifyProgress = 0;
      outcome = await this.verify(file, record.checksumCrc32);
    } catch (err) {
      await finish('failed', 'FILE_ERROR', errorMessage(err));
      return;
    }
    this.runs.delete(record.downloadId);
    release();
    if (outcome.status === 'mismatch') {
      await this.markFailed(
        record,
        'CHECKSUM_MISMATCH',
        `expected ${outcome.expected}, got ${outcome.actual}`,
      );
      return;
    }
    record.status = 'complete';
    record.reason = undefined;
    await this.upsert(record);
    this.deps.onEvent?.({ type: 'complete', record, checksum: outcome });
  }

  /**
   * A stop (pause, auth expiry, network give-up, file error, cancel) after the parts were aborted. `direct`: the
   * session's swap file is committed by `close()` so the progress becomes durable; if the close fails nothing was
   * committed and the progress rolls back. `opfs`: the part files are already durable; a merge in flight is
   * discarded (its swap file never reaches the destination).
   */
  private async settleStopped(
    run: ActiveRun,
    finish: (outcome: 'paused' | 'cancelled', reason?: SplitReason, message?: string) => Promise<void>,
  ): Promise<void> {
    const { record } = run;
    if (storageOf(record) === 'direct') {
      const closeError = await this.closeWritable(run).then(
        () => undefined,
        (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
      );
      if (closeError) {
        rollBackToCommitted(record);
        if (run.stopRequested !== 'CANCEL') run.stopRequested = 'FILE_ERROR';
        record.message ??= closeError.message;
      } else {
        commitAll(record);
      }
    } else if (run.writable) {
      const w = run.writable;
      run.writable = undefined;
      await w.abort().catch(() => undefined);
    }
    if (run.stopRequested === 'CANCEL') {
      await finish('cancelled');
      return;
    }
    await finish('paused', run.stopRequested, record.message);
  }

  /**
   * `opfs` storage: make the record agree with the part files before requesting ranges. A part file shorter than
   * the persisted progress (evicted, removed) restarts that part; a longer one carries an unacknowledged tail that
   * the worker truncates. Bytes given up are reported once so the UI can say why the progress moved back.
   */
  private async reconcileOpfs(record: SplitRecord): Promise<void> {
    let lost = 0;
    for (const part of record.parts) {
      const len = partLength(part);
      const size = await this.partStorage.partSize(record.downloadId, part.idx);
      if (part.done) {
        if (size !== len) {
          lost += len;
          part.done = false;
          part.receivedBytes = 0;
        }
      } else if (size < part.receivedBytes) {
        lost += part.receivedBytes;
        part.receivedBytes = 0;
      }
      part.committedBytes = part.receivedBytes;
    }
    if (lost > 0) {
      await this.upsert(record);
      this.deps.onEvent?.({ type: 'reconciled', record, lostBytes: lost });
    }
  }

  /**
   * `opfs` storage, all parts complete: stream the part files into the destination in order and commit once.
   * Returns `'parts-missing'` when a part file is not what the record says (the caller re-receives it).
   */
  private async merge(
    run: ActiveRun,
  ): Promise<'ok' | 'parts-missing' | { reason: SplitPauseReason; message: string }> {
    const { record } = run;
    let writable: FileSystemWritableFileStream;
    try {
      writable = await record.fileHandle.createWritable({ keepExistingData: false });
    } catch (err) {
      return { reason: permissionOrFileError(err), message: errorMessage(err) };
    }
    run.writable = writable;
    const abort = new AbortController();
    run.mergeAbort = abort;
    try {
      for (const part of [...record.parts].sort((a, b) => a.idx - b.idx)) {
        if (run.stopRequested) break;
        const file = await this.partStorage.partFile(record.downloadId, part.idx);
        const len = partLength(part);
        if (!file || file.size !== len) throw new PartMissingError(part.idx, file?.size ?? 0, len);
        await writable.seek(part.start);
        await this.pump(run, file, writable, abort.signal);
      }
    } catch (err) {
      run.mergeAbort = undefined;
      run.writable = undefined;
      await writable.abort().catch(() => undefined);
      if (run.stopRequested) return 'ok'; // caller inspects stopRequested
      if (err instanceof PartMissingError) {
        const part = record.parts.find((p) => p.idx === err.partIdx);
        if (part) {
          part.done = false;
          part.receivedBytes = 0;
          part.committedBytes = 0;
        }
        record.status = 'running';
        await this.upsert(record);
        this.deps.onEvent?.({ type: 'reconciled', record, lostBytes: err.expectedBytes });
        return 'parts-missing';
      }
      return { reason: permissionOrFileError(err), message: errorMessage(err) };
    }
    run.mergeAbort = undefined;
    if (run.stopRequested) {
      run.writable = undefined;
      await writable.abort().catch(() => undefined);
      return 'ok';
    }
    try {
      run.writable = undefined;
      await writable.close();
    } catch (err) {
      return { reason: 'FILE_ERROR', message: errorMessage(err) };
    }
    return 'ok';
  }

  /**
   * Resume after `STORAGE_QUOTA`: copy the durable OPFS bytes into the destination at their positions, commit, and
   * continue as a `direct` download (the committed bytes are the new baseline). The part files are deleted.
   */
  private async migrateToDirect(run: ActiveRun): Promise<void> {
    const { record } = run;
    await this.reconcileOpfs(record);
    const writable = await record.fileHandle.createWritable({ keepExistingData: false });
    run.writable = writable;
    const abort = new AbortController();
    run.mergeAbort = abort;
    try {
      for (const part of [...record.parts].sort((a, b) => a.idx - b.idx)) {
        const bytes = part.done ? partLength(part) : part.receivedBytes;
        if (bytes === 0) continue;
        const file = await this.partStorage.partFile(record.downloadId, part.idx);
        if (!file || file.size < bytes) throw new PartMissingError(part.idx, file?.size ?? 0, bytes);
        await writable.seek(part.start);
        await this.pump(run, file.slice(0, bytes), writable, abort.signal);
      }
      await writable.close();
    } catch (err) {
      await writable.abort().catch(() => undefined);
      throw err;
    } finally {
      run.writable = undefined;
      run.mergeAbort = undefined;
      run.migrate = false;
    }
    commitAll(record);
    record.storage = 'direct';
    await this.upsert(record);
    await this.partStorage.deleteAll(record.downloadId).catch(() => undefined);
    this.deps.onEvent?.({ type: 'migrated', record });
  }

  /** Stream `source` into `writable` at its current cursor, publishing merge progress every 64 MiB. */
  private async pump(
    run: ActiveRun,
    source: Blob,
    writable: FileSystemWritableFileStream,
    signal: AbortSignal,
  ): Promise<void> {
    let sinceEmit = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        run.mergedBytes += chunk.byteLength;
        sinceEmit += chunk.byteLength;
        if (sinceEmit >= MERGE_EMIT_BYTES) {
          sinceEmit = 0;
          this.emit();
        }
        controller.enqueue(chunk);
      },
    });
    await source.stream().pipeThrough(counter).pipeTo(writable, {
      preventClose: true,
      preventAbort: true,
      preventCancel: true,
      signal,
    });
    this.emit();
  }

  private async transferParts(run: ActiveRun): Promise<void> {
    const { record } = run;
    const storage = storageOf(record);
    const { concurrency } = planParts(record.size, this.partSize);
    const queue = record.parts.filter((p) => !p.done).map((p) => p.idx);
    const active = new Map<number, Promise<{ idx: number; outcome: PartRunOutcome }>>();

    const launch = (idx: number) => {
      const part = record.parts.find((p) => p.idx === idx);
      if (!part) return;
      const from = rangeStartFor(part);
      const input: RunPartInput = { partIdx: idx, url: record.url, from, to: part.end };
      if (storage === 'opfs') {
        input.sink = { kind: 'opfs', downloadId: record.downloadId, partStart: part.start };
        input.onProgress = (writtenBytes) => {
          const len = partLength(part);
          part.receivedBytes = Math.min(len, writtenBytes);
          part.committedBytes = part.receivedBytes; // durable
          this.recordSample(run);
          void this.upsert(record);
        };
      } else {
        input.onChunk = async (position, data) => {
          if (!run.writable) throw new Error('file is not writable');
          await run.writable.write({ type: 'write', position, data });
          part.receivedBytes = position + data.byteLength - part.start;
          this.recordSample(run);
          await this.upsert(record);
        };
      }
      const handle = this.deps.runPart(input);
      run.handles.set(idx, handle);
      active.set(
        idx,
        handle.done.then((outcome) => ({ idx, outcome })),
      );
    };

    while ((queue.length > 0 || active.size > 0) && !run.stopRequested) {
      while (queue.length > 0 && active.size < concurrency && !run.stopRequested) {
        launch(queue.shift() as number);
      }
      if (active.size === 0) break;
      const { idx, outcome } = await Promise.race(active.values());
      active.delete(idx);
      run.handles.delete(idx);
      const part = record.parts.find((p) => p.idx === idx);
      if (!part) continue;
      if (outcome.kind === 'done') {
        part.done = true;
        part.receivedBytes = partLength(part);
        if (storage === 'opfs') part.committedBytes = part.receivedBytes;
        await this.upsert(record);
        continue;
      }
      if (outcome.kind === 'aborted') {
        if (!run.stopRequested) queue.unshift(idx); // aborted for a renew → retry with the new URL
        continue;
      }
      if (outcome.fileError) {
        run.stopRequested = outcome.quota && storage === 'opfs' ? 'STORAGE_QUOTA' : 'FILE_ERROR';
        record.message = outcome.message;
        break;
      }
      if (outcome.status === 403) {
        // URL expired or was revoked: renew once (shared across parts) and requeue
        await this.renewNow(run); // throws AuthExpiredError → caught by execute()
        queue.unshift(idx);
        continue;
      }
      const attempts = (run.retries.get(idx) ?? 0) + 1;
      run.retries.set(idx, attempts);
      if (attempts > this.maxPartRetries) {
        run.stopRequested = 'NETWORK';
        record.message = outcome.message;
        break;
      }
      queue.push(idx);
    }
    // drain anything still active after a stop request
    if (active.size > 0) {
      for (const h of run.handles.values()) h.abort();
      await Promise.allSettled(active.values());
      run.handles.clear();
    }
  }

  private scheduleRenew(run: ActiveRun): void {
    this.clearRenew(run);
    const delay = renewDelayMs(run.record.expiresAt, this.now());
    run.renewTimer = this.setTimer(() => {
      run.renewTimer = undefined;
      this.renewNow(run).catch(async (err: unknown) => {
        // timer-driven renew failed: stop the transfer the same way a 403 path would
        run.stopRequested = err instanceof AuthExpiredError ? 'AUTH_EXPIRED' : 'NETWORK';
        run.record.message = err instanceof Error ? err.message : String(err);
        await this.abortAll(run);
      });
    }, delay);
  }

  private clearRenew(run: ActiveRun): void {
    if (run.renewTimer !== undefined) {
      this.clearTimer(run.renewTimer);
      run.renewTimer = undefined;
    }
  }

  /** One renew at a time per download; concurrent 403s from several parts share the same request. */
  private renewNow(run: ActiveRun): Promise<void> {
    if (!run.renewing) {
      run.renewing = (async () => {
        const res = await this.deps.renew(run.record.downloadId);
        run.record.url = res.url;
        run.record.expiresAt = res.expiresAt;
        run.record.renewCount = res.renewCount;
        await this.upsert(run.record);
        this.deps.onEvent?.({ type: 'renewed', record: run.record });
        if (!run.stopRequested) this.scheduleRenew(run);
      })().finally(() => {
        run.renewing = undefined;
      });
    }
    return run.renewing;
  }

  private async abortAll(run: ActiveRun): Promise<void> {
    const pending = [...run.handles.values()];
    for (const h of pending) h.abort();
    await Promise.allSettled(pending.map((h) => h.done));
    run.handles.clear();
  }

  private async stopRun(run: ActiveRun, reason: SplitPauseReason | 'CANCEL'): Promise<void> {
    run.stopRequested = reason;
    this.clearRenew(run);
    run.mergeAbort?.abort();
    await this.abortAll(run);
    // wait for execute() to observe the stop and settle the record
    await run.finished;
  }

  private async closeWritable(run: ActiveRun): Promise<void> {
    const w = run.writable;
    run.writable = undefined;
    if (w) await w.close();
  }

  private async markPaused(record: SplitRecord, reason: SplitPauseReason, message?: string): Promise<void> {
    record.status = 'paused';
    record.reason = reason;
    record.message = message;
    await this.upsert(record);
    this.deps.onEvent?.({ type: 'paused', record, reason });
  }

  private async markFailed(record: SplitRecord, reason: SplitReason, message?: string): Promise<void> {
    record.status = 'failed';
    record.reason = reason;
    record.message = message;
    await this.upsert(record);
    this.deps.onEvent?.({ type: 'failed', record, reason, message });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `createWritable` refused for lack of permission → PERMISSION (resume re-requests it); anything else → FILE_ERROR. */
function permissionOrFileError(err: unknown): SplitPauseReason {
  return err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
    ? 'PERMISSION'
    : 'FILE_ERROR';
}

async function requestReadWrite(handle: FileSystemFileHandle): Promise<PermissionState> {
  const h = handle as FileSystemFileHandle & {
    queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
    requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
  };
  if (typeof h.queryPermission === 'function') {
    const current = await h.queryPermission({ mode: 'readwrite' });
    if (current === 'granted') return current;
  }
  if (typeof h.requestPermission === 'function') {
    return h.requestPermission({ mode: 'readwrite' });
  }
  return 'granted';
}

/** Best effort: Chrome exposes non-standard `remove()`; otherwise truncate the partial file to 0 bytes. */
async function discardFile(handle: FileSystemFileHandle): Promise<void> {
  const h = handle as FileSystemFileHandle & { remove?: () => Promise<void> };
  try {
    if (typeof h.remove === 'function') {
      await h.remove();
      return;
    }
    const w = await handle.createWritable({ keepExistingData: false });
    await w.truncate(0);
    await w.close();
  } catch {
    // the user may have moved or deleted the file already
  }
}
