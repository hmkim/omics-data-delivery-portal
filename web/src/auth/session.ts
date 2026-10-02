import { IDLE_TIMEOUT_MS } from '@genome-portal/contract';
import { apiEvents } from '../api/client';

/**
 * Session keeper (design §5.6, R1.5/R1.6).
 * - `lastActivity` is refreshed by pointerdown / keydown / visibilitychange→visible / every API call.
 * - Every `checkIntervalMs` (1 min) the idle check runs: idle ≥ 60 min AND no active download → `signOut()`.
 * - `activeDownloads` is raised by the split engine (running parts) and zip streams; while > 0 the check is
 *   skipped, and when it returns to 0 `lastActivity` is reset so the 60 minutes restart from the last download.
 * - `AUTH_EXPIRED` (refresh token gone): pause split downloads (not fail), fail zips, show the banner, go back
 *   to the Authenticator. A `signedOut` Hub event from another tab takes the same path.
 */
export interface SessionDeps {
  signOut: () => Promise<void>;
  pauseAllDownloads: (reason: 'AUTH_EXPIRED') => Promise<void>;
  failZips: () => void;
  onSessionExpired: (cause: 'AUTH_EXPIRED' | 'SIGNED_OUT' | 'IDLE') => void;
  now?: () => number;
  idleTimeoutMs?: number;
  checkIntervalMs?: number;
  /** subscribe to Amplify Hub `auth` events; returns an unsubscribe. Defaults to `Hub.listen`. */
  listenAuthHub?: (onSignedOut: () => void) => () => void;
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
}

export class SessionManager {
  private deps: SessionDeps | undefined;
  private lastActivity = 0;
  private activeDownloads = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private cleanups: Array<() => void> = [];
  private expiring = false;
  private readonly listeners = new Set<() => void>();

  get isRunning(): boolean {
    return this.deps !== undefined;
  }

  get activeDownloadCount(): number {
    return this.activeDownloads;
  }

  get lastActivityAt(): number {
    return this.lastActivity;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start watching. Call once after sign-in; `stop()` on sign-out. */
  start(deps: SessionDeps): void {
    this.stop();
    this.deps = deps;
    this.expiring = false;
    this.lastActivity = this.now();
    const target = deps.target ?? window;
    const doc = deps.doc ?? document;

    const touch = () => this.touch();
    const onVisibility = () => {
      if (doc.visibilityState === 'visible') this.touch();
    };
    const onAuthExpired = () => void this.handleAuthExpired();
    target.addEventListener('pointerdown', touch, { passive: true });
    target.addEventListener('keydown', touch, { passive: true });
    doc.addEventListener('visibilitychange', onVisibility);
    apiEvents.addEventListener('activity', touch);
    apiEvents.addEventListener('auth-expired', onAuthExpired);
    this.cleanups.push(
      () => target.removeEventListener('pointerdown', touch),
      () => target.removeEventListener('keydown', touch),
      () => doc.removeEventListener('visibilitychange', onVisibility),
      () => apiEvents.removeEventListener('activity', touch),
      () => apiEvents.removeEventListener('auth-expired', onAuthExpired),
    );
    if (deps.listenAuthHub) {
      this.cleanups.push(deps.listenAuthHub(() => void this.handleSignedOutElsewhere()));
    }
    this.timer = setInterval(() => void this.check(), deps.checkIntervalMs ?? 60_000);
    this.emit();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const c of this.cleanups) c();
    this.cleanups = [];
    this.deps = undefined;
    this.emit();
  }

  touch(): void {
    this.lastActivity = this.now();
  }

  incrementActiveDownloads(): void {
    this.activeDownloads += 1;
    this.emit();
  }

  decrementActiveDownloads(): void {
    this.activeDownloads = Math.max(0, this.activeDownloads - 1);
    if (this.activeDownloads === 0) {
      // "60 minutes from the moment the last download finished"
      this.lastActivity = this.now();
    }
    this.emit();
  }

  /** Idle check; exposed for tests. */
  async check(): Promise<void> {
    if (!this.deps || this.expiring) return;
    if (this.activeDownloads > 0) return;
    const idleMs = this.now() - this.lastActivity;
    if (idleMs >= (this.deps.idleTimeoutMs ?? IDLE_TIMEOUT_MS)) {
      this.expiring = true;
      const deps = this.deps;
      try {
        await deps.signOut();
      } finally {
        deps.onSessionExpired('IDLE');
        this.stop();
      }
    }
  }

  /** Refresh token no longer works: keep downloads resumable, fail zips, return to login (R1.5). */
  async handleAuthExpired(): Promise<void> {
    if (!this.deps || this.expiring) return;
    this.expiring = true;
    const deps = this.deps;
    try {
      await deps.pauseAllDownloads('AUTH_EXPIRED');
      deps.failZips();
      try {
        await deps.signOut(); // clears local tokens so the Authenticator shows the login form
      } catch {
        // the refresh token is already invalid; local state is cleared regardless
      }
    } finally {
      deps.onSessionExpired('AUTH_EXPIRED');
      this.stop();
    }
  }

  private async handleSignedOutElsewhere(): Promise<void> {
    if (!this.deps || this.expiring) return;
    this.expiring = true;
    const deps = this.deps;
    try {
      await deps.pauseAllDownloads('AUTH_EXPIRED');
      deps.failZips();
    } finally {
      deps.onSessionExpired('SIGNED_OUT');
      this.stop();
    }
  }

  private now(): number {
    return this.deps?.now?.() ?? Date.now();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

export const session = new SessionManager();
