import './helpers/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  HttpError,
  badRequest,
  conflict,
  forbidden,
  jsonResponse,
  notFound,
  parseBody,
  respond,
  toResponse,
  unauthorized,
  unavailable,
} from '../../../lambda/shared/errors';

describe('errors -> HTTP mapping', () => {
  it('every response carries application/json and no-store', () => {
    const r = jsonResponse(200, { ok: true });
    expect(r.headers).toEqual({ 'content-type': 'application/json', 'cache-control': 'no-store' });
    expect(JSON.parse(r.body ?? '')).toEqual({ ok: true });
  });

  it.each([
    [badRequest('x'), 400, 'BAD_REQUEST'],
    [unauthorized(), 401, 'UNAUTHORIZED'],
    [forbidden('NOT_ADMIN'), 403, 'FORBIDDEN'],
    [notFound(), 404, 'NOT_FOUND'],
    [conflict('dup'), 409, 'CONFLICT'],
    [unavailable(), 503, 'UNAVAILABLE'],
  ])('maps %s to %i %s', (err, status, code) => {
    const r = toResponse(err);
    expect(r.statusCode).toBe(status);
    expect(JSON.parse(r.body ?? '')).toMatchObject({ error: code });
  });

  it('forbidden carries the reason and a default message', () => {
    const err = forbidden('NOT_OWNER');
    expect(err.body).toEqual({ error: 'FORBIDDEN', reason: 'NOT_OWNER', message: 'Forbidden: NOT_OWNER' });
    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).toBe('Forbidden: NOT_OWNER');
  });

  it('badRequest attaches an optional reason', () => {
    expect(badRequest('m', 'BAD_SCOPE').body).toEqual({
      error: 'BAD_REQUEST',
      message: 'm',
      reason: 'BAD_SCOPE',
    });
    expect(badRequest('m').body).toEqual({ error: 'BAD_REQUEST', message: 'm' });
  });

  it('unknown errors become 500 INTERNAL without leaking the message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = toResponse(new Error('db exploded with secret details'));
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('secret details');
    expect(JSON.parse(r.body ?? '')).toEqual({ error: 'INTERNAL', message: 'Internal error' });
    expect(spy).toHaveBeenCalledOnce();
    const r2 = toResponse('a string');
    expect(r2.statusCode).toBe(500);
    spy.mockRestore();
  });

  it('respond() wraps success and failure', async () => {
    const ok = await respond(async () => ({ body: { a: 1 } }));
    expect(ok.statusCode).toBe(200);
    const created = await respond(async () => ({ status: 201, body: {} }));
    expect(created.statusCode).toBe(201);
    const fail = await respond(async () => {
      throw notFound('nope');
    });
    expect(fail.statusCode).toBe(404);
    expect(fail.headers?.['cache-control']).toBe('no-store');
  });
});

describe('parseBody', () => {
  const schema = z.object({ n: z.number().int().min(1) });

  it('parses valid JSON', () => {
    expect(parseBody({ body: '{"n":3}', isBase64Encoded: false }, schema)).toEqual({ n: 3 });
  });

  it('decodes base64 bodies', () => {
    const b64 = Buffer.from('{"n":7}').toString('base64');
    expect(parseBody({ body: b64, isBase64Encoded: true }, schema)).toEqual({ n: 7 });
  });

  it('rejects missing, malformed and invalid bodies with 400', () => {
    expect(() => parseBody({ body: undefined, isBase64Encoded: false }, schema)).toThrow(HttpError);
    expect(() => parseBody({ body: '', isBase64Encoded: false }, schema)).toThrow(/required/);
    expect(() => parseBody({ body: '{oops', isBase64Encoded: false }, schema)).toThrow(/valid JSON/);
    try {
      parseBody({ body: '{"n":0}', isBase64Encoded: false }, schema);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(400);
      expect((err as HttpError).body.message).toMatch(/^Invalid request body: n: /);
    }
  });
});
