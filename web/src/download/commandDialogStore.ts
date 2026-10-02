import type { DownloadResponse } from '@genome-portal/contract';

/**
 * State for `<CommandDialog/>` (R5.6): the currently displayed command-fallback download, if any.
 */
export interface CommandDialogState {
  issued: DownloadResponse;
  bucket: string;
  key: string;
}

let state: CommandDialogState | null = null;
const listeners = new Set<() => void>();

export function openCommandDialog(next: CommandDialogState): void {
  state = next;
  emit();
}

export function updateCommandDialog(patch: Partial<DownloadResponse>): void {
  if (!state) return;
  state = { ...state, issued: { ...state.issued, ...patch } };
  emit();
}

export function closeCommandDialog(): void {
  state = null;
  emit();
}

export function getCommandDialogState(): CommandDialogState | null {
  return state;
}

export function subscribeCommandDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const l of listeners) l();
}
