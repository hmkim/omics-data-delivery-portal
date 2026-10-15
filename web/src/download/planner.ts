import { planClientMode, type ClientMode, type RuntimeSettings } from '@genome-portal/contract';
import { getConfig } from '../config';

export type PlannerSettings = Pick<RuntimeSettings, 'splitThresholdBytes' | 'singleObjectLimitBytes'>;

/**
 * How this browser can run a split download (design §5.4, D8).
 * - `picker`: File System Access API — the user picks the destination file, parts are merged into it.
 * - `export`: no picker, but an origin-private file system with sync access handles (Firefox 111+, Safari 17+,
 *   Brave, iOS) — parts are received into OPFS, verified, then handed to the browser's ordinary download.
 * - `none`: neither — ordinary download (R5.9 hint) or the aria2c/curl commands (R5.6).
 */
export type SplitCapability = 'picker' | 'export' | 'none';

/** File System Access API availability (design §5.4): Chrome/Edge true, Safari/Firefox/Brave false. */
export function hasFileSystemAccess(
  win: Pick<Window, 'showSaveFilePicker'> | undefined = globalThis.window,
): boolean {
  return !!win && 'showSaveFilePicker' in win && typeof win.showSaveFilePicker === 'function';
}

export interface CapabilityEnv {
  window?: Pick<Window, 'showSaveFilePicker'>;
  navigator?: { storage?: Partial<Pick<StorageManager, 'getDirectory'>> };
  /** a module `Worker` is required to open sync access handles */
  hasWorker?: boolean;
}

function defaultEnv(): CapabilityEnv {
  const g = globalThis as typeof globalThis;
  return {
    window: g.window,
    navigator: g.navigator as CapabilityEnv['navigator'],
    hasWorker: typeof g.Worker === 'function',
  };
}

/**
 * Feature detection, synchronous (the data table calls it per row). OPFS presence is checked on the main thread
 * through `navigator.storage.getDirectory`; `FileSystemSyncAccessHandle` itself is only exposed inside workers
 * (Firefox 155 / Chromium 153 probe, 2026-10-14), and every browser in the support window that has `getDirectory`
 * also has it (Firefox 111+, Safari 15.2+, Chromium 102+). Whether the quota can hold the file is answered later by
 * the engine's reservation probe (`chooseStorage`); a negative answer sends the download to the `none` behaviour
 * through `SplitUnavailableError`.
 */
export function splitCapability(env: CapabilityEnv = defaultEnv()): SplitCapability {
  if (hasFileSystemAccess(env.window)) return 'picker';
  const getDirectory = env.navigator?.storage?.getDirectory;
  if (typeof getDirectory === 'function' && (env.hasWorker ?? true)) return 'export';
  return 'none';
}

export interface DecideInput {
  sizeBytes: number;
}

export interface DecideOptions {
  /** override the detected capability (tests, handler fixtures) */
  capability?: SplitCapability;
  /** legacy override: `true` = picker, `false` = none */
  hasFileSystemAccess?: boolean;
  settings?: PlannerSettings;
}

export function capabilityFrom(options: DecideOptions): SplitCapability {
  if (options.capability) return options.capability;
  if (options.hasFileSystemAccess !== undefined) return options.hasFileSystemAccess ? 'picker' : 'none';
  return splitCapability();
}

/**
 * Size × browser capability → `single | split | command` (§5.4 matrix). Thin wrapper around the
 * contract's `planClientMode` so that infra, the server hint and the SPA cannot drift apart.
 * Thresholds default to `config.json` values.
 */
export function decide(input: DecideInput, options: DecideOptions = {}): ClientMode {
  const settings = options.settings ?? settingsFromConfig();
  return planClientMode(input.sizeBytes, capabilityFrom(options) !== 'none', settings);
}

export function settingsFromConfig(): PlannerSettings {
  const cfg = getConfig();
  return { splitThresholdBytes: cfg.splitThresholdBytes, singleObjectLimitBytes: cfg.singleObjectLimitBytes };
}

/**
 * Save-target chooser for split downloads (design §5.4). The native `showSaveFilePicker` dialog cannot be
 * driven by automation, so the Playwright suite installs `window.__portalTest.pickFile` (via
 * `page.addInitScript`) which returns an OPFS `FileSystemFileHandle` instead. When the hook is absent the
 * behaviour is unchanged: the native picker, or an error where the File System Access API is missing.
 */
export async function pickSaveFile(
  suggestedName: string,
  win: Pick<Window, 'showSaveFilePicker' | '__portalTest'> | undefined = globalThis.window,
): Promise<FileSystemFileHandle> {
  const hook = win?.__portalTest?.pickFile;
  if (typeof hook === 'function') return hook(suggestedName);
  if (!win || typeof win.showSaveFilePicker !== 'function') {
    throw new Error('File System Access API is not available in this browser');
  }
  return win.showSaveFilePicker({ suggestedName });
}

export const planner = { decide, hasFileSystemAccess, splitCapability, settingsFromConfig, pickSaveFile };
