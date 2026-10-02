import { TEST, USER_A, USER_B, makeEvent, parseResult } from './helpers/fixtures';
import { awsError, ddbMock, grantCredentials, resetAllMocks, s3ControlMock } from './helpers/mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetDataAccessCommand } from '@aws-sdk/client-s3-control';
import { resetOriginVerifyCache } from '../../../lambda/shared/originVerify';
import { resetSettingsCache } from '../../../lambda/shared/config';
import { resetSigningKeyCache } from '../../../lambda/shared/signing';
import { handler } from '../../../lambda/handlers/renew';

const B = TEST.bucket;
const KEY = 'projects/P1/sample02.bam';
const DL = 'dl-0001';

function meta(path: 'S3' | 'CF', userSub: string = USER_A.sub) {
  return {
    pk: `DL#${DL}`,
    sk: 'META',
    userSub,
    orgId: USER_A.orgId,
    bucket: B,
    key: KEY,
    path,
    issuedAt: '2026-10-05T12:00:00.000Z',
    renewCount: 2,
  };
}

beforeEach(() => {
  resetAllMocks({ urlTtlSeconds: '3600' });
  resetOriginVerifyCache();
  resetSettingsCache();
  resetSigningKeyCache();
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({ Attributes: { renewCount: 3 } });
  s3ControlMock.on(GetDataAccessCommand).resolves(grantCredentials(new Date('2026-10-05T14:00:00.000Z')));
});

const call = (claims = USER_A, id: string | null = DL) =>
  handler(
    makeEvent({
      path: `/api/downloads/${id ?? ''}/renew`,
      pathParameters: id ? { id } : undefined,
      claims,
      body: {},
    }),
  ).then(parseResult);

function auditEvents() {
  return ddbMock.commandCalls(PutCommand).map((c) => c.args[0].input.Item as Record<string, unknown>);
}

describe('POST /api/downloads/{id}/renew', () => {
  it('S3 download stays on S3: GetDataAccess again, presign, renewCount+1, URL_RENEWED, no count change', async () => {
    ddbMock.on(GetCommand).resolves({ Item: meta('S3') });
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      downloadId: DL,
      path: 'S3',
      expiresAt: '2026-10-05T14:00:00.000Z',
      renewCount: 3,
    });
    expect(new URL(String(res.json?.['url'])).hostname).toBe(`${B}.s3.${TEST.region}.amazonaws.com`);
    const gda = s3ControlMock.commandCalls(GetDataAccessCommand)[0]?.args[0].input;
    expect(gda).toMatchObject({
      Target: `s3://${B}/${KEY}`,
      TargetType: 'Object',
      DurationSeconds: 3600,
      AuditContext: `user=${USER_A.sub};org=${USER_A.orgId};dl=${DL}`,
    });
    // the only UpdateCommand is the renewCount increment on the DL# meta, never the OBJ# counter
    const updates = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.TableName).toBe(TEST.auditTable);
    expect(updates[0]?.Key).toEqual({ pk: `DL#${DL}`, sk: 'META' });
    expect(updates[0]?.UpdateExpression).toContain('ADD renewCount :one');
    expect(auditEvents().find((e) => e['type'] === 'URL_RENEWED')).toMatchObject({
      downloadId: DL,
      path: 'S3',
      bucket: B,
      key: KEY,
      userSub: USER_A.sub,
      detail: { renewCount: 3 },
    });
  });

  it('CF download stays on CF: fresh signature, no GetDataAccess', async () => {
    ddbMock.on(GetCommand).resolves({ Item: meta('CF') });
    const before = Date.now();
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ path: 'CF', renewCount: 3 });
    const url = new URL(String(res.json?.['url']));
    expect(url.origin).toBe(`https://${TEST.cfDomain}`);
    expect(url.searchParams.get('Key-Pair-Id')).toBe(TEST.keyPairId);
    expect(new Date(String(res.json?.['expiresAt'])).getTime()).toBeGreaterThanOrEqual(before + 3600_000 - 5);
    expect(s3ControlMock.commandCalls(GetDataAccessCommand)).toHaveLength(0);
  });

  it('unknown download -> 404', async () => {
    ddbMock.on(GetCommand).resolves({});
    const res = await call();
    expect(res.status).toBe(404);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('another user -> 403 NOT_OWNER + audit', async () => {
    ddbMock.on(GetCommand).resolves({ Item: meta('CF') });
    const res = await call({ ...USER_B });
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ error: 'FORBIDDEN', reason: 'NOT_OWNER' });
    expect(auditEvents()[0]).toMatchObject({
      type: 'ACCESS_DENIED',
      reason: 'NOT_OWNER',
      userSub: USER_B.sub,
      downloadId: DL,
    });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('grant vanished since issue -> 403 NO_GRANT', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    ddbMock.on(GetCommand).resolves({ Item: meta('S3') });
    s3ControlMock.on(GetDataAccessCommand).rejects(awsError('AccessDenied', 403));
    const res = await call();
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ reason: 'NO_GRANT' });
    vi.restoreAllMocks();
  });

  it('missing id -> 400; corrupt meta -> 404; garbage body -> 400', async () => {
    expect((await call(USER_A, null)).status).toBe(400);
    ddbMock.on(GetCommand).resolves({ Item: { pk: `DL#${DL}`, sk: 'META', path: 'weird' } });
    expect((await call()).status).toBe(404);
    ddbMock.on(GetCommand).resolves({ Item: meta('CF') });
    const bad = parseResult(await handler(makeEvent({ pathParameters: { id: DL }, rawBody: '{{' })));
    expect(bad.status).toBe(400);
  });

  it('works without a body', async () => {
    ddbMock.on(GetCommand).resolves({ Item: meta('CF') });
    const res = parseResult(await handler(makeEvent({ pathParameters: { id: DL } })));
    expect(res.status).toBe(200);
  });
});
