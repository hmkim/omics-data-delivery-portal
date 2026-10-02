import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { DownloadPath } from '@genome-portal/contract';
import type { StorageMode } from './partStorage';

/**
 * Persistent state of split downloads (R5.4). Stored in IndexedDB so a closed tab or a re-login can
 * resume from `parts[].receivedBytes`; the `FileSystemFileHandle` is structured-cloneable and survives too.
 *
 * `merging` (storage `opfs` only): every part is complete and is being streamed into the destination file.
 */
export type SplitStatus = 'running' | 'merging' | 'paused' | 'verifying' | 'complete' | 'failed';

/**
 * Why a download is paused. `INTERRUPTED`: the tab/browser went away while it was running (found at `load()`).
 * `STORAGE_QUOTA`: the OPFS part write hit the origin's quota; resuming migrates the download to `direct` storage.
 */
export type SplitPauseReason =
  'USER' | 'AUTH_EXPIRED' | 'PERMISSION' | 'NETWORK' | 'FILE_ERROR' | 'INTERRUPTED' | 'STORAGE_QUOTA';
export type SplitFailReason = 'CHECKSUM_MISMATCH' | 'FILE_ERROR' | 'NETWORK' | 'CANCELLED';
export type SplitReason = SplitPauseReason | SplitFailReason;

export interface SplitPartState {
  idx: number;
  start: number;
  /** inclusive */
  end: number;
  done: boolean;
  /**
   * Bytes of this part that are safe to skip on resume. `opfs`: bytes flushed to the part file (updated after
   * every chunk). `direct`: bytes written in this or an earlier session — may run ahead of the destination file
   * until `close()` commits the swap file, see `committedBytes`.
   */
  receivedBytes: number;
  /**
   * `direct` storage only: bytes of this part that the destination file is known to contain (last successful
   * `close()`). After an unclean stop `receivedBytes` is rolled back to this value. Absent on records written
   * before this field existed → treated as equal to `receivedBytes`.
   */
  committedBytes?: number;
}

export interface SplitRecord {
  downloadId: string;
  bucket: string;
  key: string;
  filename: string;
  size: number;
  path: DownloadPath;
  url: string;
  /** ISO-8601 */
  expiresAt: string;
  checksumCrc32?: string;
  parts: SplitPartState[];
  fileHandle: FileSystemFileHandle;
  /** Where in-flight bytes live (design §5.4). Records from before this field existed are `direct`. */
  storage?: StorageMode;
  /** The destination file holds every byte (merge / final close succeeded); only verification is left. */
  merged?: boolean;
  status: SplitStatus;
  reason?: SplitReason;
  /** optional message attached to the last failure */
  message?: string;
  createdAt: number;
  updatedAt: number;
  renewCount: number;
}

interface SplitsDb extends DBSchema {
  splits: {
    key: string;
    value: SplitRecord;
    indexes: { byStatus: string; byUpdated: number };
  };
}

export const DB_NAME = 'genome-portal';
export const DB_VERSION = 1;
export const SPLITS_STORE = 'splits';

export interface SplitStore {
  get(downloadId: string): Promise<SplitRecord | undefined>;
  put(record: SplitRecord): Promise<void>;
  delete(downloadId: string): Promise<void>;
  list(): Promise<SplitRecord[]>;
}

let dbPromise: Promise<IDBPDatabase<SplitsDb>> | undefined;

function db(): Promise<IDBPDatabase<SplitsDb>> {
  dbPromise ??= openDB<SplitsDb>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      const store = database.createObjectStore(SPLITS_STORE, { keyPath: 'downloadId' });
      store.createIndex('byStatus', 'status');
      store.createIndex('byUpdated', 'updatedAt');
    },
  });
  return dbPromise;
}

export const idbSplitStore: SplitStore = {
  async get(downloadId) {
    return (await db()).get(SPLITS_STORE, downloadId);
  },
  async put(record) {
    await (await db()).put(SPLITS_STORE, record);
  },
  async delete(downloadId) {
    await (await db()).delete(SPLITS_STORE, downloadId);
  },
  async list() {
    const all = await (await db()).getAllFromIndex(SPLITS_STORE, 'byUpdated');
    return all.reverse();
  },
};

/** In-memory store for unit tests and for environments without IndexedDB. */
export function createMemorySplitStore(): SplitStore {
  const map = new Map<string, SplitRecord>();
  return {
    async get(id) {
      return map.get(id);
    },
    async put(r) {
      map.set(r.downloadId, { ...r, parts: r.parts.map((p) => ({ ...p })) });
    },
    async delete(id) {
      map.delete(id);
    },
    async list() {
      return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    },
  };
}
