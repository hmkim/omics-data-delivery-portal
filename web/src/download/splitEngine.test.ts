import { Blob as NodeBlob } from 'node:buffer';
import {
  MAX_PARALLEL_PARTS,
  PART_SIZE_BYTES,
  RENEW_LEAD_MS,
  planParts,
  type DownloadResponse,
  type RenewResponse,
} from '@genome-portal/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthExpiredError } from '../api/client';
import { crc32Base64FromBytes } from './checksum';
import { chooseStorage, createMemoryPartStorage, OPFS_QUOTA_MARGIN_BYTES } from './partStorage';
import type { ExportDelivery, ExportInput, ExportOutcome } from './exportDelivery';
import type { SplitCapability } from './planner';
import {
  buildRecord,
  EXPORT_RETENTION_MS,
  rangeStartFor,
  receivedBytesOf,
  renewDelayMs,
  rollBackToCommitted,
  SplitEngine,
  SplitUnavailableError,
  type PartRunHandle,
  type PartRunOutcome,
  type RunPartInput,
  type SplitEngineEvent,
} from './splitEngine';
import { createMemorySplitStore, type SplitRecord, type SplitStore } from './store';

const GiB = 1024 ** 3;

describe('part plan (T3.8, R5.2)', () => {
  it('1 GiB + 1 B → 1 part, concurrency 1', () => {
    const plan = planParts(GiB + 1);
    expect(plan.parts).toHaveLength(1);
    expect(plan.concurrency).toBe(1);
    expect(plan.parts[0]).toEqual({ idx: 0, start: 0, end: GiB });
  });
  it('12 GiB → 2 parts (8 GiB + 4 GiB), concurrency 2', () => {
    const plan = planParts(12 * GiB);
    expect(plan.parts).toHaveLength(2);
    expect(plan.concurrency).toBe(2);
    expect(plan.parts[1]).toEqual({ idx: 1, start: 8 * GiB, end: 12 * GiB - 1 });
  });
  it('150 GiB (161,061,273,600 B, design §4 example) → 19 parts, concurrency 4', () => {
    const plan = planParts(150 * GiB);
    expect(plan.parts).toHaveLength(19);
    expect(plan.concurrency).toBe(MAX_PARALLEL_PARTS);
    expect(plan.parts[18]?.end).toBe(150 * GiB - 1);
    // decimal 150 GB is 17.46 × 8 GiB → 18 parts
    expect(planParts(150_000_000_000).parts).toHaveLength(18);
    expect(PART_SIZE_BYTES).toBe(8 * GiB);
  });
  it('resume offset: Range start = part start + receivedBytes', () => {
    expect(rangeStartFor({ start: 8 * GiB, receivedBytes: 3 * 64 * 1024 ** 2 })).toBe(
      8 * GiB + 3 * 64 * 1024 ** 2,
    );
    expect(rangeStartFor({ start: 0, receivedBytes: 0 })).toBe(0);
  });
  it('renew delay = expiresAt - 5 min - now, clamped at 0', () => {
    const now = Date.parse('2026-09-28T00:00:00Z');
    expect(renewDelayMs('2026-09-28T01:00:00Z', now)).toBe(60 * 60_000 - RENEW_LEAD_MS);
    expect(renewDelayMs('2026-09-28T00:04:00Z', now)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fake File System Access handle + fake part runner
// ---------------------------------------------------------------------------

interface FakeHandle extends FileSystemFileHandle {
  writes: Array<{ position: number; bytes: number }>;
  /** bytes the destination holds after the last successful close() (what a real file would contain) */
  readonly committed: Uint8Array;
  readonly closed: number;
  readonly aborted: number;
  setPermission(p: PermissionState): void;
  queryPermission: ReturnType<typeof vi.fn<() => Promise<PermissionState>>>;
  requestPermission: ReturnType<typeof vi.fn<() => Promise<PermissionState>>>;
  createWritable: ReturnType<typeof vi.fn>;
  getFile: ReturnType<typeof vi.fn>;
}

type WriteChunk = Uint8Array | { type: 'write'; position: number; data: ArrayBuffer | Uint8Array };

/**
 * A `FileSystemWritableFileStream` stand-in that is a real `WritableStream` (the merge path pipes into it) with the
 * `seek` / `truncate` / `write(chunk)` conveniences. Like the real thing it writes into a swap copy and commits on
 * `close()`; `abort()` discards the swap. Positioned writes and streamed chunks both advance the cursor.
 */
function fakeFileHandle(): FakeHandle {
  const writes: Array<{ position: number; bytes: number }> = [];
  let committed = new Uint8Array(0);
  let closed = 0;
  let aborted = 0;
  let permission: PermissionState = 'granted';
  const createWritable = vi.fn(async (opts?: { keepExistingData?: boolean }) => {
    let swap = opts?.keepExistingData ? committed.slice() : new Uint8Array(0);
    let cursor = 0;
    const put = (position: number, data: Uint8Array) => {
      const next = new Uint8Array(Math.max(swap.byteLength, position + data.byteLength));
      next.set(swap, 0);
      next.set(data, position);
      swap = next;
      writes.push({ position, bytes: data.byteLength });
      cursor = position + data.byteLength;
    };
    const stream = new WritableStream<WriteChunk>({
      write(chunk) {
        // `instanceof` is realm-bound; a chunk streamed from a Node Blob is still a typed array
        if (ArrayBuffer.isView(chunk))
          put(cursor, new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        else if (typeof chunk === 'object' && chunk !== null && 'position' in chunk) {
          put(
            chunk.position,
            ArrayBuffer.isView(chunk.data)
              ? new Uint8Array(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength)
              : new Uint8Array(chunk.data),
          );
        } else throw new TypeError(`unexpected chunk ${String(chunk)}`);
      },
      close() {
        committed = swap;
        closed += 1;
      },
      abort() {
        aborted += 1;
      },
    }) as WritableStream<WriteChunk> & {
      seek(position: number): Promise<void>;
      truncate(size: number): Promise<void>;
      write(chunk: WriteChunk): Promise<void>;
    };
    stream.seek = async (position) => {
      cursor = position;
    };
    stream.truncate = async (size) => {
      swap = swap.slice(0, size);
      cursor = Math.min(cursor, size);
    };
    stream.write = (chunk) => {
      // spec: get a writer, enqueue the chunk, release the lock synchronously (the queued write still settles)
      const writer = stream.getWriter();
      const result = writer.write(chunk);
      writer.releaseLock();
      return result;
    };
    return stream;
  });
  const handle = {
    kind: 'file',
    name: 'sample.bam',
    writes,
    get committed() {
      return committed;
    },
    get closed() {
      return closed;
    },
    get aborted() {
      return aborted;
    },
    setPermission(p: PermissionState) {
      permission = p;
    },
    queryPermission: vi.fn(async (): Promise<PermissionState> => permission),
    requestPermission: vi.fn(async (): Promise<PermissionState> => {
      permission = 'granted';
      return permission;
    }),
    createWritable,
    getFile: vi.fn(async () => new Blob([new Uint8Array(4)])),
  };
  return handle as unknown as FakeHandle;
}

type Script = (input: RunPartInput, attempt: number) => Promise<PartRunOutcome | 'hang'>;

/** Deterministic part runner: `script` decides the outcome per part; 'hang' keeps the part in flight until abort(). */
function fakeRunner(script: Script) {
  const attempts = new Map<number, number>();
  const calls: RunPartInput[] = [];
  const runner = (input: RunPartInput): PartRunHandle => {
    calls.push(input);
    const attempt = (attempts.get(input.partIdx) ?? 0) + 1;
    attempts.set(input.partIdx, attempt);
    let abort: () => void = () => undefined;
    const done = new Promise<PartRunOutcome>((resolve) => {
      abort = () => resolve({ kind: 'aborted' });
      void script(input, attempt).then((r) => {
        if (r !== 'hang') resolve(r);
      });
    });
    return { abort: () => abort(), done };
  };
  return { runner, calls, attempts };
}

const issuedFor = (size: number, over: Partial<DownloadResponse> = {}): DownloadResponse => ({
  downloadId: 'dl-1',
  url: 'https://s3.example/obj?sig=1',
  path: 'S3',
  mode: 'split',
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  sizeBytes: size,
  checksumCrc32: 'AAAAAA==',
  count: 1,
  filename: 'sample.bam',
  ...over,
});

/** `direct` storage: deliver `bytes` (default: the whole range) through the engine's chunk sink. */
const writeChunk = (input: RunPartInput, bytes = input.to - input.from + 1): Promise<void> => {
  if (!input.onChunk) throw new Error('direct-storage runner needs onChunk');
  return input.onChunk(input.from, new Uint8Array(bytes).fill(1).buffer);
};

const fullPart = async (input: RunPartInput): Promise<PartRunOutcome> => {
  // one chunk covering the requested range
  await writeChunk(input);
  return { kind: 'done' };
};

/** Memory part storage whose part files can be streamed (jsdom's Blob has no `stream()`, Node's does). */
type MemoryStorage = ReturnType<typeof createMemoryPartStorage>;
function memoryStorage(opts: { available?: boolean; free?: number; capacity?: number } = {}): MemoryStorage {
  const storage = createMemoryPartStorage(opts);
  storage.partFile = async (downloadId, idx) => {
    const bytes = storage.parts.get(`${downloadId}/${idx}`);
    return bytes ? (new NodeBlob([bytes]) as unknown as Blob) : undefined;
  };
  return storage;
}

/** `opfs` storage: write `bytes` (default: the whole range) into the part file and report them durable. */
const writePart = (storage: MemoryStorage, input: RunPartInput, bytes = input.to - input.from + 1): void => {
  if (!input.sink || !input.onProgress) throw new Error('opfs-storage runner needs sink + onProgress');
  const at = input.from - input.sink.partStart;
  storage.write(input.sink.downloadId, input.partIdx, at, new Uint8Array(bytes).fill(2));
  input.onProgress(at + bytes);
};

const fullOpfsPart =
  (storage: MemoryStorage) =>
  async (input: RunPartInput): Promise<PartRunOutcome> => {
    writePart(storage, input);
    return { kind: 'done' };
  };

function makeEngine(opts: {
  runner: (input: RunPartInput) => PartRunHandle;
  renew?: (id: string) => Promise<RenewResponse>;
  partSize?: number;
  handle?: FakeHandle;
  verify?: 'ok' | 'mismatch';
  /** default: OPFS unavailable → `direct` storage (what jsdom gives the engine anyway) */
  partStorage?: MemoryStorage;
  store?: SplitStore;
  /** browser capability; default `picker` (a Chrome with the save dialog, which these tests emulate) */
  capability?: SplitCapability;
  /** `export` delivery seam; default records the inputs and answers `streamed` */
  deliver?: ExportDelivery;
  /** `export` delivery: force the part-stream checksum outcome; default: real CRC32 over the fake parts */
  verifyStream?: 'mismatch';
}) {
  const store = opts.store ?? createMemorySplitStore();
  const partStorage = opts.partStorage ?? memoryStorage({ available: false });
  const session = { active: 0, incrementActiveDownloads: vi.fn(), decrementActiveDownloads: vi.fn() };
  session.incrementActiveDownloads.mockImplementation(() => {
    session.active += 1;
  });
  session.decrementActiveDownloads.mockImplementation(() => {
    session.active -= 1;
  });
  const events: SplitEngineEvent[] = [];
  const handle = opts.handle ?? fakeFileHandle();
  const renew = vi.fn(
    opts.renew ??
      (async (id: string) => ({
        downloadId: id,
        url: 'https://s3.example/obj?sig=2',
        path: 'S3' as const,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        renewCount: 1,
      })),
  );
  const pickFile = vi.fn(async () => handle);
  const exports: ExportInput[] = [];
  const deliver: ExportDelivery =
    opts.deliver ??
    (async (input) => {
      exports.push(input);
      return { kind: 'streamed' } as ExportOutcome;
    });
  const engine = new SplitEngine({
    store,
    renew,
    runPart: opts.runner,
    pickFile,
    session,
    partStorage,
    partSize: opts.partSize ?? PART_SIZE_BYTES,
    verify: async () =>
      opts.verify === 'mismatch'
        ? { status: 'mismatch', actual: 'BBBBBB==', expected: 'AAAAAA==' }
        : { status: 'ok', actual: 'AAAAAA==' },
    ...(opts.verifyStream === 'mismatch'
      ? {
          verifyStream: async () => ({
            status: 'mismatch' as const,
            actual: 'BBBBBB==',
            expected: 'AAAAAA==',
          }),
        }
      : {}),
    deliver,
    capability: () => opts.capability ?? 'picker',
    onEvent: (e) => events.push(e),
    maxPartRetries: 1,
  });
  return { engine, store, partStorage, session, events, handle, renew, pickFile, exports };
}

const flush = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await vi.advanceTimersByTimeAsync(0);
};

const types = (events: SplitEngineEvent[]) => events.map((e) => e.type);

describe('SplitEngine (T3.8) — direct storage (plan C fallback)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('downloads all parts with concurrency min(4, parts), writes at absolute positions, verifies, completes', async () => {
    const { runner, calls } = fakeRunner(fullPart);
    const { engine, store, session, events, handle } = makeEngine({ runner, partSize: 1024 });
    const record = await engine.start(issuedFor(2500), 'bucket', 'p/sample.bam');
    expect(record.parts).toHaveLength(3);
    expect(record.storage).toBe('direct');
    await flush(20);
    const final = await store.get('dl-1');
    expect(final?.status).toBe('complete');
    expect(calls.map((c) => [c.from, c.to])).toEqual([
      [0, 1023],
      [1024, 2047],
      [2048, 2499],
    ]);
    expect(handle.writes.map((w) => w.position)).toEqual([0, 1024, 2048]);
    expect(handle.closed).toBe(1);
    expect(handle.committed.byteLength).toBe(2500);
    expect(session.incrementActiveDownloads).toHaveBeenCalledTimes(1);
    expect(session.decrementActiveDownloads).toHaveBeenCalledTimes(1);
    // OPFS is unavailable in this environment → the engine says so once, before it starts
    expect(types(events)).toEqual(['storage-fallback', 'started', 'complete']);
    expect(events[0]).toMatchObject({
      type: 'storage-fallback',
      choice: { fallbackReason: 'OPFS_UNAVAILABLE' },
    });
    expect(receivedBytesOf(final as SplitRecord)).toBe(2500);
    expect(final?.parts.every((p) => p.committedBytes === 1024 || p.committedBytes === 452)).toBe(true);
  });

  it('resume: only unfinished parts are requested, Range start = receivedBytes offset', async () => {
    const { runner, calls } = fakeRunner(fullPart);
    const { engine, store, handle } = makeEngine({ runner, partSize: 1024 });
    const paused = buildRecord(issuedFor(3000), 'bucket', 'k', handle, Date.now(), 1024);
    paused.parts[0]!.done = true;
    paused.parts[0]!.receivedBytes = 1024;
    paused.parts[1]!.receivedBytes = 300; // partial
    paused.status = 'paused';
    paused.reason = 'USER';
    await store.put(paused);
    await engine.load();
    await engine.resume('dl-1');
    await flush(20);
    expect(handle.requestPermission).not.toHaveBeenCalled(); // already granted via queryPermission
    expect(calls.map((c) => [c.partIdx, c.from, c.to])).toEqual([
      [1, 1024 + 300, 2047],
      [2, 2048, 2999],
    ]);
    expect((await store.get('dl-1'))?.status).toBe('complete');
  });

  it('resume after revisit asks for file permission; denied → paused/PERMISSION', async () => {
    const { runner } = fakeRunner(fullPart);
    const handle = fakeFileHandle();
    handle.setPermission('prompt');
    handle.requestPermission.mockImplementationOnce(async () => 'denied' as PermissionState);
    const { engine, store } = makeEngine({ runner, partSize: 1024, handle });
    const rec = buildRecord(issuedFor(1024), 'b', 'k', handle, Date.now(), 1024);
    rec.status = 'paused';
    await store.put(rec);
    await engine.load();
    await engine.resume('dl-1');
    expect(handle.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    const after = await store.get('dl-1');
    expect(after?.status).toBe('paused');
    expect(after?.reason).toBe('PERMISSION');
  });

  it('pause(USER) aborts running parts, commits (close) and keeps receivedBytes, releases activeDownloads', async () => {
    const { runner } = fakeRunner(async (input) => {
      await writeChunk(input, 100);
      return 'hang';
    });
    const { engine, store, session, events, handle } = makeEngine({ runner, partSize: 1024 });
    await engine.start(issuedFor(2048), 'b', 'k');
    await flush();
    expect(session.active).toBe(1);
    await engine.pause('dl-1', 'USER');
    const rec = await store.get('dl-1');
    expect(rec?.status).toBe('paused');
    expect(rec?.reason).toBe('USER');
    expect(rec?.parts.map((p) => p.receivedBytes)).toEqual([100, 100]);
    expect(rec?.parts.map((p) => p.committedBytes)).toEqual([100, 100]);
    expect(handle.closed).toBe(1);
    expect(handle.committed.byteLength).toBe(1024 + 100);
    expect(session.active).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: 'paused', reason: 'USER' });
  });

  it('renew is scheduled at expiresAt - 5 min and swaps the URL for the remaining parts', async () => {
    const { runner, calls } = fakeRunner(async (input, attempt): Promise<PartRunOutcome | 'hang'> => {
      if (input.partIdx === 1 && attempt === 1) return 'hang'; // stays in flight across the renew
      return fullPart(input);
    });
    const { engine, store, renew, events } = makeEngine({ runner, partSize: 1024 });
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    await engine.start(issuedFor(2048, { expiresAt }), 'b', 'k');
    await flush();
    expect(renew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25 * 60_000 - 1);
    expect(renew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(renew).toHaveBeenCalledTimes(1);
    expect((await store.get('dl-1'))?.url).toBe('https://s3.example/obj?sig=2');
    expect(events.some((e) => e.type === 'renewed')).toBe(true);
    // part 1 keeps its first request (renew does not abort in-flight parts); part 0 finished before the renew
    expect(calls.filter((c) => c.partIdx === 1)).toHaveLength(1);
  });

  it('a 403 on a part triggers renew and the part is re-requested with the new URL', async () => {
    const { runner, calls } = fakeRunner(async (input, attempt) => {
      if (attempt === 1 && input.partIdx === 0) return { kind: 'error', status: 403, message: 'expired' };
      return fullPart(input);
    });
    const { engine, store, renew } = makeEngine({ runner, partSize: 1024 });
    await engine.start(issuedFor(1024), 'b', 'k');
    await flush(20);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.url)).toEqual(['https://s3.example/obj?sig=1', 'https://s3.example/obj?sig=2']);
    expect((await store.get('dl-1'))?.status).toBe('complete');
  });

  it('AUTH_EXPIRED during renew → all parts aborted, status paused / reason AUTH_EXPIRED (not failed)', async () => {
    const { runner } = fakeRunner(async (input, attempt): Promise<PartRunOutcome | 'hang'> => {
      if (attempt === 1 && input.partIdx === 0) return { kind: 'error', status: 403, message: 'expired' };
      return 'hang';
    });
    const renew = vi.fn(async () => {
      throw new AuthExpiredError();
    });
    const { engine, store, session, events } = makeEngine({ runner, partSize: 1024, renew });
    await engine.start(issuedFor(2048), 'b', 'k');
    await flush(20);
    const rec = await store.get('dl-1');
    expect(rec?.status).toBe('paused');
    expect(rec?.reason).toBe('AUTH_EXPIRED');
    expect(session.active).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: 'paused', reason: 'AUTH_EXPIRED' });
  });

  it('pauseAll(AUTH_EXPIRED) from the session keeper pauses every running download', async () => {
    const { runner } = fakeRunner(async () => 'hang');
    const { engine, store } = makeEngine({ runner, partSize: 1024 });
    await engine.start(issuedFor(1024), 'b', 'k1');
    await engine.start(issuedFor(1024, { downloadId: 'dl-2' }), 'b', 'k2');
    await flush();
    await engine.pauseAll('AUTH_EXPIRED');
    for (const id of ['dl-1', 'dl-2']) {
      const rec = await store.get(id);
      expect(rec?.status).toBe('paused');
      expect(rec?.reason).toBe('AUTH_EXPIRED');
    }
    expect(engine.runningCount).toBe(0);
  });

  it('checksum mismatch → failed / CHECKSUM_MISMATCH; retry re-receives every part from 0', async () => {
    const { runner, calls } = fakeRunner(fullPart);
    const { engine, store } = makeEngine({ runner, partSize: 1024, verify: 'mismatch' });
    await engine.start(issuedFor(1024), 'b', 'k');
    await flush(20);
    const rec = await store.get('dl-1');
    expect(rec?.status).toBe('failed');
    expect(rec?.reason).toBe('CHECKSUM_MISMATCH');
    await engine.resume('dl-1');
    await flush(20);
    expect(calls.map((c) => c.from)).toEqual([0, 0]);
  });

  it('load(): a record left "running" by a closed tab → paused/INTERRUPTED, progress back to the committed bytes', async () => {
    const { runner } = fakeRunner(fullPart);
    const { engine, store, handle } = makeEngine({ runner, partSize: 1024 });
    const rec = buildRecord(issuedFor(3072), 'b', 'k', handle, Date.now(), 1024);
    rec.status = 'running';
    // scenario 5 shape: paused once at 5 % (committed), resumed, reached 17 % (in the swap file only), then reload
    rec.parts[0]!.receivedBytes = 500;
    rec.parts[0]!.committedBytes = 150;
    rec.parts[1]!.done = true; // finished in the second session → not committed either
    rec.parts[1]!.receivedBytes = 1024;
    rec.parts[1]!.committedBytes = 0;
    rec.parts[2]!.receivedBytes = 0;
    rec.parts[2]!.committedBytes = 0;
    await store.put(rec);
    const loaded = await engine.load();
    expect(loaded[0]?.status).toBe('paused');
    expect(loaded[0]?.reason).toBe('INTERRUPTED');
    expect(loaded[0]?.parts.map((p) => [p.receivedBytes, p.done])).toEqual([
      [150, false],
      [0, false],
      [0, false],
    ]);
    expect(engine.getSnapshots()).toHaveLength(1);
    expect(engine.getSnapshots()[0]?.receivedBytes).toBe(150);
  });

  it('load(): records written before the storage fields existed are treated as direct + committed', async () => {
    const { runner } = fakeRunner(fullPart);
    const { engine, store, handle } = makeEngine({ runner, partSize: 1024 });
    const legacy = buildRecord(issuedFor(2048), 'b', 'k', handle, Date.now(), 1024) as Partial<SplitRecord>;
    delete legacy.storage;
    legacy.parts![0]!.receivedBytes = 300;
    delete legacy.parts![0]!.committedBytes;
    delete legacy.parts![1]!.committedBytes;
    (legacy as SplitRecord).status = 'paused';
    await store.put(legacy as SplitRecord);
    const [rec] = await engine.load();
    expect(rec?.storage).toBe('direct');
    expect(rec?.parts.map((p) => p.committedBytes)).toEqual([300, 0]);
    expect(rec?.parts[0]?.receivedBytes).toBe(300); // a clean pause is trusted
  });

  it('rollBackToCommitted() returns the bytes given up and re-opens finished parts', () => {
    const rec = buildRecord(issuedFor(2048), 'b', 'k', fakeFileHandle(), Date.now(), 1024);
    rec.parts[0]!.done = true;
    rec.parts[0]!.receivedBytes = 1024;
    rec.parts[0]!.committedBytes = 1024;
    rec.parts[1]!.receivedBytes = 700;
    rec.parts[1]!.committedBytes = 200;
    expect(rollBackToCommitted(rec)).toBe(500);
    expect(rec.parts[0]!.done).toBe(true);
    expect(rec.parts[1]!.receivedBytes).toBe(200);
  });

  it('cancel() aborts, deletes the record and truncates the partial file', async () => {
    const { runner } = fakeRunner(async () => 'hang');
    const { engine, store, handle, events } = makeEngine({ runner, partSize: 1024 });
    await engine.start(issuedFor(1024), 'b', 'k');
    await flush();
    await engine.cancel('dl-1');
    expect(await store.get('dl-1')).toBeUndefined();
    expect(handle.createWritable).toHaveBeenCalledTimes(2); // run + truncate
    expect(events.at(-1)).toEqual({ type: 'cancelled', downloadId: 'dl-1' });
  });

  it('write failure that errors the stream → paused / FILE_ERROR with the write error, progress rolled back, close() rejection swallowed', async () => {
    // Chromium: a rejected write() (QuotaExceededError on a small tmpfs profile) puts the writable into ERRORED and
    // close() then throws "Cannot close a ERRORED writable stream". Seen on dev 2026-09-28: the record stayed
    // "running" with 64 MiB shown forever.
    const handle = fakeFileHandle();
    handle.createWritable.mockImplementation(async () => {
      let errored = false;
      return {
        write: vi.fn(async (chunk: { position: number; data: ArrayBuffer }) => {
          if (chunk.position >= 1024) {
            errored = true;
            throw new DOMException('The request exceeded the quota', 'QuotaExceededError');
          }
          handle.writes.push({ position: chunk.position, bytes: chunk.data.byteLength });
        }),
        truncate: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
        close: vi.fn(async () => {
          if (errored) throw new TypeError('Cannot close a ERRORED writable stream');
        }),
      };
    });
    const { runner } = fakeRunner(async (input) => {
      try {
        await writeChunk(input, 100);
      } catch (err) {
        return { kind: 'error', fileError: true, message: (err as Error).message };
      }
      return 'hang'; // the healthy part keeps streaming until the engine aborts it
    });
    const { engine, store, session, events } = makeEngine({ runner, partSize: 1024, handle });
    await engine.start(issuedFor(2048), 'b', 'k');
    await flush();
    await flush();
    const rec = await store.get('dl-1');
    expect(rec?.status).toBe('paused');
    expect(rec?.reason).toBe('FILE_ERROR');
    expect(rec?.message).toBe('The request exceeded the quota');
    // nothing was committed (close failed) → both parts back at 0, so a resume re-requests from the part start
    expect(rec?.parts.map((p) => p.receivedBytes)).toEqual([0, 0]);
    expect(session.active).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: 'paused', reason: 'FILE_ERROR' });
  });
});

// ---------------------------------------------------------------------------
// Plan A: OPFS part files + one merge (design §5.4, T7.2 / scenario 5)
// ---------------------------------------------------------------------------

describe('chooseStorage (design §5.4)', () => {
  it('estimate only: enough → opfs; short of size + margin → direct/OPFS_QUOTA; no OPFS → direct/OPFS_UNAVAILABLE', async () => {
    expect(await chooseStorage('dl', 1000, memoryStorage({ free: 1000 + OPFS_QUOTA_MARGIN_BYTES }))).toEqual({
      mode: 'opfs',
      freeBytes: 1000 + OPFS_QUOTA_MARGIN_BYTES,
      checkedBy: 'estimate',
    });
    expect(
      await chooseStorage('dl', 1000, memoryStorage({ free: 1000 + OPFS_QUOTA_MARGIN_BYTES - 1 })),
    ).toEqual({
      mode: 'direct',
      fallbackReason: 'OPFS_QUOTA',
      freeBytes: 1000 + OPFS_QUOTA_MARGIN_BYTES - 1,
      checkedBy: 'estimate',
    });
    expect(await chooseStorage('dl', 1000, memoryStorage({ available: false }))).toEqual({
      mode: 'direct',
      fallbackReason: 'OPFS_UNAVAILABLE',
      checkedBy: 'none',
    });
    // an unknown estimate does not block OPFS (a quota error at write time pauses with STORAGE_QUOTA instead)
    expect(await chooseStorage('dl', 1000, memoryStorage())).toMatchObject({
      mode: 'opfs',
      checkedBy: 'none',
    });
  });

  it('exact probe wins over the estimate: Chromium reports a capped quota (10 GiB) while enforcing a far larger one', async () => {
    // estimate says 5 GiB free, the reservation of 12 GiB + margin succeeds → opfs
    const big = memoryStorage({ free: 5 * GiB, capacity: 300 * GiB });
    expect(await chooseStorage('dl', 12 * GiB, big)).toEqual({ mode: 'opfs', checkedBy: 'probe' });
    expect(big.probes).toEqual([{ downloadId: 'dl', bytes: 12 * GiB + OPFS_QUOTA_MARGIN_BYTES }]);
    // estimate says plenty, the reservation fails → direct (incognito: OPFS is RAM-quota'd)
    const small = memoryStorage({ free: 500 * GiB, capacity: GiB });
    expect(await chooseStorage('dl', 12 * GiB, small)).toEqual({
      mode: 'direct',
      fallbackReason: 'OPFS_QUOTA',
      freeBytes: 500 * GiB,
      checkedBy: 'probe',
    });
  });
});

describe('SplitEngine — OPFS storage (plan A)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('parts are written to OPFS, then merged once into the destination in order; parts deleted; completes', async () => {
    const partStorage = memoryStorage();
    const { runner, calls } = fakeRunner(fullOpfsPart(partStorage));
    const { engine, store, events, handle, session } = makeEngine({ runner, partSize: 1024, partStorage });
    const record = await engine.start(issuedFor(2500), 'bucket', 'p/sample.bam');
    expect(record.storage).toBe('opfs');
    expect(partStorage.persistCalls).toBe(1);
    await flush(30);
    const final = await store.get('dl-1');
    expect(final?.status).toBe('complete');
    expect(final?.merged).toBe(true);
    expect(calls.map((c) => [c.from, c.to, c.sink?.partStart])).toEqual([
      [0, 1023, 0],
      [1024, 2047, 1024],
      [2048, 2499, 2048],
    ]);
    // no positioned writes during the transfer (the worker owns the part files); one streamed merge at the end
    expect(handle.createWritable).toHaveBeenCalledTimes(1);
    expect(handle.createWritable).toHaveBeenCalledWith({ keepExistingData: false });
    expect(handle.closed).toBe(1);
    expect(handle.committed.byteLength).toBe(2500);
    expect(handle.committed.every((b) => b === 2)).toBe(true);
    expect(handle.writes[0]?.position).toBe(0);
    expect(handle.writes.reduce((s, w) => s + w.bytes, 0)).toBe(2500);
    expect(partStorage.parts.size).toBe(0);
    expect(types(events)).toEqual(['started', 'merging', 'complete']);
    expect(session.active).toBe(0);
  });

  it('scenario 5: reload mid-download loses nothing — the persisted progress is durable and the resume continues from it', async () => {
    const partStorage = memoryStorage();
    const store = createMemorySplitStore();
    // session 1: every part writes half of its range, reports it durable, then the tab "dies" (no pause, no close)
    const first = fakeRunner(async (input) => {
      writePart(partStorage, input, Math.floor((input.to - input.from + 1) / 2));
      return 'hang';
    });
    const s1 = makeEngine({ runner: first.runner, partSize: 1024, partStorage, store });
    await s1.engine.start(issuedFor(2048), 'b', 'k');
    await flush();
    const midpoint = await store.get('dl-1');
    expect(midpoint?.status).toBe('running');
    expect(midpoint?.parts.map((p) => p.receivedBytes)).toEqual([512, 512]);
    expect(s1.handle.createWritable).not.toHaveBeenCalled(); // nothing touched the destination yet

    // session 2: a new engine over the same IndexedDB + OPFS (what a page reload gives us)
    const second = fakeRunner(fullOpfsPart(partStorage));
    const s2 = makeEngine({ runner: second.runner, partSize: 1024, partStorage, store, handle: s1.handle });
    const [loaded] = await s2.engine.load();
    expect(loaded?.status).toBe('paused');
    expect(loaded?.reason).toBe('INTERRUPTED');
    expect(loaded?.parts.map((p) => p.receivedBytes)).toEqual([512, 512]); // NOT rolled back (durable)
    await s2.engine.resume('dl-1');
    await flush(30);
    expect(second.calls.map((c) => [c.partIdx, c.from, c.to])).toEqual([
      [0, 512, 1023],
      [1, 1024 + 512, 2047],
    ]);
    const final = await store.get('dl-1');
    expect(final?.status).toBe('complete');
    expect(s1.handle.committed.byteLength).toBe(2048);
    expect(s1.handle.committed.every((b) => b === 2)).toBe(true); // no hole: the merge read complete part files
    expect(types(s2.events)).toEqual(['started', 'merging', 'complete']);
  });

  it('pause during the merge keeps the part files; resume merges again without re-downloading', async () => {
    const partStorage = memoryStorage();
    const { runner, calls } = fakeRunner(fullOpfsPart(partStorage));
    const handle = fakeFileHandle();
    // stall the destination so the merge is still in flight when pause() arrives
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const realCreate = handle.createWritable.getMockImplementation()!;
    handle.createWritable.mockImplementationOnce(async (opts?: { keepExistingData?: boolean }) => {
      const stream = await realCreate(opts);
      const slow = new WritableStream<WriteChunk>({
        write: async (chunk) => {
          await gate;
          await stream.write(chunk);
        },
        close: () => stream.close(),
        abort: () => stream.abort(),
      }) as typeof stream;
      slow.seek = stream.seek;
      slow.truncate = stream.truncate;
      slow.write = stream.write;
      return slow;
    });
    const { engine, store, events } = makeEngine({ runner, partSize: 1024, partStorage, handle });
    await engine.start(issuedFor(2048), 'b', 'k');
    await flush(20);
    expect((await store.get('dl-1'))?.status).toBe('merging');
    expect(engine.runningCount).toBe(1);
    const pausing = engine.pause('dl-1', 'USER');
    release();
    await pausing;
    const paused = await store.get('dl-1');
    expect(paused?.status).toBe('paused');
    expect(paused?.reason).toBe('USER');
    expect(paused?.parts.every((p) => p.done)).toBe(true);
    expect(paused?.merged).toBeFalsy();
    expect(partStorage.parts.size).toBe(2); // durable parts survive the aborted merge
    expect(handle.aborted).toBe(1);
    expect(handle.closed).toBe(0);
    await engine.resume('dl-1');
    await flush(30);
    expect((await store.get('dl-1'))?.status).toBe('complete');
    expect(calls).toHaveLength(2); // nothing re-downloaded
    expect(handle.closed).toBe(1);
    expect(handle.committed.byteLength).toBe(2048);
    expect(types(events)).toEqual(['started', 'merging', 'paused', 'started', 'merging', 'complete']);
  });

  it('evicted part data: resume reconciles against the part files, re-receives the lost bytes, reports them once', async () => {
    const partStorage = memoryStorage();
    const store = createMemorySplitStore();
    const s1 = fakeRunner(async (input) => {
      writePart(partStorage, input, 600);
      return 'hang';
    });
    const e1 = makeEngine({ runner: s1.runner, partSize: 1024, partStorage, store });
    await e1.engine.start(issuedFor(2048), 'b', 'k');
    await flush();
    await e1.engine.pause('dl-1', 'USER');
    // the browser evicted part 1 entirely and truncated part 0 below the persisted progress
    partStorage.parts.delete('dl-1/1');
    partStorage.truncate('dl-1', 0, 100);
    const s2 = fakeRunner(fullOpfsPart(partStorage));
    const e2 = makeEngine({ runner: s2.runner, partSize: 1024, partStorage, store, handle: e1.handle });
    await e2.engine.load();
    await e2.engine.resume('dl-1');
    await flush(30);
    // a part file shorter than the persisted progress restarts that part (the worker truncates the unacked tail)
    expect(s2.calls.map((c) => [c.partIdx, c.from])).toEqual([
      [0, 0],
      [1, 1024],
    ]);
    const reconciled = e2.events.find((e) => e.type === 'reconciled');
    expect(reconciled).toMatchObject({ type: 'reconciled', lostBytes: 1200 });
    expect((await store.get('dl-1'))?.status).toBe('complete');
  });

  it('a part missing at merge time is re-received and the merge retried', async () => {
    const partStorage = memoryStorage();
    const { runner, calls } = fakeRunner(async (input, attempt) => {
      writePart(partStorage, input);
      // the moment part 1 completes, part 0's file vanishes (eviction between transfer and merge)
      if (input.partIdx === 1 && attempt === 1) partStorage.parts.delete('dl-1/0');
      return { kind: 'done' };
    });
    const { engine, store, events, handle } = makeEngine({ runner, partSize: 1024, partStorage });
    await engine.start(issuedFor(2048), 'b', 'k');
    await flush(40);
    expect((await store.get('dl-1'))?.status).toBe('complete');
    expect(calls.filter((c) => c.partIdx === 0)).toHaveLength(2);
    expect(types(events)).toEqual(['started', 'merging', 'reconciled', 'merging', 'complete']);
    expect(handle.aborted).toBe(1); // the first merge's swap file was discarded
    expect(handle.closed).toBe(1);
    expect(handle.committed.byteLength).toBe(2048);
  });

  it('quota exhausted while writing a part → paused/STORAGE_QUOTA; resume migrates the durable bytes into the destination and continues as direct', async () => {
    const partStorage = memoryStorage();
    const { runner, calls } = fakeRunner(async (input, attempt) => {
      if (input.sink) {
        writePart(partStorage, input, 300);
        if (input.partIdx === 0 && attempt === 1) {
          return { kind: 'error', fileError: true, quota: true, message: 'QuotaExceededError' };
        }
        return 'hang';
      }
      return fullPart(input); // after the migration the engine hands out chunk sinks
    });
    const { engine, store, events, handle } = makeEngine({ runner, partSize: 1024, partStorage });
    await engine.start(issuedFor(2048), 'b', 'k');
    await flush(20);
    const paused = await store.get('dl-1');
    expect(paused?.status).toBe('paused');
    expect(paused?.reason).toBe('STORAGE_QUOTA');
    expect(paused?.storage).toBe('opfs');
    expect(paused?.parts.map((p) => p.receivedBytes)).toEqual([300, 300]);
    expect(handle.createWritable).not.toHaveBeenCalled();

    await engine.resume('dl-1');
    await flush(40);
    const final = await store.get('dl-1');
    expect(final?.storage).toBe('direct');
    expect(final?.status).toBe('complete');
    expect(types(events)).toEqual(['started', 'paused', 'started', 'migrated', 'complete']);
    // migration: one close() committing 300 B at 0 and 300 B at 1024; then the direct session resumes from 300
    expect(calls.filter((c) => !c.sink).map((c) => [c.partIdx, c.from, c.to])).toEqual([
      [0, 300, 1023],
      [1, 1024 + 300, 2047],
    ]);
    expect(handle.closed).toBe(2);
    expect(handle.committed.byteLength).toBe(2048);
    expect(handle.committed.slice(0, 300).every((b) => b === 2)).toBe(true); // migrated bytes
    expect(handle.committed.slice(300, 1024).every((b) => b === 1)).toBe(true); // direct bytes
    expect(partStorage.parts.size).toBe(0);
  });

  it('cancel() during an OPFS download deletes the part files and the record', async () => {
    const partStorage = memoryStorage();
    const { runner } = fakeRunner(async (input) => {
      writePart(partStorage, input, 100);
      return 'hang';
    });
    const { engine, store, events } = makeEngine({ runner, partSize: 1024, partStorage });
    await engine.start(issuedFor(2048), 'b', 'k');
    await flush();
    expect(partStorage.parts.size).toBe(2);
    await engine.cancel('dl-1');
    expect(partStorage.parts.size).toBe(0);
    expect(await store.get('dl-1')).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: 'cancelled', downloadId: 'dl-1' });
  });

  it('a record interrupted while merging is resumed by merging again (parts are all durable)', async () => {
    const partStorage = memoryStorage();
    const store = createMemorySplitStore();
    const handle = fakeFileHandle();
    const rec = buildRecord(issuedFor(2048), 'b', 'k', handle, Date.now(), 1024, 'opfs');
    for (const p of rec.parts) {
      p.done = true;
      p.receivedBytes = 1024;
      p.committedBytes = 1024;
      partStorage.write('dl-1', p.idx, 0, new Uint8Array(1024).fill(2));
    }
    rec.status = 'merging';
    await store.put(rec);
    const { runner, calls } = fakeRunner(fullOpfsPart(partStorage));
    const { engine } = makeEngine({ runner, partSize: 1024, partStorage, store, handle });
    const [loaded] = await engine.load();
    expect(loaded?.status).toBe('paused');
    expect(loaded?.reason).toBe('INTERRUPTED');
    expect(loaded?.parts.every((p) => p.done)).toBe(true);
    await engine.resume('dl-1');
    await flush(30);
    expect(calls).toHaveLength(0);
    expect((await store.get('dl-1'))?.status).toBe('complete');
    expect(handle.committed.byteLength).toBe(2048);
  });
});

// ---------------------------------------------------------------------------
// D8: export delivery (browsers without the File System Access API — Firefox, Safari, Brave)
// ---------------------------------------------------------------------------

describe('SplitEngine — export delivery (D8, design §5.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** the S3-style checksum of `size` bytes of value 2 (what the fake OPFS part runner writes) */
  const crcOf = (size: number) => crc32Base64FromBytes(new Uint8Array(size).fill(2));
  /** an issued download whose checksum matches the fake parts (the export path hashes for real) */
  const issuedExport = async (size: number) => issuedFor(size, { checksumCrc32: await crcOf(size) });

  /** bytes of every fake part concatenated in order (what the browser must receive) */
  const concatenated = async (parts: Blob[]) => {
    const chunks = await Promise.all(parts.map(async (p) => new Uint8Array(await p.arrayBuffer())));
    const out = new Uint8Array(chunks.reduce((s, c) => s + c.byteLength, 0));
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  };

  it('start(): no save picker, record has delivery=export, storage=opfs and no fileHandle', async () => {
    const partStorage = memoryStorage();
    const { runner } = fakeRunner(fullOpfsPart(partStorage));
    const { engine, pickFile } = makeEngine({ runner, partSize: 1024, partStorage, capability: 'export' });
    const record = await engine.start(issuedFor(2500), 'bucket', 'p/sample.bam');
    expect(pickFile).not.toHaveBeenCalled();
    expect(record.delivery).toBe('export');
    expect(record.storage).toBe('opfs');
    expect(record.fileHandle).toBeUndefined();
    expect(partStorage.persistCalls).toBe(1);
  });

  it('stream export: parts → verified (CRC32 over the part stream) → exporting → complete; parts deleted', async () => {
    const partStorage = memoryStorage();
    const { runner, calls } = fakeRunner(fullOpfsPart(partStorage));
    const { engine, store, events, exports, session, handle } = makeEngine({
      runner,
      partSize: 1024,
      partStorage,
      capability: 'export',
    });
    await engine.start(issuedFor(2500, { checksumCrc32: undefined }), 'bucket', 'p/sample.bam');
    await flush(40);
    const final = await store.get('dl-1');
    expect(final?.status).toBe('complete');
    expect(final?.verified).toBe(true);
    expect(final?.verifiedCrc32).toMatch(/^[A-Za-z0-9+/]{6}==$/);
    expect(final?.exportMode).toBe('stream');
    expect(final?.exportedAt).toBeUndefined();
    expect(calls).toHaveLength(3);
    // the hand-over got every part, in order, with the exact total size
    expect(exports).toHaveLength(1);
    expect(exports[0]?.filename).toBe('sample.bam');
    expect(exports[0]?.size).toBe(2500);
    expect(exports[0]?.parts.map((p) => p.size)).toEqual([1024, 1024, 452]);
    const bytes = await concatenated(exports[0]!.parts);
    expect(bytes.byteLength).toBe(2500);
    expect(bytes.every((b) => b === 2)).toBe(true);
    // nothing touched a destination file; the parts are gone once the stream ended
    expect(handle.createWritable).not.toHaveBeenCalled();
    expect(partStorage.parts.size).toBe(0);
    expect(types(events)).toEqual(['started', 'exporting', 'complete']);
    const complete = events.find((e) => e.type === 'complete');
    expect(complete && complete.type === 'complete' && complete.checksum.status).toBe('unverifiable');
    expect(session.active).toBe(0);
  });

  it('verification runs before the hand-over: a checksum mismatch fails the download and exports nothing', async () => {
    const partStorage = memoryStorage();
    const { runner } = fakeRunner(fullOpfsPart(partStorage));
    const { engine, store, exports, events } = makeEngine({
      runner,
      partSize: 1024,
      partStorage,
      capability: 'export',
      verifyStream: 'mismatch',
    });
    await engine.start(await issuedExport(2048), 'b', 'k');
    await flush(40);
    const final = await store.get('dl-1');
    expect(final?.status).toBe('failed');
    expect(final?.reason).toBe('CHECKSUM_MISMATCH');
    expect(final?.verified).toBeFalsy();
    expect(exports).toHaveLength(0);
    expect(types(events)).toEqual(['started', 'failed']);
  });

  it('blob export: complete with exportedAt, parts KEPT; remove() deletes them; exportAgain() re-hands the parts', async () => {
    const partStorage = memoryStorage();
    const { runner } = fakeRunner(fullOpfsPart(partStorage));
    const handed: ExportInput[] = [];
    const deliver: ExportDelivery = async (input) => {
      handed.push(input);
      input.onObjectUrl?.('blob:https://portal/abc');
      return { kind: 'handed' };
    };
    const revoke = vi.fn();
    const urlCtor = URL as unknown as { revokeObjectURL?: (u: string) => void };
    const previousRevoke = urlCtor.revokeObjectURL;
    urlCtor.revokeObjectURL = revoke;
    const { engine, store, events } = makeEngine({
      runner,
      partSize: 1024,
      partStorage,
      capability: 'export',
      deliver,
    });
    await engine.start(await issuedExport(2048), 'b', 'k');
    await flush(40);
    const final = await store.get('dl-1');
    expect(final?.status).toBe('complete');
    expect(final?.exportMode).toBe('blob');
    expect(final?.exportedAt).toBe(Date.parse('2026-10-14T00:00:00Z'));
    expect(partStorage.parts.size).toBe(2); // the browser is still reading them
    expect(types(events)).toEqual(['started', 'exporting', 'complete']);

    await engine.exportAgain('dl-1');
    await flush(20);
    expect(handed).toHaveLength(2);
    expect(revoke).toHaveBeenCalledWith('blob:https://portal/abc');
    expect((await store.get('dl-1'))?.status).toBe('complete');

    await engine.remove('dl-1');
    expect(partStorage.parts.size).toBe(0);
    expect(await store.get('dl-1')).toBeUndefined();
    expect(revoke).toHaveBeenCalledTimes(2);
    urlCtor.revokeObjectURL = previousRevoke;
  });

  it('load(): a blob export older than the retention window is purged with its part files; a younger one is kept', async () => {
    const partStorage = memoryStorage();
    const store = createMemorySplitStore();
    const { runner } = fakeRunner(fullOpfsPart(partStorage));
    const deliver: ExportDelivery = async () => ({ kind: 'handed' });
    const s1 = makeEngine({ runner, partSize: 1024, partStorage, store, capability: 'export', deliver });
    await s1.engine.start(await issuedExport(2048), 'b', 'k');
    await flush(40);
    expect((await store.get('dl-1'))?.exportMode).toBe('blob');

    vi.setSystemTime(new Date(Date.parse('2026-10-14T00:00:00Z') + EXPORT_RETENTION_MS - 1));
    const s2 = makeEngine({ runner, partSize: 1024, partStorage, store, capability: 'export', deliver });
    expect(await s2.engine.load()).toHaveLength(1);
    expect(partStorage.parts.size).toBe(2);

    vi.setSystemTime(new Date(Date.parse('2026-10-14T00:00:00Z') + EXPORT_RETENTION_MS));
    const s3 = makeEngine({ runner, partSize: 1024, partStorage, store, capability: 'export', deliver });
    expect(await s3.engine.load()).toHaveLength(0);
    expect(partStorage.parts.size).toBe(0);
    expect(await store.get('dl-1')).toBeUndefined();
  });

  it('a part evicted before verification is re-received, then verified and exported', async () => {
    const partStorage = memoryStorage();
    const { runner, calls } = fakeRunner(async (input) => {
      writePart(partStorage, input);
      // part 1 disappears right after it was reported complete (browser evicted site data)
      if (input.partIdx === 1 && calls.filter((c) => c.partIdx === 1).length === 1) {
        partStorage.parts.delete('dl-1/1');
      }
      return { kind: 'done' };
    });
    const { engine, store, events, exports } = makeEngine({
      runner,
      partSize: 1024,
      partStorage,
      capability: 'export',
    });
    await engine.start(await issuedExport(2500), 'b', 'k');
    await flush(60);
    const final = await store.get('dl-1');
    expect(final?.status).toBe('complete');
    expect(calls.filter((c) => c.partIdx === 1).map((c) => [c.from, c.to])).toEqual([
      [1024, 2047],
      [1024, 2047], // re-received from its start
    ]);
    expect(exports).toHaveLength(1);
    expect((await concatenated(exports[0]!.parts)).byteLength).toBe(2500);
    const reconciled = events.find((e) => e.type === 'reconciled');
    expect(reconciled && reconciled.type === 'reconciled' && reconciled.lostBytes).toBe(1024);
    expect(types(events)).toEqual(['started', 'reconciled', 'exporting', 'complete']);
  });

  it('hand-over aborted by the browser → paused/EXPORT_FAILED with parts intact; resume only repeats the export', async () => {
    const partStorage = memoryStorage();
    const { runner, calls } = fakeRunner(fullOpfsPart(partStorage));
    let attempt = 0;
    const deliver: ExportDelivery = async () => {
      attempt += 1;
      return attempt === 1 ? { kind: 'aborted', message: 'cancelled by the browser' } : { kind: 'streamed' };
    };
    const { engine, store, events } = makeEngine({
      runner,
      partSize: 1024,
      partStorage,
      capability: 'export',
      deliver,
    });
    await engine.start(await issuedExport(2048), 'b', 'k');
    await flush(40);
    let rec = await store.get('dl-1');
    expect(rec?.status).toBe('paused');
    expect(rec?.reason).toBe('EXPORT_FAILED');
    expect(rec?.message).toBe('cancelled by the browser');
    expect(rec?.verified).toBe(true);
    expect(partStorage.parts.size).toBe(2);
    expect(calls).toHaveLength(2);

    await engine.resume('dl-1');
    await flush(40);
    rec = await store.get('dl-1');
    expect(rec?.status).toBe('complete');
    expect(rec?.exportMode).toBe('stream');
    expect(calls).toHaveLength(2); // nothing re-downloaded
    expect(partStorage.parts.size).toBe(0);
    expect(types(events)).toEqual(['started', 'exporting', 'paused', 'started', 'exporting', 'complete']);
  });

  it('a record interrupted while exporting (tab closed) → paused/INTERRUPTED, verified stays, resume exports only', async () => {
    const partStorage = memoryStorage();
    const store = createMemorySplitStore();
    const { runner, calls } = fakeRunner(fullOpfsPart(partStorage));
    // session 1: the hand-over never settles (the page died mid-stream)
    const s1 = makeEngine({
      runner,
      partSize: 1024,
      partStorage,
      store,
      capability: 'export',
      deliver: () => new Promise<ExportOutcome>(() => undefined),
    });
    await s1.engine.start(await issuedExport(2048), 'b', 'k');
    await flush(40);
    expect((await store.get('dl-1'))?.status).toBe('exporting');

    const s2 = makeEngine({ runner, partSize: 1024, partStorage, store, capability: 'export' });
    const [loaded] = await s2.engine.load();
    expect(loaded?.status).toBe('paused');
    expect(loaded?.reason).toBe('INTERRUPTED');
    expect(loaded?.verified).toBe(true);
    await s2.engine.resume('dl-1');
    await flush(40);
    expect((await store.get('dl-1'))?.status).toBe('complete');
    expect(calls).toHaveLength(2); // the parts were durable: no transfer in session 2
    expect(s2.exports).toHaveLength(1);
    expect(types(s2.events)).toEqual(['started', 'exporting', 'complete']);
  });

  it('start(): export delivery without a usable OPFS throws SplitUnavailableError (quota / unavailable / no capability)', async () => {
    const { runner } = fakeRunner(fullOpfsPart(memoryStorage()));
    const quota = makeEngine({
      runner,
      partSize: 1024,
      partStorage: memoryStorage({ capacity: 1000 }),
      capability: 'export',
    });
    await expect(quota.engine.start(await issuedExport(2048), 'b', 'k')).rejects.toMatchObject({
      name: 'SplitUnavailableError',
      reason: 'OPFS_QUOTA',
    });
    const none = makeEngine({
      runner,
      partSize: 1024,
      partStorage: memoryStorage({ available: false }),
      capability: 'export',
    });
    await expect(none.engine.start(await issuedExport(2048), 'b', 'k')).rejects.toMatchObject({
      reason: 'OPFS_UNAVAILABLE',
    });
    const noCap = makeEngine({ runner, partSize: 1024, partStorage: memoryStorage(), capability: 'none' });
    const err = await noCap.engine.start(await issuedExport(2048), 'b', 'k').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SplitUnavailableError);
    expect((err as SplitUnavailableError).reason).toBe('NO_CAPABILITY');
    expect(await quota.store.get('dl-1')).toBeUndefined(); // nothing persisted
  });

  it('quota exhausted while writing a part → paused/STORAGE_QUOTA; resume retries in OPFS (no migration to direct)', async () => {
    const partStorage = memoryStorage();
    let failOnce = true;
    const { runner, calls } = fakeRunner(async (input) => {
      if (input.partIdx === 1 && failOnce) {
        failOnce = false;
        writePart(partStorage, input, 512);
        return { kind: 'error', fileError: true, quota: true, message: 'QuotaExceededError' };
      }
      writePart(partStorage, input);
      return { kind: 'done' };
    });
    const { engine, store, events, handle } = makeEngine({
      runner,
      partSize: 1024,
      partStorage,
      capability: 'export',
    });
    await engine.start(await issuedExport(2048), 'b', 'k');
    await flush(40);
    let rec = await store.get('dl-1');
    expect(rec?.status).toBe('paused');
    expect(rec?.reason).toBe('STORAGE_QUOTA');
    expect(rec?.storage).toBe('opfs');

    await engine.resume('dl-1');
    await flush(40);
    rec = await store.get('dl-1');
    expect(rec?.status).toBe('complete');
    expect(rec?.storage).toBe('opfs'); // still OPFS
    expect(handle.createWritable).not.toHaveBeenCalled(); // no destination, no migration
    expect(calls.filter((c) => c.partIdx === 1).map((c) => c.from)).toEqual([1024, 1024 + 512]);
    expect(types(events)).not.toContain('migrated');
  });

  it('cancel() during an export download deletes the part files and the record without touching any file handle', async () => {
    const partStorage = memoryStorage();
    const { runner } = fakeRunner(async (input) => {
      writePart(partStorage, input, 256);
      return 'hang';
    });
    const { engine, store, events, handle } = makeEngine({
      runner,
      partSize: 1024,
      partStorage,
      capability: 'export',
    });
    await engine.start(await issuedExport(2048), 'b', 'k');
    await flush();
    expect(partStorage.parts.size).toBe(2);
    await engine.cancel('dl-1');
    expect(partStorage.parts.size).toBe(0);
    expect(await store.get('dl-1')).toBeUndefined();
    expect(handle.createWritable).not.toHaveBeenCalled();
    expect(types(events)).toEqual(['started', 'cancelled']);
  });

  it('cancel() while the hand-over is in flight aborts the delivery signal', async () => {
    const partStorage = memoryStorage();
    const { runner } = fakeRunner(fullOpfsPart(partStorage));
    let seenSignal: AbortSignal | undefined;
    const deliver: ExportDelivery = (input) =>
      new Promise<ExportOutcome>((resolve) => {
        seenSignal = input.signal;
        input.signal?.addEventListener('abort', () => resolve({ kind: 'aborted', message: 'aborted' }));
      });
    const { engine, store } = makeEngine({
      runner,
      partSize: 1024,
      partStorage,
      capability: 'export',
      deliver,
    });
    await engine.start(await issuedExport(2048), 'b', 'k');
    await flush(40);
    expect((await store.get('dl-1'))?.status).toBe('exporting');
    await engine.cancel('dl-1');
    expect(seenSignal?.aborted).toBe(true);
    expect(await store.get('dl-1')).toBeUndefined();
    expect(partStorage.parts.size).toBe(0);
  });
});
