import { TEST, USER_A, makeEvent, parseResult } from './helpers/fixtures';
import { ddbMock, resetAllMocks } from './helpers/mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { resetOriginVerifyCache } from '../../../lambda/shared/originVerify';
import { handler } from '../../../lambda/handlers/locations';

beforeEach(() => {
  resetAllMocks();
  resetOriginVerifyCache();
  ddbMock.on(PutCommand).resolves({});
});

const B = TEST.bucket;

function orgActive(active: boolean) {
  ddbMock.on(GetCommand, { Key: { pk: `ORG#${USER_A.orgId}`, sk: 'META' } }).resolves({ Item: { active } });
}

describe('GET /api/locations', () => {
  it('returns the organisation locations in Storage Browser shape', async () => {
    orgActive(true);
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { pk: 'ORG#org-a', sk: `LOC#${B}/projects/P1/`, bucket: B, prefix: 'projects/P1/' },
        { pk: 'ORG#org-a', sk: `LOC#${B}/projects/P2/`, bucket: B, prefix: 'projects/P2/', label: 'two' },
      ],
    });
    const res = parseResult(await handler(makeEvent({ method: 'GET', path: '/api/locations' })));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json).toEqual({
      items: [
        {
          id: `${B}/projects/P1/`,
          bucket: B,
          prefix: 'projects/P1/',
          type: 'PREFIX',
          permissions: ['get', 'list'],
        },
        {
          id: `${B}/projects/P2/`,
          bucket: B,
          prefix: 'projects/P2/',
          type: 'PREFIX',
          permissions: ['get', 'list'],
        },
      ],
    });
  });

  it('empty organisation -> empty list', async () => {
    orgActive(true);
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const res = parseResult(await handler(makeEvent({ method: 'GET' })));
    expect(res.json).toEqual({ items: [] });
  });

  it('inactive organisation -> 403 ORG_INACTIVE and an audit event', async () => {
    orgActive(false);
    const res = parseResult(await handler(makeEvent({ method: 'GET' })));
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ error: 'FORBIDDEN', reason: 'ORG_INACTIVE' });
    const audit = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(audit).toMatchObject({
      type: 'ACCESS_DENIED',
      reason: 'ORG_INACTIVE',
      userSub: USER_A.sub,
      orgId: USER_A.orgId,
      ip: '203.0.113.7',
      country: 'KR',
    });
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('missing x-origin-verify -> 403 before any table read', async () => {
    const res = parseResult(await handler(makeEvent({ method: 'GET', withOrigin: false })));
    expect(res.status).toBe(403);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('no JWT -> 401; no orgId -> 403', async () => {
    expect(parseResult(await handler(makeEvent({ method: 'GET', claims: null }))).status).toBe(401);
    expect(parseResult(await handler(makeEvent({ method: 'GET', claims: { sub: 'x' } }))).status).toBe(403);
  });
});
