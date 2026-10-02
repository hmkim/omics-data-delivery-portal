/**
 * Minimal notification bus: toasts (auto-dismiss) and a single sticky banner.
 * Non-React modules (download handler, session manager) push messages; `<Notifications/>` renders them.
 */
export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface NotifyState {
  toasts: Toast[];
  banner: { kind: ToastKind; message: string } | null;
}

type Listener = (state: NotifyState) => void;

let state: NotifyState = { toasts: [], banner: null };
const listeners = new Set<Listener>();
let nextId = 1;

function emit() {
  for (const l of listeners) l(state);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNotifyState(): NotifyState {
  return state;
}

export function toast(message: string, kind: ToastKind = 'info', ttlMs = 6000): void {
  const id = nextId++;
  state = { ...state, toasts: [...state.toasts, { id, kind, message }] };
  emit();
  if (ttlMs > 0) {
    setTimeout(() => dismissToast(id), ttlMs);
  }
}

export function dismissToast(id: number): void {
  if (!state.toasts.some((t) => t.id === id)) return;
  state = { ...state, toasts: state.toasts.filter((t) => t.id !== id) };
  emit();
}

export function showBanner(message: string, kind: ToastKind = 'warning'): void {
  state = { ...state, banner: { kind, message } };
  emit();
}

export function clearBanner(): void {
  if (!state.banner) return;
  state = { ...state, banner: null };
  emit();
}

/** test helper */
export function resetNotifications(): void {
  state = { toasts: [], banner: null };
  emit();
}
