import { planClientMode, type ClientMode, type RuntimeSettings } from '@genome-portal/contract';
import { getConfig } from '../config';

export type PlannerSettings = Pick<RuntimeSettings, 'splitThresholdBytes' | 'singleObjectLimitBytes'>;

/** File System Access API availability (design §5.4): Chrome/Edge true, Safari/Firefox false. */
export function hasFileSystemAccess(
  win: Pick<Window, 'showSaveFilePicker'> | undefined = globalThis.window,
): boolean {
  return !!win && 'showSaveFilePicker' in win && typeof win.showSaveFilePicker === 'function';
}

export interface DecideInput {
  sizeBytes: number;
}

export interface DecideOptions {
  hasFileSystemAccess?: boolean;
  settings?: PlannerSettings;
}

/**
 * Size × browser capability → `single | split | command` (§5.4 matrix). Thin wrapper around the
 * contract's `planClientMode` so that infra, the server hint and the SPA cannot drift apart.
 * Thresholds default to `config.json` values.
 */
export function decide(input: DecideInput, options: DecideOptions = {}): ClientMode {
  const settings = options.settings ?? settingsFromConfig();
  const fsAccess = options.hasFileSystemAccess ?? hasFileSystemAccess();
  return planClientMode(input.sizeBytes, fsAccess, settings);
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

export const planner = { decide, hasFileSystemAccess, settingsFromConfig, pickSaveFile };
