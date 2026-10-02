import { describe, expect, it, vi } from 'vitest';
import type { AdminAuditExportResponse, ApiError, AuditEvent } from '@genome-portal/contract';
import { ROUTES } from '@genome-portal/contract';
import { AdminApiClient, AdminApiError, formatApiError } from '../src/api.js';

const PORTAL = 'https://portal.example.test';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeClient(
  fetchImpl: ReturnType<typeof vi.fn>,
  extra: Partial<ConstructorParameters<typeof AdminApiClient>[0]> = {},
) {
  return new AdminApiClient({
    portalUrl: PORTAL + '/', // trailing slash must be tolerated
    getIdToken: async () => 'id-token-123',
    fetchImpl: fetchImpl as unknown as (input: string, init: RequestInit) => Promise<Response>,
    retries: 2,
    retryBaseMs: 1,
    sleep: async () => undefined,
    ...extra,
  });
}

describe('AdminApiClient.post', () => {
  it('sends a bearer token, JSON body and the contract route', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const api = makeClient(fetchImpl);
    const res = await api.org({ action: 'create', orgId: 'KU-lab', name: 'KU lab' });
    expect(res).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PORTAL}${ROUTES.adminOrgs}`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer id-token-123');
    expect(JSON.parse(init.body as string)).toEqual({ action: 'create', orgId: 'KU-lab', name: 'KU lab' });
  });

  it('maps a 403 ApiError body to a readable AdminApiError', async () => {
    const body: ApiError = { error: 'FORBIDDEN', reason: 'NOT_ADMIN', message: 'not in admins group' };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, body));
    const api = makeClient(fetchImpl);
    const err = await api.user({ action: 'disable', email: 'x@example.test' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminApiError);
    const e = err as AdminApiError;
    expect(e.status).toBe(403);
    expect(e.body).toEqual(body);
    expect(e.message).toContain('HTTP 403 FORBIDDEN');
    expect(e.message).toContain('reason=NOT_ADMIN');
    expect(e.message).toContain('not in admins group');
    expect(e.message).toContain('admins');
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 4xx is not retried
  });

  it('retries 5xx then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('oops', { status: 502 }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [] }));
    const api = makeClient(fetchImpl);
    const res = await api.locationList();
    expect(res).toEqual({ items: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after the configured retries on persistent 5xx', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(503, { error: 'UNAVAILABLE' }));
    const api = makeClient(fetchImpl);
    await expect(api.resetCount({ bucket: 'b', key: 'k' })).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries network errors and reports them when exhausted', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const api = makeClient(fetchImpl);
    await expect(api.locationList('org')).rejects.toThrow(/network error .*ECONNRESET/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('locationList omits orgId when not given', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(200, { items: [] }));
    const api = makeClient(fetchImpl);
    await api.locationList();
    await api.locationList('KU-lab');
    const first = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    const second = JSON.parse((fetchImpl.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(first).toEqual({ action: 'list' });
    expect(second).toEqual({ action: 'list', orgId: 'KU-lab' });
  });
});

describe('formatApiError', () => {
  it('handles a missing body', () => {
    expect(formatApiError(500, undefined, '/api/admin/orgs')).toBe(
      'HTTP 500 from /api/admin/orgs (server error)',
    );
  });
  it('adds a sign-in hint on 401', () => {
    expect(formatApiError(401, { error: 'UNAUTHORIZED' }, '/x')).toContain('sign in again');
  });
});

describe('auditEventsForDay pagination', () => {
  const ev = (i: number): AuditEvent => ({
    type: 'URL_RENEWED',
    at: `2026-10-01T00:00:0${i}.000Z`,
    downloadId: `dl-${i}`,
  });

  it('follows nextToken across pages and stops when it is absent', async () => {
    const pages: AdminAuditExportResponse[] = [
      { items: [ev(1), ev(2)], nextToken: 't1' },
      { items: [ev(3)], nextToken: 't2' },
      { items: [ev(4)] },
    ];
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { day: string; nextToken?: string };
      expect(body.day).toBe('2026-10-01');
      const idx = body.nextToken === undefined ? 0 : body.nextToken === 't1' ? 1 : 2;
      return jsonResponse(200, pages[idx]);
    });
    const api = makeClient(fetchImpl);
    const got: AuditEvent[] = [];
    for await (const e of api.auditEventsForDay('2026-10-01')) got.push(e);
    expect(got.map((e) => e.downloadId)).toEqual(['dl-1', 'dl-2', 'dl-3', 'dl-4']);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const bodies = fetchImpl.mock.calls.map((c) =>
      JSON.parse((c as [string, RequestInit])[1].body as string),
    );
    expect(bodies).toEqual([
      { day: '2026-10-01' },
      { day: '2026-10-01', nextToken: 't1' },
      { day: '2026-10-01', nextToken: 't2' },
    ]);
  });

  it('handles an empty day', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { items: [] }));
    const api = makeClient(fetchImpl);
    const got: AuditEvent[] = [];
    for await (const e of api.auditEventsForDay('2026-10-02')) got.push(e);
    expect(got).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('aborts when the server repeats the same nextToken', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => jsonResponse(200, { items: [ev(1)], nextToken: 'same' }));
    const api = makeClient(fetchImpl);
    const iter = api.auditEventsForDay('2026-10-03');
    await expect(async () => {
      for await (const _e of iter) {
        // drain
      }
    }).rejects.toThrow(/same nextToken twice/);
  });
});
