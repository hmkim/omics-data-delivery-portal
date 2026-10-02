import { TEST } from './helpers/fixtures';
import { awsError, grantCredentials, resetAllMocks, s3ControlMock } from './helpers/mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetDataAccessCommand } from '@aws-sdk/client-s3-control';
import {
  browseAuditContext,
  downloadAuditContext,
  getDataAccess,
  isAccessDenied,
  isThrottle,
} from '../../../lambda/shared/accessGrants';
import { HttpError } from '../../../lambda/shared/errors';

beforeEach(() => resetAllMocks());

const NO_DELAY = [0, 0] as const;

describe('AuditContext format', () => {
  it('browse and download contexts match design §2.4 / §4', () => {
    expect(browseAuditContext('sub-1', 'org-a')).toBe('user=sub-1;org=org-a;kind=browse');
    expect(downloadAuditContext('sub-1', 'org-a', 'dl-9')).toBe('user=sub-1;org=org-a;dl=dl-9');
  });
});

describe('getDataAccess', () => {
  it('sends READ / Minimal / AccountId and maps the credentials', async () => {
    const exp = new Date('2026-10-05T13:00:00Z');
    s3ControlMock.on(GetDataAccessCommand).resolves(grantCredentials(exp, 's3://b/projects/P1/*'));
    const creds = await getDataAccess({
      target: `s3://${TEST.bucket}/projects/P1/*`,
      durationSeconds: 3600,
      auditContext: 'user=u;org=o;kind=browse',
    });
    expect(creds).toEqual({
      accessKeyId: 'ASIATESTKEY',
      secretAccessKey: 'testsecret',
      sessionToken: 'testsession',
      expiration: exp,
      matchedGrantTarget: 's3://b/projects/P1/*',
    });
    const input = s3ControlMock.commandCalls(GetDataAccessCommand)[0]?.args[0].input;
    expect(input).toEqual({
      AccountId: TEST.accountId,
      Target: `s3://${TEST.bucket}/projects/P1/*`,
      TargetType: undefined,
      Permission: 'READ',
      Privilege: 'Minimal',
      DurationSeconds: 3600,
      AuditContext: 'user=u;org=o;kind=browse',
    });
  });

  it('sets TargetType Object only for single objects', async () => {
    s3ControlMock.on(GetDataAccessCommand).resolves(grantCredentials());
    await getDataAccess({
      target: 's3://b/k',
      targetType: 'Object',
      durationSeconds: 900,
      auditContext: 'x',
    });
    expect(s3ControlMock.commandCalls(GetDataAccessCommand)[0]?.args[0].input.TargetType).toBe('Object');
  });

  it('AccessDenied -> 403 NO_GRANT + GrantMissing metric, no retry', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    s3ControlMock.on(GetDataAccessCommand).rejects(awsError('AccessDenied', 403));
    await expect(
      getDataAccess({ target: 's3://b/k', durationSeconds: 900, auditContext: 'x', retryDelaysMs: NO_DELAY }),
    ).rejects.toMatchObject({
      status: 403,
      body: { error: 'FORBIDDEN', reason: 'NO_GRANT' },
    });
    expect(s3ControlMock.commandCalls(GetDataAccessCommand)).toHaveLength(1);
    expect(log.mock.calls.some((c) => String(c[0]).includes('GrantMissing'))).toBe(true);
    log.mockRestore();
  });

  it('retries SlowDown twice with backoff then succeeds', async () => {
    s3ControlMock
      .on(GetDataAccessCommand)
      .rejectsOnce(awsError('SlowDown', 503))
      .rejectsOnce(awsError('Throttling', 429))
      .resolves(grantCredentials());
    const creds = await getDataAccess({
      target: 's3://b/k',
      durationSeconds: 900,
      auditContext: 'x',
      retryDelaysMs: NO_DELAY,
    });
    expect(creds.accessKeyId).toBe('ASIATESTKEY');
    expect(s3ControlMock.commandCalls(GetDataAccessCommand)).toHaveLength(3);
  });

  it('gives up after two retries with 503 UNAVAILABLE', async () => {
    s3ControlMock.on(GetDataAccessCommand).rejects(awsError('SlowDown', 503));
    await expect(
      getDataAccess({ target: 's3://b/k', durationSeconds: 900, auditContext: 'x', retryDelaysMs: NO_DELAY }),
    ).rejects.toMatchObject({
      status: 503,
      body: { error: 'UNAVAILABLE' },
    });
    expect(s3ControlMock.commandCalls(GetDataAccessCommand)).toHaveLength(3);
  });

  it('propagates other errors untouched', async () => {
    s3ControlMock.on(GetDataAccessCommand).rejects(awsError('InternalError', 500));
    await expect(
      getDataAccess({ target: 's3://b/k', durationSeconds: 900, auditContext: 'x' }),
    ).rejects.toThrow('InternalError');
  });

  it('rejects incomplete credentials', async () => {
    s3ControlMock.on(GetDataAccessCommand).resolves({ Credentials: { AccessKeyId: 'a' } });
    await expect(
      getDataAccess({ target: 's3://b/k', durationSeconds: 900, auditContext: 'x' }),
    ).rejects.toThrow(/incomplete credentials/);
  });

  it('classifiers', () => {
    expect(isThrottle(awsError('TooManyRequestsException'))).toBe(true);
    expect(isThrottle(awsError('Whatever', 429))).toBe(true);
    expect(isThrottle(awsError('Whatever', 500))).toBe(false);
    expect(isThrottle(null)).toBe(false);
    expect(isAccessDenied(awsError('AccessDeniedException'))).toBe(true);
    expect(isAccessDenied(awsError('Other', 403))).toBe(true);
    expect(isAccessDenied({ Code: 'AccessDenied' })).toBe(true);
    expect(isAccessDenied(new HttpError(500, { error: 'x' }))).toBe(false);
  });
});
