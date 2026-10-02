import { TEST, USER_A, makeEvent, parseResult } from './helpers/fixtures';
import { awsError, ddbMock, grantCredentials, resetAllMocks, s3ControlMock } from './helpers/mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { GetDataAccessCommand } from '@aws-sdk/client-s3-control';
import { resetOriginVerifyCache } from '../../../lambda/shared/originVerify';
import { BROWSE_CREDENTIALS_SECONDS, handler } from '../../../lambda/handlers/credentials';

const B = TEST.bucket;
const PREFIX = 'projects/P1/';
const SCOPE = `s3://${B}/${PREFIX}*`;

beforeEach(() => {
  resetAllMocks();
  resetOriginVerifyCache();
  ddbMock.on(PutCommand).resolves({});
  ddbMock
    .on(GetCommand, { Key: { pk: `ORG#${USER_A.orgId}`, sk: 'META' } })
    .resolves({ Item: { active: true } });
  ddbMock
    .on(GetCommand, { Key: { pk: `ORG#${USER_A.orgId}`, sk: `LOC#${B}/${PREFIX}` } })
    .resolves({ Item: { pk: 'x' } });
});

function auditEvents() {
  return ddbMock.commandCalls(PutCommand).map((c) => c.args[0].input.Item as Record<string, unknown>);
}

describe('POST /api/credentials', () => {
  it('happy path: READ prefix credentials for 3600 s with the browse AuditContext', async () => {
    const exp = new Date('2026-10-05T13:00:00.000Z');
    s3ControlMock.on(GetDataAccessCommand).resolves(grantCredentials(exp));
    const res = parseResult(await handler(makeEvent({ body: { scope: SCOPE, permission: 'READ' } })));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      credentials: {
        accessKeyId: 'ASIATESTKEY',
        secretAccessKey: 'testsecret',
        sessionToken: 'testsession',
        expiration: '2026-10-05T13:00:00.000Z',
      },
    });
    const input = s3ControlMock.commandCalls(GetDataAccessCommand)[0]?.args[0].input;
    expect(input).toMatchObject({
      Target: SCOPE,
      TargetType: undefined,
      Permission: 'READ',
      Privilege: 'Minimal',
      DurationSeconds: BROWSE_CREDENTIALS_SECONDS,
      AuditContext: `user=${USER_A.sub};org=${USER_A.orgId};kind=browse`,
    });
    expect(BROWSE_CREDENTIALS_SECONDS).toBe(3600);
    expect(auditEvents()).toHaveLength(0);
  });

  it('enforces READ (READWRITE -> 400, nothing else called)', async () => {
    const res = parseResult(await handler(makeEvent({ body: { scope: SCOPE, permission: 'READWRITE' } })));
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: 'BAD_REQUEST', reason: 'READ_ONLY' });
    expect(s3ControlMock.commandCalls(GetDataAccessCommand)).toHaveLength(0);
  });

  it.each([
    ['other bucket', 's3://another-bucket/projects/P1/*'],
    ['no trailing slash', `s3://${B}/projects/P1*`],
    ['dot-dot segment', `s3://${B}/projects/../P1/*`],
    ['empty segment', `s3://${B}/projects//P1/*`],
    ['star inside', `s3://${B}/pro*jects/P1/*`],
    ['bucket root', `s3://${B}/*`],
    ['not s3', `https://${B}/projects/P1/`],
  ])('rejects scope: %s -> 400 BAD_SCOPE with audit', async (_name, scope) => {
    const res = parseResult(await handler(makeEvent({ body: { scope, permission: 'READ' } })));
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: 'BAD_REQUEST', reason: 'BAD_SCOPE' });
    expect(auditEvents()[0]).toMatchObject({
      type: 'ACCESS_DENIED',
      reason: 'BAD_SCOPE',
      userSub: USER_A.sub,
    });
    expect(s3ControlMock.commandCalls(GetDataAccessCommand)).toHaveLength(0);
  });

  it('accepts a scope without the trailing *', async () => {
    s3ControlMock.on(GetDataAccessCommand).resolves(grantCredentials());
    const res = parseResult(
      await handler(makeEvent({ body: { scope: `s3://${B}/${PREFIX}`, permission: 'READ' } })),
    );
    expect(res.status).toBe(200);
    expect(s3ControlMock.commandCalls(GetDataAccessCommand)[0]?.args[0].input.Target).toBe(SCOPE);
  });

  it('inactive organisation -> 403 ORG_INACTIVE', async () => {
    ddbMock
      .on(GetCommand, { Key: { pk: `ORG#${USER_A.orgId}`, sk: 'META' } })
      .resolves({ Item: { active: false } });
    const res = parseResult(await handler(makeEvent({ body: { scope: SCOPE, permission: 'READ' } })));
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ reason: 'ORG_INACTIVE' });
  });

  it('unassigned location -> 403 NOT_ASSIGNED + audit, no GetDataAccess', async () => {
    const other = `s3://${B}/projects/P9/*`;
    ddbMock.on(GetCommand, { Key: { pk: `ORG#${USER_A.orgId}`, sk: `LOC#${B}/projects/P9/` } }).resolves({});
    const res = parseResult(await handler(makeEvent({ body: { scope: other, permission: 'READ' } })));
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ error: 'FORBIDDEN', reason: 'NOT_ASSIGNED' });
    expect(auditEvents()[0]).toMatchObject({
      type: 'ACCESS_DENIED',
      reason: 'NOT_ASSIGNED',
      bucket: B,
      key: 'projects/P9/',
      ip: '203.0.113.7',
      country: 'KR',
    });
    expect(s3ControlMock.commandCalls(GetDataAccessCommand)).toHaveLength(0);
  });

  it('grant missing -> 403 NO_GRANT + audit + GrantMissing metric', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    s3ControlMock.on(GetDataAccessCommand).rejects(awsError('AccessDenied', 403));
    const res = parseResult(await handler(makeEvent({ body: { scope: SCOPE, permission: 'READ' } })));
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ reason: 'NO_GRANT' });
    expect(auditEvents()[0]).toMatchObject({
      type: 'ACCESS_DENIED',
      reason: 'NO_GRANT',
      bucket: B,
      key: PREFIX,
    });
    expect(log.mock.calls.some((c) => String(c[0]).includes('GrantMissing'))).toBe(true);
    log.mockRestore();
  });

  it('throttled Access Grants -> 503', async () => {
    s3ControlMock.on(GetDataAccessCommand).rejects(awsError('SlowDown', 503));
    const res = parseResult(await handler(makeEvent({ body: { scope: SCOPE, permission: 'READ' } })));
    expect(res.status).toBe(503);
  }, 15_000);

  it('malformed body -> 400', async () => {
    expect(parseResult(await handler(makeEvent({ rawBody: 'nope' }))).status).toBe(400);
    expect(parseResult(await handler(makeEvent({ body: { scope: SCOPE } }))).status).toBe(400);
  });

  it('origin verification failure -> 403 before reading the body', async () => {
    const res = parseResult(await handler(makeEvent({ withOrigin: false, rawBody: 'nope' })));
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ reason: 'ORIGIN_VERIFY_FAILED' });
  });
});
