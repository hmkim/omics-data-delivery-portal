/**
 * Where the bytes of a split download live while it is in flight (design §5.4, T7.2 / scenario 5).
 *
 * `opfs` (plan A): every part is its own file in the origin-private file system, written by the part worker through
 * a `FileSystemSyncAccessHandle` (`write` + `flush` = durable, no swap file). Progress persisted to IndexedDB never
 * runs ahead of the bytes on disk, so a reload, a closed tab or a browser crash costs at most the chunk in flight.
 * The parts are merged once into the user-chosen destination when all of them are complete.
 *
 * `direct` (plan C fallback): the legacy path — parts are written straight into the destination's
 * `FileSystemWritableFileStream`, which commits only on `close()`. Used when OPFS is unavailable or its quota cannot
 * hold the file (incognito windows keep OPFS in memory). Progress after an unclean stop rolls back to the last
 * committed byte (`committedBytes`), so the resume is always correct but may re-receive data.
 */
export type StorageMode = 'opfs' | 'direct';

export const OPFS_ROOT_DIR = 'genome-portal-splits';

/** Headroom kept free in the origin's quota beyond the file itself (IndexedDB, other tabs). */
export const OPFS_QUOTA_MARGIN_BYTES = 256 * 1024 * 1024;

export function partFileName(idx: number): string {
  return `part-${String(idx).padStart(4, '0')}`;
}

export interface PartStorage {
  /** OPFS exists in this context (main-thread API; the worker opens its own sync handle). */
  available(): boolean;
  /**
   * Bytes the origin may still store (`quota - usage`), or `undefined` when the browser cannot say. Chromium caps
   * the REPORTED quota (dev, 2026-09-29: 10 GiB reported while > 160 GiB was enforced), so this is only a hint.
   */
  estimateFree(): Promise<number | undefined>;
  /**
   * Exact check: can `bytes` more be stored for this download right now? Implemented by reserving that size with a
   * quota-enforced `truncate()` on a scratch file (no I/O) and releasing it. `undefined` when the check is not
   * available in this environment.
   */
  canHold?(downloadId: string, bytes: number): Promise<boolean | undefined>;
  /** Ask the browser not to evict this origin's storage under disk pressure. Best effort. */
  persist(): Promise<boolean>;
  /** Current size of a part file, 0 when it does not exist. */
  partSize(downloadId: string, idx: number): Promise<number>;
  /** The part file for merging; `undefined` when it does not exist. */
  partFile(downloadId: string, idx: number): Promise<Blob | undefined>;
  /** Remove the download's part directory (complete, cancel, "download again"). */
  deleteAll(downloadId: string): Promise<void>;
}

type StorageManagerLike = Pick<StorageManager, 'getDirectory'> &
  Partial<Pick<StorageManager, 'estimate' | 'persist'>>;

function storageManager(): StorageManagerLike | undefined {
  const nav = globalThis.navigator as Navigator | undefined;
  const sm = nav?.storage as StorageManagerLike | undefined;
  return sm && typeof sm.getDirectory === 'function' ? sm : undefined;
}

async function downloadDir(
  sm: StorageManagerLike,
  downloadId: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    const root = await sm.getDirectory();
    const splits = await root.getDirectoryHandle(OPFS_ROOT_DIR, { create });
    return await splits.getDirectoryHandle(downloadId, { create });
  } catch (err) {
    if (!create && err instanceof DOMException && err.name === 'NotFoundError') return undefined;
    throw err;
  }
}

export const opfsPartStorage: PartStorage = {
  available() {
    return storageManager() !== undefined;
  },

  async estimateFree() {
    const sm = storageManager();
    if (!sm || typeof sm.estimate !== 'function') return undefined;
    try {
      const { quota, usage } = await sm.estimate();
      if (quota === undefined || usage === undefined) return undefined;
      return Math.max(0, quota - usage);
    } catch {
      return undefined;
    }
  },

  async persist() {
    const sm = storageManager();
    if (!sm || typeof sm.persist !== 'function') return false;
    try {
      return await sm.persist();
    } catch {
      return false;
    }
  },

  async partSize(downloadId, idx) {
    const file = await this.partFile(downloadId, idx);
    return file?.size ?? 0;
  },

  async partFile(downloadId, idx) {
    const sm = storageManager();
    if (!sm) return undefined;
    const dir = await downloadDir(sm, downloadId, false);
    if (!dir) return undefined;
    try {
      const handle = await dir.getFileHandle(partFileName(idx));
      return await handle.getFile();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') return undefined;
      throw err;
    }
  },

  async deleteAll(downloadId) {
    const sm = storageManager();
    if (!sm) return;
    try {
      const root = await sm.getDirectory();
      const splits = await root.getDirectoryHandle(OPFS_ROOT_DIR, { create: false });
      await splits.removeEntry(downloadId, { recursive: true });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') return;
      throw err;
    }
  },
};

export interface StorageChoice {
  mode: StorageMode;
  /** why `direct` was chosen; undefined for `opfs` */
  fallbackReason?: 'OPFS_UNAVAILABLE' | 'OPFS_QUOTA';
  freeBytes?: number;
  /** how the quota question was answered: exact reservation probe, the browser's estimate, or not at all */
  checkedBy?: 'probe' | 'estimate' | 'none';
}

/**
 * Pick the storage for a new split download: OPFS when it exists and can hold the whole file plus a margin, otherwise
 * the direct path. The exact reservation probe (`canHold`) is preferred; without it the browser's estimate decides,
 * and an unknown estimate does not block OPFS (a quota error at write time pauses the download with `STORAGE_QUOTA`,
 * and resuming migrates it to `direct`).
 */
export async function chooseStorage(
  downloadId: string,
  sizeBytes: number,
  storage: PartStorage,
  margin = OPFS_QUOTA_MARGIN_BYTES,
): Promise<StorageChoice> {
  if (!storage.available()) return { mode: 'direct', fallbackReason: 'OPFS_UNAVAILABLE', checkedBy: 'none' };
  const needed = sizeBytes + margin;
  if (storage.canHold) {
    const fits = await storage.canHold(downloadId, needed).catch(() => undefined);
    if (fits === true) return { mode: 'opfs', checkedBy: 'probe' };
    if (fits === false) {
      const free = await storage.estimateFree();
      return { mode: 'direct', fallbackReason: 'OPFS_QUOTA', freeBytes: free, checkedBy: 'probe' };
    }
  }
  const free = await storage.estimateFree();
  if (free !== undefined && free < needed) {
    return { mode: 'direct', fallbackReason: 'OPFS_QUOTA', freeBytes: free, checkedBy: 'estimate' };
  }
  return { mode: 'opfs', freeBytes: free, checkedBy: free === undefined ? 'none' : 'estimate' };
}

/** In-memory `PartStorage` for unit tests and non-browser environments; `parts` holds the written bytes. */
export function createMemoryPartStorage(
  opts: { available?: boolean; free?: number; capacity?: number } = {},
) {
  const parts = new Map<string, Uint8Array>();
  const key = (downloadId: string, idx: number) => `${downloadId}/${idx}`;
  const storage: PartStorage & {
    parts: Map<string, Uint8Array>;
    /** write helper for fake part runners: appends/overwrites at `at` within the part file */
    write(downloadId: string, idx: number, at: number, data: Uint8Array): void;
    truncate(downloadId: string, idx: number, size: number): void;
    persistCalls: number;
    probes: Array<{ downloadId: string; bytes: number }>;
  } = {
    parts,
    persistCalls: 0,
    probes: [],
    available: () => opts.available ?? true,
    estimateFree: async () => opts.free,
    ...(opts.capacity !== undefined
      ? {
          canHold: async (downloadId: string, bytes: number) => {
            storage.probes.push({ downloadId, bytes });
            return bytes <= (opts.capacity as number);
          },
        }
      : {}),
    async persist() {
      storage.persistCalls += 1;
      return true;
    },
    async partSize(downloadId, idx) {
      return parts.get(key(downloadId, idx))?.byteLength ?? 0;
    },
    async partFile(downloadId, idx) {
      const bytes = parts.get(key(downloadId, idx));
      return bytes ? new Blob([new Uint8Array(bytes).buffer as ArrayBuffer]) : undefined;
    },
    async deleteAll(downloadId) {
      for (const k of [...parts.keys()]) if (k.startsWith(`${downloadId}/`)) parts.delete(k);
    },
    write(downloadId, idx, at, data) {
      const k = key(downloadId, idx);
      const current = parts.get(k) ?? new Uint8Array(0);
      const next = new Uint8Array(Math.max(current.byteLength, at + data.byteLength));
      next.set(current, 0);
      next.set(data, at);
      parts.set(k, next);
    },
    truncate(downloadId, idx, size) {
      const k = key(downloadId, idx);
      const current = parts.get(k);
      if (current && current.byteLength > size) parts.set(k, current.slice(0, size));
    },
  };
  return storage;
}
