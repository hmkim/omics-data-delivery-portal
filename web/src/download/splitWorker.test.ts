import { describe, expect, it, vi } from 'vitest';
import {
  isLockContention,
  isQuotaError,
  transferPart,
  withLockRetry,
  type DurableSink,
  type WorkerOutbound,
  type WorkerStartMessage,
} from './splitWorker';

function rangeServer(total: number, status = 206) {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const range = /bytes=(\d+)-(\d+)/.exec((init?.headers as Record<string, string>).Range ?? '');
    const from = Number(range?.[1]);
    const to = Math.min(Number(range?.[2]), total - 1);
    const body = new Uint8Array(to - from + 1).map((_, i) => (from + i) % 251);
    // deliver in uneven pieces to exercise chunk assembly
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        let off = 0;
        while (off < body.length) {
          const n = Math.min(37, body.length - off);
          c.enqueue(body.subarray(off, off + n));
          off += n;
        }
        c.close();
      },
    });
    return new Response(status === 206 ? stream : null, { status });
  });
}

const start = (over: Partial<WorkerStartMessage> = {}): WorkerStartMessage => ({
  type: 'start',
  partIdx: 0,
  url: 'https://s3.example/o',
  from: 100,
  to: 399,
  chunkBytes: 128,
  maxInflight: 2,
  ...over,
});

describe('splitWorker.transferPart (T3.8)', () => {
  it('fetches the Range, emits ≤ chunkBytes chunks at absolute positions, then part-done', async () => {
    const fetchFn = rangeServer(1000);
    const out: WorkerOutbound[] = [];
    const waitForAck = vi.fn(async () => undefined);
    await transferPart(start(), {
      fetchFn,
      post: (m) => out.push(m),
      signal: new AbortController().signal,
      waitForAck,
    });
    // 3 chunks with maxInflight 2: one wait mid-stream (2 in flight) + 2 drains before part-done
    expect(waitForAck).toHaveBeenCalledTimes(3);
    expect((fetchFn.mock.calls[0]?.[1]?.headers as Record<string, string>).Range).toBe('bytes=100-399');
    const chunks = out.filter((m): m is Extract<WorkerOutbound, { type: 'chunk' }> => m.type === 'chunk');
    expect(chunks.map((c) => [c.position, c.data.byteLength])).toEqual([
      [100, 128],
      [228, 128],
      [356, 44],
    ]);
    expect(new Uint8Array(chunks[0]!.data)[0]).toBe(100 % 251);
    expect(out.at(-1)).toEqual({ type: 'part-done', partIdx: 0 });
  });

  it('non-206 responses become an error with the status (engine renews on 403)', async () => {
    const out: WorkerOutbound[] = [];
    await transferPart(start(), {
      fetchFn: rangeServer(1000, 403),
      post: (m) => out.push(m),
      signal: new AbortController().signal,
      waitForAck: async () => undefined,
    });
    expect(out).toEqual([
      { type: 'error', partIdx: 0, status: 403, message: expect.stringContaining('403') },
    ]);
  });

  it('abort during the transfer reports aborted, not error', async () => {
    const controller = new AbortController();
    const out: WorkerOutbound[] = [];
    await transferPart(start(), {
      fetchFn: async () => {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      },
      post: (m) => out.push(m),
      signal: controller.signal,
      waitForAck: async () => undefined,
    });
    expect(out).toEqual([{ type: 'aborted', partIdx: 0 }]);
  });
});

// ---------------------------------------------------------------------------
// OPFS sink (design §5.4 plan A): the worker writes in place and reports durable bytes
// ---------------------------------------------------------------------------

/** In-memory stand-in for a `FileSystemSyncAccessHandle`-backed part file; `partStart` makes positions part-relative. */
function fakeSink(partStart: number, opts: { failAt?: number; failWith?: unknown } = {}) {
  let bytes = new Uint8Array(0);
  let durable = 0;
  let closed = 0;
  const sink: DurableSink & {
    readonly bytes: Uint8Array;
    readonly durable: number;
    readonly closed: number;
    flushes: number;
  } = {
    flushes: 0,
    get bytes() {
      return bytes;
    },
    get durable() {
      return durable;
    },
    get closed() {
      return closed;
    },
    write(position, data) {
      const at = position - partStart;
      if (opts.failAt !== undefined && at + data.byteLength > opts.failAt) {
        throw opts.failWith ?? new DOMException('quota', 'QuotaExceededError');
      }
      const next = new Uint8Array(Math.max(bytes.byteLength, at + data.byteLength));
      next.set(bytes, 0);
      next.set(data, at);
      bytes = next;
    },
    flush() {
      sink.flushes += 1;
      durable = bytes.byteLength;
      return durable;
    },
    close() {
      closed += 1;
    },
  };
  return sink;
}

const opfs = (partStart: number) => ({ kind: 'opfs' as const, downloadId: 'dl-1', partStart });

describe('splitWorker.transferPart — OPFS sink (T7.2, plan A)', () => {
  it('writes in place, flushes every chunkBytes and reports the durable byte count from the part start', async () => {
    const sink = fakeSink(100);
    const out: WorkerOutbound[] = [];
    await transferPart(start({ sink: opfs(100) }), {
      fetchFn: rangeServer(1000),
      post: (m) => out.push(m),
      signal: new AbortController().signal,
      waitForAck: async () => {
        throw new Error('the OPFS path never waits for engine acks');
      },
      sink,
    });
    const progress = out.filter(
      (m): m is Extract<WorkerOutbound, { type: 'progress' }> => m.type === 'progress',
    );
    // 300 bytes in 37-byte pieces with chunkBytes 128: flush once ≥128 accumulated since the last flush
    // (4 pieces = 148, 4 more = 296), then the 4-byte tail (300)
    expect(progress.map((p) => p.writtenBytes)).toEqual([148, 296, 300]);
    expect(out.filter((m) => m.type === 'chunk')).toHaveLength(0); // nothing crosses the thread boundary
    expect(out.at(-1)).toEqual({ type: 'part-done', partIdx: 0 });
    expect(sink.bytes.byteLength).toBe(300);
    expect(sink.bytes[0]).toBe(100 % 251);
    expect(sink.bytes[299]).toBe(399 % 251);
    expect(sink.durable).toBe(300);
    expect(sink.closed).toBe(1);
  });

  it('resume offset: the Range starts at `from`, positions are stored relative to the part start', async () => {
    const sink = fakeSink(100);
    const out: WorkerOutbound[] = [];
    await transferPart(start({ from: 250, sink: opfs(100) }), {
      fetchFn: rangeServer(1000),
      post: (m) => out.push(m),
      signal: new AbortController().signal,
      waitForAck: async () => undefined,
      sink,
    });
    // bytes 250..399 land at part offsets 150..299; the sink starts empty so its length grows to 300
    expect(sink.bytes.byteLength).toBe(300);
    expect(sink.bytes[150]).toBe(250 % 251);
    expect(out.filter((m) => m.type === 'progress').at(-1)).toEqual({
      type: 'progress',
      partIdx: 0,
      writtenBytes: 300,
    });
    expect(out.at(-1)).toEqual({ type: 'part-done', partIdx: 0 });
  });

  it('a QuotaExceededError from the part file → error with fileError + quota (engine pauses with STORAGE_QUOTA)', async () => {
    const sink = fakeSink(100, { failAt: 200 });
    const out: WorkerOutbound[] = [];
    await transferPart(start({ sink: opfs(100) }), {
      fetchFn: rangeServer(1000),
      post: (m) => out.push(m),
      signal: new AbortController().signal,
      waitForAck: async () => undefined,
      sink,
    });
    expect(out.at(-1)).toMatchObject({ type: 'error', partIdx: 0, fileError: true, quota: true });
    expect(sink.closed).toBe(1);
  });

  it('a network failure mid-part flushes what was written and reports it before the error', async () => {
    const sink = fakeSink(100);
    const out: WorkerOutbound[] = [];
    let served = 0;
    const fetchFn = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (served >= 200) {
            c.error(new TypeError('network error'));
            return;
          }
          c.enqueue(new Uint8Array(50).fill(7));
          served += 50;
        },
      });
      return new Response(stream, { status: 206 });
    });
    await transferPart(start({ sink: opfs(100) }), {
      fetchFn,
      post: (m) => out.push(m),
      signal: new AbortController().signal,
      waitForAck: async () => undefined,
      sink,
    });
    const progress = out.filter(
      (m): m is Extract<WorkerOutbound, { type: 'progress' }> => m.type === 'progress',
    );
    // 150 bytes flushed at the 128-byte mark, the remaining 50 flushed by the failure path
    expect(progress.map((p) => p.writtenBytes)).toEqual([150, 200]);
    expect(sink.durable).toBe(200);
    expect(out.at(-1)).toMatchObject({ type: 'error', partIdx: 0, message: 'network error' });
    expect((out.at(-1) as { fileError?: boolean }).fileError).toBeUndefined();
    expect(sink.closed).toBe(1);
  });

  it('isQuotaError recognises QuotaExceededError and quota-worded errors only', () => {
    expect(isQuotaError(new DOMException('x', 'QuotaExceededError'))).toBe(true);
    expect(isQuotaError(new Error('The quota has been exceeded.'))).toBe(true);
    // Firefox: XPCOM exception object from truncate(), not a DOMException and no "quota" in the text
    expect(
      isQuotaError({
        name: 'NS_ERROR_FILE_NO_DEVICE_SPACE',
        message: '',
        toString: () =>
          '[Exception... "File error: No device space"  nsresult: "0x80520010 (NS_ERROR_FILE_NO_DEVICE_SPACE)"]',
      }),
    ).toBe(true);
    expect(isQuotaError(new DOMException('x', 'NotFoundError'))).toBe(false);
    expect(isQuotaError(new TypeError('network error'))).toBe(false);
  });

  it('withLockRetry: retries createSyncAccessHandle while the previous page still holds the file lock, then gives up', async () => {
    const contention = new DOMException(
      "Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles cannot be created if there is another open Access Handle or Writable stream associated with the same file.",
      'NoModificationAllowedError',
    );
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    let calls = 0;
    const handle = await withLockRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw contention;
        return 'handle';
      },
      [10, 20, 40],
      sleep,
    );
    expect(handle).toBe('handle');
    expect(sleeps).toEqual([10, 20]);

    // exhausted delays → the contention error surfaces (engine pauses with FILE_ERROR)
    await expect(withLockRetry(async () => Promise.reject(contention), [1, 2], sleep)).rejects.toBe(
      contention,
    );
    // unrelated errors are not retried
    const other = new DOMException('gone', 'NotFoundError');
    let otherCalls = 0;
    await expect(
      withLockRetry(
        async () => {
          otherCalls += 1;
          throw other;
        },
        [1, 2],
        sleep,
      ),
    ).rejects.toBe(other);
    expect(otherCalls).toBe(1);
    expect(isLockContention(contention)).toBe(true);
    expect(isLockContention(new DOMException('x', 'QuotaExceededError'))).toBe(false);
  });
});
