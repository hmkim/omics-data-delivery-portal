import { ROUTES } from '@genome-portal/contract';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError, AuthExpiredError, createApiClient, resolveUrl } from './client';

type Session = { tokens?: { idToken?: { toString(): string } } };
type FetchFn = (u: RequestInfo | URL, i?: RequestInit) => Promise<Response>;
const sessionWith = (token: string | undefined): Session =>
  token ? { tokens: { idToken: { toString: () => token } } } : {};

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('api/client (T3.3)', () => {
  it('sends Authorization: Bearer <idToken> on every call', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse(200, { items: [] }));
    const getSession = vi.fn(async () => sessionWith('tok-1'));
    const api = createApiClient({ fetchFn, getSession, sleep: async () => undefined });
    await api.listLocations();
    expect(getSession).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ROUTES.locations);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
  });

  it('on 401 forces one refresh and retries once', async () => {
    const fetchFn = vi
      .fn<(u: RequestInfo | URL, i?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'UNAUTHORIZED' }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [] }));
    const getSession = vi
      .fn<(o?: { forceRefresh?: boolean }) => Promise<Session>>()
      .mockResolvedValueOnce(sessionWith('expired'))
      .mockResolvedValueOnce(sessionWith('fresh'));
    const api = createApiClient({ fetchFn, getSession, sleep: async () => undefined });
    await api.listLocations();
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(getSession.mock.calls[1]?.[0]).toEqual({ forceRefresh: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const second = fetchFn.mock.calls[1]?.[1] as RequestInit;
    expect((second.headers as Record<string, string>).Authorization).toBe('Bearer fresh');
  });

  it('throws AuthExpiredError when the refreshed token is rejected again', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(401));
    const getSession = vi.fn(async () => sessionWith('t'));
    const api = createApiClient({ fetchFn, getSession, sleep: async () => undefined });
    await expect(api.listLocations()).rejects.toBeInstanceOf(AuthExpiredError);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws AuthExpiredError when fetchAuthSession rejects (refresh token gone) or has no token', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, {}));
    const failing = createApiClient({
      fetchFn,
      getSession: async () => {
        throw new Error('NotAuthorizedException');
      },
    });
    await expect(failing.listLocations()).rejects.toBeInstanceOf(AuthExpiredError);
    const empty = createApiClient({ fetchFn, getSession: async () => ({}) });
    await expect(empty.listLocations()).rejects.toBeInstanceOf(AuthExpiredError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('retries 5xx twice with exponential backoff then succeeds', async () => {
    const fetchFn = vi
      .fn<(u: RequestInfo | URL, i?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(503))
      .mockResolvedValueOnce(jsonResponse(500))
      .mockResolvedValueOnce(jsonResponse(200, { items: [] }));
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
    const api = createApiClient({
      fetchFn,
      getSession: async () => sessionWith('t'),
      sleep,
      backoffBaseMs: 100,
    });
    await api.listLocations();
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });

  it('gives up after 2 retries on persistent 5xx with ApiRequestError', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(502, { error: 'UNAVAILABLE', message: 'upstream' }));
    const api = createApiClient({
      fetchFn,
      getSession: async () => sessionWith('t'),
      sleep: async () => undefined,
    });
    const err = await api.listLocations().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).status).toBe(502);
    expect((err as ApiRequestError).body?.error).toBe('UNAVAILABLE');
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('retries network errors (TypeError) and does not retry 4xx', async () => {
    const fetchFn = vi
      .fn<(u: RequestInfo | URL, i?: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse(403, { error: 'FORBIDDEN', reason: 'NOT_ASSIGNED' }));
    const api = createApiClient({
      fetchFn,
      getSession: async () => sessionWith('t'),
      sleep: async () => undefined,
    });
    const err = await api.issueDownload({ bucket: 'b', key: 'k' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).status).toBe(403);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('converts credentials.expiration ISO → Date', async () => {
    const iso = '2026-09-28T12:00:00.000Z';
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse(200, {
        credentials: { accessKeyId: 'A', secretAccessKey: 'S', sessionToken: 'T', expiration: iso },
      }),
    );
    const api = createApiClient({ fetchFn, getSession: async () => sessionWith('t') });
    const res = await api.getCredentials({ scope: 's3://b/p/*', permission: 'READ' });
    expect(res.credentials.expiration).toBeInstanceOf(Date);
    expect(res.credentials.expiration.toISOString()).toBe(iso);
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ scope: 's3://b/p/*', permission: 'READ' });
  });

  it('renew route encodes the download id', async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse(200, { downloadId: 'a/b', url: 'u', path: 'CF', expiresAt: 'x', renewCount: 1 }),
    );
    const api = createApiClient({ fetchFn, getSession: async () => sessionWith('t') });
    await api.renewDownload('a/b');
    expect(fetchFn.mock.calls[0]?.[0]).toBe('/api/downloads/a%2Fb/renew');
  });

  it('resolveUrl keeps contract routes as-is when apiBase is /api', () => {
    expect(resolveUrl(ROUTES.downloads)).toBe('/api/downloads');
  });
});
