import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiEvents } from '../api/client';
import { SessionManager, type SessionDeps } from './session';

const MIN = 60_000;

function makeDeps(overrides: Partial<SessionDeps> = {}) {
  return {
    signOut: vi.fn(async () => undefined),
    pauseAllDownloads: vi.fn(async () => undefined),
    failZips: vi.fn(),
    onSessionExpired: vi.fn(),
    ...overrides,
  };
}

describe('auth/session (T3.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('signs out after 60 minutes without activity', async () => {
    const deps = makeDeps();
    const s = new SessionManager();
    s.start(deps);
    await vi.advanceTimersByTimeAsync(59 * MIN);
    expect(deps.signOut).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1 * MIN);
    expect(deps.signOut).toHaveBeenCalledTimes(1);
    expect(deps.onSessionExpired).toHaveBeenCalledWith('IDLE');
    expect(s.isRunning).toBe(false);
  });

  it('does not sign out during a download even after 65 minutes without input', async () => {
    const deps = makeDeps();
    const s = new SessionManager();
    s.start(deps);
    s.incrementActiveDownloads();
    await vi.advanceTimersByTimeAsync(65 * MIN);
    expect(deps.signOut).not.toHaveBeenCalled();
    expect(s.isRunning).toBe(true);
  });

  it('counts 60 minutes from the moment the last download finished', async () => {
    const deps = makeDeps();
    const s = new SessionManager();
    s.start(deps);
    s.incrementActiveDownloads();
    await vi.advanceTimersByTimeAsync(65 * MIN);
    s.decrementActiveDownloads(); // t = 65 min, lastActivity reset
    await vi.advanceTimersByTimeAsync(59 * MIN);
    expect(deps.signOut).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1 * MIN); // t = 125 min = 65 + 60
    expect(deps.signOut).toHaveBeenCalledTimes(1);
  });

  it('paused downloads do not count: two increments, two decrements → timer resumes', async () => {
    const deps = makeDeps();
    const s = new SessionManager();
    s.start(deps);
    s.incrementActiveDownloads();
    s.incrementActiveDownloads();
    s.decrementActiveDownloads();
    expect(s.activeDownloadCount).toBe(1);
    await vi.advanceTimersByTimeAsync(70 * MIN);
    expect(deps.signOut).not.toHaveBeenCalled();
    s.decrementActiveDownloads();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(deps.signOut).toHaveBeenCalledTimes(1);
  });

  it('user input and API calls refresh lastActivity', async () => {
    const deps = makeDeps();
    const s = new SessionManager();
    s.start(deps);
    await vi.advanceTimersByTimeAsync(40 * MIN);
    window.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(40 * MIN);
    expect(deps.signOut).not.toHaveBeenCalled();
    apiEvents.dispatchEvent(new Event('activity'));
    await vi.advanceTimersByTimeAsync(59 * MIN);
    expect(deps.signOut).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(deps.signOut).toHaveBeenCalledTimes(1);
  });

  it('AUTH_EXPIRED → pauseAll(AUTH_EXPIRED), zips failed, banner callback, Authenticator return', async () => {
    const deps = makeDeps();
    const s = new SessionManager();
    s.start(deps);
    s.incrementActiveDownloads();
    apiEvents.dispatchEvent(new Event('auth-expired'));
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.pauseAllDownloads).toHaveBeenCalledWith('AUTH_EXPIRED');
    expect(deps.failZips).toHaveBeenCalledTimes(1);
    expect(deps.signOut).toHaveBeenCalledTimes(1); // clears local tokens
    expect(deps.onSessionExpired).toHaveBeenCalledWith('AUTH_EXPIRED');
    expect(s.isRunning).toBe(false);
  });

  it('signedOut from another tab (Hub) pauses downloads and returns to login without calling signOut again', async () => {
    let fire: (() => void) | undefined;
    const deps = makeDeps({
      listenAuthHub: (onSignedOut) => {
        fire = onSignedOut;
        return () => undefined;
      },
    });
    const s = new SessionManager();
    s.start(deps);
    fire?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.pauseAllDownloads).toHaveBeenCalledWith('AUTH_EXPIRED');
    expect(deps.failZips).toHaveBeenCalled();
    expect(deps.signOut).not.toHaveBeenCalled();
    expect(deps.onSessionExpired).toHaveBeenCalledWith('SIGNED_OUT');
  });

  it('stop() removes listeners and the interval', async () => {
    const deps = makeDeps();
    const s = new SessionManager();
    s.start(deps);
    s.stop();
    await vi.advanceTimersByTimeAsync(120 * MIN);
    apiEvents.dispatchEvent(new Event('auth-expired'));
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.signOut).not.toHaveBeenCalled();
    expect(deps.pauseAllDownloads).not.toHaveBeenCalled();
  });
});
