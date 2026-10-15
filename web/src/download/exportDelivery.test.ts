import { readFileSync } from 'node:fs';
import { Blob as NodeBlob } from 'node:buffer';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  concatParts,
  createBrowserExportDelivery,
  EXPORT_SW_SCOPE,
  registerExportServiceWorker,
  supportsTransferableStreams,
  type ExportInput,
} from './exportDelivery';

const part = (bytes: number, fill: number) =>
  new NodeBlob([new Uint8Array(bytes).fill(fill)]) as unknown as Blob;

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

describe('exportDelivery.concatParts (D8)', () => {
  it('streams the parts in order, reports cumulative progress and the close', async () => {
    const progress: number[] = [];
    const onClose = vi.fn();
    const bytes = await drain(
      concatParts([part(1000, 1), part(500, 2), part(0, 9), part(250, 3)], {
        onProgress: (n) => progress.push(n),
        onClose,
      }),
    );
    expect(bytes.byteLength).toBe(1750);
    expect(bytes[0]).toBe(1);
    expect(bytes[999]).toBe(1);
    expect(bytes[1000]).toBe(2);
    expect(bytes[1499]).toBe(2);
    expect(bytes[1500]).toBe(3);
    expect(progress.at(-1)).toBe(1750);
    expect(progress.every((n, i) => i === 0 || n > (progress[i - 1] ?? 0))).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cancel from the consumer reaches onCancel (and not onClose)', async () => {
    const onClose = vi.fn();
    const onCancel = vi.fn();
    const stream = concatParts([part(1000, 1), part(1000, 2)], { onClose, onCancel });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel(new Error('user cancelled the download'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect((onCancel.mock.calls[0]?.[0] as Error).message).toBe('user cancelled the download');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('an empty part list closes immediately', async () => {
    const onClose = vi.fn();
    expect((await drain(concatParts([], { onClose }))).byteLength).toBe(0);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('exportDelivery.supportsTransferableStreams', () => {
  it('true when postMessage accepts the stream as a transferable, false on DataCloneError (Safari ≤ 26)', () => {
    const okChannel = function () {
      return {
        port1: { postMessage: () => undefined, close: () => undefined },
        port2: { close: () => undefined },
      };
    } as unknown as typeof MessageChannel;
    const failingChannel = function () {
      return {
        port1: {
          postMessage: () => {
            throw new DOMException('not transferable', 'DataCloneError');
          },
          close: () => undefined,
        },
        port2: { close: () => undefined },
      };
    } as unknown as typeof MessageChannel;
    expect(supportsTransferableStreams({ MessageChannel: okChannel, ReadableStream })).toBe(true);
    expect(supportsTransferableStreams({ MessageChannel: failingChannel, ReadableStream })).toBe(false);
    expect(supportsTransferableStreams({ MessageChannel: undefined, ReadableStream })).toBe(false);
  });
});

/** a document stand-in that records appended elements and lets the test click anchors */
function fakeDocument() {
  const appended: Array<Record<string, unknown>> = [];
  const doc = {
    body: {
      appendChild: (el: Record<string, unknown>) => {
        appended.push(el);
        return el;
      },
      removeChild: () => undefined,
    },
    createElement: (tag: string) => {
      const el: Record<string, unknown> = {
        tagName: tag,
        style: {},
        clicks: 0,
        hidden: false,
        setAttribute: (k: string, v: string) => {
          el[k] = v;
        },
        click: () => {
          el.clicks = (el.clicks as number) + 1;
        },
        remove: () => {
          el.removed = true;
        },
      };
      return el;
    },
  } as unknown as Document;
  return { doc, appended };
}

describe('exportDelivery.createBrowserExportDelivery', () => {
  const input = (over: Partial<ExportInput> = {}): ExportInput => ({
    downloadId: 'dl-1',
    filename: 'sample 1.bam',
    size: 1500,
    parts: [part(1000, 1), part(500, 2)],
    ...over,
  });

  it('Blob path: one Blob over the parts behind an object URL, anchor download clicked, outcome handed', async () => {
    const { doc, appended } = fakeDocument();
    const urlCtor = URL as unknown as { createObjectURL?: (b: Blob) => string };
    const previous = urlCtor.createObjectURL;
    const seenBlobs: Blob[] = [];
    urlCtor.createObjectURL = (b: Blob) => {
      seenBlobs.push(b);
      return 'blob:https://portal/x';
    };
    try {
      const onObjectUrl = vi.fn();
      const deliver = createBrowserExportDelivery({
        doc,
        serviceWorker: undefined,
        transferable: () => false,
      });
      // jsdom's Blob only composes jsdom Blobs (a foreign Blob part is stringified); browsers compose File refs
      const jsdomParts = [new Blob([new Uint8Array(1000).fill(1)]), new Blob([new Uint8Array(500).fill(2)])];
      const outcome = await deliver(input({ onObjectUrl, parts: jsdomParts }));
      expect(outcome).toEqual({ kind: 'handed' });
      expect(seenBlobs).toHaveLength(1);
      expect(seenBlobs[0]?.size).toBe(1500);
      expect(onObjectUrl).toHaveBeenCalledWith('blob:https://portal/x');
      const anchor = appended.find((el) => el.tagName === 'a');
      expect(anchor?.href).toBe('blob:https://portal/x');
      expect(anchor?.download).toBe('sample 1.bam');
      expect(anchor?.clicks).toBe(1);
    } finally {
      urlCtor.createObjectURL = previous;
    }
  });

  it('stream path: hands the stream to the export SW, navigates a hidden iframe, resolves streamed when the worker drained it', async () => {
    const { doc, appended } = fakeDocument();
    const posted: Array<{ msg: Record<string, unknown>; transfer: unknown[] }> = [];
    let drained: Uint8Array | undefined;
    const active = {
      postMessage: (msg: Record<string, unknown>, transfer: unknown[] = []) => {
        if (msg.type === 'keepalive') return;
        posted.push({ msg, transfer });
        const port = transfer[1] as MessagePort;
        port.postMessage({ ready: true });
        // the browser reads the response body to the end (asynchronously, like a real download)
        void drain(msg.stream as ReadableStream<Uint8Array>).then((b) => {
          drained = b;
        });
      },
    };
    const container = {
      getRegistration: async (scope: string) => (scope === EXPORT_SW_SCOPE ? { active } : undefined),
    } as unknown as ServiceWorkerContainer;
    const progress: number[] = [];
    const deliver = createBrowserExportDelivery({
      doc,
      serviceWorker: container,
      transferable: () => true,
      finalizeGraceMs: 0,
    });
    const outcome = await deliver(input({ onProgress: (n) => progress.push(n) }));
    expect(outcome).toEqual({ kind: 'streamed' });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.msg).toMatchObject({ filename: 'sample 1.bam', size: 1500 });
    expect(String(posted[0]?.msg.downloadId)).toMatch(/^dl-1-\d+$/);
    expect(posted[0]?.transfer[0]).toBe(posted[0]?.msg.stream); // the stream itself is transferred
    const frame = appended.find((el) => el.tagName === 'iframe');
    expect(frame?.src).toBe(`${EXPORT_SW_SCOPE}${encodeURIComponent(String(posted[0]?.msg.downloadId))}`);
    expect(frame?.hidden).toBe(true);
    expect(drained?.byteLength).toBe(1500);
    expect(progress.at(-1)).toBe(1500);
  });

  it('stream path: the iframe survives the whole pull and is removed only after the stream closes (regression: a mid-pull removal truncated the Firefox download)', async () => {
    const { doc, appended } = fakeDocument();
    let releaseRest: () => void = () => undefined;
    const restGate = new Promise<void>((r) => {
      releaseRest = r;
    });
    // a worker that reads the first chunk, then stalls until the test lets the rest through
    const active = {
      postMessage: (msg: Record<string, unknown>, transfer: unknown[] = []) => {
        if (msg.type === 'keepalive') return;
        (transfer[1] as MessagePort).postMessage({ ready: true });
        void (async () => {
          const reader = (msg.stream as ReadableStream<Uint8Array>).getReader();
          await reader.read(); // first part
          await restGate; // the download is still in flight here
          for (;;) {
            const { done } = await reader.read();
            if (done) break;
          }
        })();
      },
    };
    const container = {
      getRegistration: async () => ({ active }),
    } as unknown as ServiceWorkerContainer;
    const deliver = createBrowserExportDelivery({
      doc,
      serviceWorker: container,
      transferable: () => true,
      finalizeGraceMs: 0,
    });
    const settled = deliver(input());

    // give the microtasks a few turns: the first part is read, the rest is gated — the download is NOT done
    await new Promise((r) => setTimeout(r, 20));
    const frame = appended.find((el) => el.tagName === 'iframe');
    expect(frame?.removed).toBeFalsy(); // the frame must still be in the DOM while bytes are flowing

    releaseRest(); // the browser pulls the remaining bytes to the end
    expect(await settled).toEqual({ kind: 'streamed' });
    expect(frame?.removed).toBe(true); // only now, after close (+grace), is it torn down
  });

  it('stream path: the browser cancelling the response → aborted with the reason; no Blob fallback afterwards', async () => {
    const { doc, appended } = fakeDocument();
    const active = {
      postMessage: (msg: Record<string, unknown>, transfer: unknown[] = []) => {
        if (msg.type === 'keepalive') return;
        (transfer[1] as MessagePort).postMessage({ ready: true });
        const reader = (msg.stream as ReadableStream<Uint8Array>).getReader();
        void reader.read().then(() => reader.cancel(new Error('download cancelled')));
      },
    };
    const container = {
      getRegistration: async () => ({ active }),
    } as unknown as ServiceWorkerContainer;
    const deliver = createBrowserExportDelivery({ doc, serviceWorker: container, transferable: () => true });
    const outcome = await deliver(input());
    expect(outcome).toEqual({ kind: 'aborted', message: 'download cancelled' });
    expect(appended.some((el) => el.tagName === 'a')).toBe(false);
  });

  it('stream path: no active export worker → Blob path', async () => {
    const { doc, appended } = fakeDocument();
    const urlCtor = URL as unknown as { createObjectURL?: (b: Blob) => string };
    const previous = urlCtor.createObjectURL;
    urlCtor.createObjectURL = () => 'blob:https://portal/y';
    try {
      const container = { getRegistration: async () => undefined } as unknown as ServiceWorkerContainer;
      const deliver = createBrowserExportDelivery({
        doc,
        serviceWorker: container,
        transferable: () => true,
      });
      expect(await deliver(input())).toEqual({ kind: 'handed' });
      expect(appended.some((el) => el.tagName === 'a')).toBe(true);
    } finally {
      urlCtor.createObjectURL = previous;
    }
  });

  it('registerExportServiceWorker: registers once at the export scope; a failure is swallowed', async () => {
    const register = vi.fn(async () => ({}) as ServiceWorkerRegistration);
    await registerExportServiceWorker({ register } as unknown as ServiceWorkerContainer);
    expect(register).toHaveBeenCalledWith('/portal-export/export-sw.js', { scope: '/portal-export/' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = { register: vi.fn(async () => Promise.reject(new Error('insecure'))) };
    expect(await registerExportServiceWorker(failing as unknown as ServiceWorkerContainer)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(await registerExportServiceWorker(undefined)).toBeUndefined();
  });
});

/**
 * The service worker script is plain JS served from web/public. Load it with a fake `self` and drive the three
 * events it handles.
 */
describe('public/portal-export/export-sw.js', () => {
  function loadWorker() {
    const source = readFileSync(
      resolve(import.meta.dirname, '..', '..', 'public', 'portal-export', 'export-sw.js'),
      'utf8',
    );
    const listeners = new Map<string, (event: never) => void>();
    const self = {
      location: { origin: 'https://portal.example' },
      addEventListener: (type: string, fn: (event: never) => void) => listeners.set(type, fn),
      skipWaiting: vi.fn(),
      clients: { claim: vi.fn(async () => undefined) },
    };
    new Function('self', source)(self);
    const fire = (type: string, event: unknown) => {
      const fn = listeners.get(type);
      if (!fn) throw new Error(`no listener for ${type}`);
      fn(event as never);
    };
    return { self, fire };
  }

  it('install skips waiting, activate claims clients', () => {
    const { self, fire } = loadWorker();
    fire('install', {});
    expect(self.skipWaiting).toHaveBeenCalled();
    const waitUntil = vi.fn();
    fire('activate', { waitUntil });
    expect(waitUntil).toHaveBeenCalled();
    expect(self.clients.claim).toHaveBeenCalled();
  });

  it('message → ready on the port; fetch in scope → attachment response with Content-Length and the stream', async () => {
    const { fire } = loadWorker();
    const ready = vi.fn();
    const stream = concatParts([part(10, 1), part(5, 2)]);
    fire('message', {
      origin: 'https://portal.example',
      data: { downloadId: 'dl 1-123', filename: '샘플 "a".bam', size: 15, stream },
      ports: [{ postMessage: ready }],
    });
    expect(ready).toHaveBeenCalledWith({ ready: true });

    let response: Response | undefined;
    fire('fetch', {
      request: { url: `https://portal.example/portal-export/${encodeURIComponent('dl 1-123')}` },
      respondWith: (r: Response) => {
        response = r;
      },
    });
    expect(response).toBeDefined();
    expect(response?.status).toBe(200);
    expect(response?.headers.get('Content-Length')).toBe('15');
    expect(response?.headers.get('Content-Disposition')).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('샘플 "a".bam')}`,
    );
    expect(response?.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(response?.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(
      new Uint8Array([...new Array(10).fill(1), ...new Array(5).fill(2)]),
    );

    // the entry is consumed: a second navigation to the same id is not answered
    let second: Response | undefined;
    fire('fetch', {
      request: { url: 'https://portal.example/portal-export/dl%201-123' },
      respondWith: (r: Response) => {
        second = r;
      },
    });
    expect(second).toBeUndefined();
  });

  it('ignores messages from another origin, keepalive pings and fetches outside the scope', () => {
    const { fire } = loadWorker();
    const ready = vi.fn();
    fire('message', {
      origin: 'https://evil.example',
      data: { downloadId: 'x', filename: 'x', size: 1, stream: concatParts([part(1, 1)]) },
      ports: [{ postMessage: ready }],
    });
    expect(ready).not.toHaveBeenCalled();
    const waitUntil = vi.fn();
    fire('message', { origin: 'https://portal.example', data: { type: 'keepalive' }, waitUntil });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    const respondWith = vi.fn();
    fire('fetch', { request: { url: 'https://portal.example/api/locations' }, respondWith });
    fire('fetch', { request: { url: 'https://portal.example/portal-export/' }, respondWith });
    fire('fetch', { request: { url: 'https://portal.example/portal-export/unknown' }, respondWith });
    expect(respondWith).not.toHaveBeenCalled();
  });
});
