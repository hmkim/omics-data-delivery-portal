import { TEST, USER_A, makeEvent, parseResult } from './helpers/fixtures';
import { awsError, ddbMock, grantCredentials, resetAllMocks, s3ControlMock, s3Mock } from './helpers/mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetDataAccessCommand } from '@aws-sdk/client-s3-control';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { DOWNLOAD_META_TTL_DAYS, SPLIT_THRESHOLD_BYTES } from '@genome-portal/contract';
import { resetOriginVerifyCache } from '../../../lambda/shared/originVerify';
import { resetSettingsCache } from '../../../lambda/shared/config';
import { resetSigningKeyCache } from '../../../lambda/shared/signing';
import { handler, incrementDownloadCount } from '../../../lambda/handlers/downloads';

const B = TEST.bucket;
const KEY = 'projects/P1/sample01.g.vcf.gz';
const SIZE = 12 * 1024 ** 3;

function setup(
  opts: { prevCount?: number; cfThreshold?: string; urlTtl?: string; size?: number; crc?: string } = {},
) {
  resetAllMocks({ cfThreshold: opts.cfThreshold ?? '1', urlTtlSeconds: opts.urlTtl ?? '3600' });
  resetOriginVerifyCache();
  resetSettingsCache();
  resetSigningKeyCache();
  ddbMock.on(PutCommand).resolves({});
  ddbMock
    .on(GetCommand, { Key: { pk: `ORG#${USER_A.orgId}`, sk: 'META' } })
    .resolves({ Item: { active: true } });
  ddbMock.on(QueryCommand).resolves({
    Items: [
      { bucket: B, prefix: 'projects/' },
      { bucket: B, prefix: 'projects/P1/' },
    ],
  });
  ddbMock
    .on(UpdateCommand)
    .resolves(opts.prevCount === undefined ? {} : { Attributes: { count: opts.prevCount } });
  s3ControlMock.on(GetDataAccessCommand).resolves(grantCredentials(new Date('2026-10-05T13:00:00.000Z')));
  s3Mock.on(HeadObjectCommand).resolves({
    ContentLength: opts.size ?? SIZE,
    ChecksumCRC32: opts.crc ?? 'AbCd==',
    ChecksumType: 'FULL_OBJECT',
  });
}

beforeEach(() => setup());

const call = (body: unknown = { bucket: B, key: KEY }) => handler(makeEvent({ body })).then(parseResult);

function auditEvents() {
  return ddbMock.commandCalls(PutCommand).map((c) => c.args[0].input.Item as Record<string, unknown>);
}

describe('POST /api/downloads: path decision (prevCount x cfThreshold)', () => {
  it.each([
    [0, '1', 'S3'],
    [1, '1', 'CF'],
    [5, '1', 'CF'],
    [0, '0', 'CF'],
    [1, '0', 'CF'],
    [0, '2', 'S3'],
    [1, '2', 'S3'],
    [2, '2', 'CF'],
  ])('prevCount=%i cfThreshold=%s -> %s', async (prevCount, cfThreshold, expected) => {
    setup({ prevCount, cfThreshold });
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.json?.['path']).toBe(expected);
    expect(res.json?.['count']).toBe(prevCount + 1);
  });

  it('a missing item (first ever download) is prevCount 0 -> S3', async () => {
    setup({ prevCount: undefined });
    const res = await call();
    expect(res.json).toMatchObject({ path: 'S3', count: 1 });
  });
});

describe('POST /api/downloads: S3 path', () => {
  it('issues a presigned URL whose expiry equals the credential expiry', async () => {
    setup({ prevCount: 0 });
    const res = await call();
    const body = res.json ?? {};
    expect(body).toMatchObject({
      path: 'S3',
      mode: 'split',
      sizeBytes: SIZE,
      checksumCrc32: 'AbCd==',
      count: 1,
      filename: 'sample01.g.vcf.gz',
    });
    expect(body['expiresAt']).toBe('2026-10-05T13:00:00.000Z');
    expect(typeof body['downloadId']).toBe('string');
    const url = new URL(String(body['url']));
    expect(url.hostname).toBe(`${B}.s3.${TEST.region}.amazonaws.com`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('testsession');
    expect(url.searchParams.get('response-content-disposition')).toContain('sample01.g.vcf.gz');

    // GetDataAccess: object target, urlTtl, dl= audit context
    const gda = s3ControlMock.commandCalls(GetDataAccessCommand)[0]?.args[0].input;
    expect(gda).toMatchObject({
      Target: `s3://${B}/${KEY}`,
      TargetType: 'Object',
      Permission: 'READ',
      Privilege: 'Minimal',
      DurationSeconds: 3600,
    });
    expect(gda?.AuditContext).toBe(`user=${USER_A.sub};org=${USER_A.orgId};dl=${String(body['downloadId'])}`);

    // HeadObject with checksum mode through the granted credentials
    expect(s3Mock.commandCalls(HeadObjectCommand)[0]?.args[0].input).toEqual({
      Bucket: B,
      Key: KEY,
      ChecksumMode: 'ENABLED',
    });

    // Atomic counter update
    const upd = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(upd?.TableName).toBe(TEST.downloadsTable);
    expect(upd?.Key).toEqual({ pk: `OBJ#${B}/${KEY}` });
    expect(upd?.UpdateExpression).toBe(
      'ADD #c :one SET lastAt = :now, sizeBytes = :size, checksumCrc32 = :crc',
    );
    expect(upd?.ReturnValues).toBe('ALL_OLD');
    expect(upd?.ExpressionAttributeValues).toMatchObject({ ':one': 1, ':size': SIZE, ':crc': 'AbCd==' });

    // Audit + DL# meta (longest-match location recorded)
    const events = auditEvents();
    const issued = events.find((e) => e['type'] === 'DOWNLOAD_ISSUED');
    expect(issued).toMatchObject({
      userSub: USER_A.sub,
      orgId: USER_A.orgId,
      bucket: B,
      key: KEY,
      sizeBytes: SIZE,
      path: 'S3',
      mode: 'split',
      ip: '203.0.113.7',
      country: 'KR',
      matchedGrantTarget: `s3://${B}/projects/P1/*`,
      detail: { count: 1, location: `${B}/projects/P1/` },
    });
    const meta = events.find((e) => String(e['pk']).startsWith('DL#'));
    expect(meta).toMatchObject({
      sk: 'META',
      userSub: USER_A.sub,
      orgId: USER_A.orgId,
      bucket: B,
      key: KEY,
      path: 'S3',
      renewCount: 0,
    });
    const issuedAt = new Date(String(meta?.['issuedAt'])).getTime() / 1000;
    expect(Number(meta?.['expiresAt'])).toBe(Math.floor(issuedAt) + DOWNLOAD_META_TTL_DAYS * 86400);
  });
});

describe('POST /api/downloads: CloudFront path', () => {
  it('signs a CloudFront URL expiring now + urlTtl', async () => {
    setup({ prevCount: 3, urlTtl: '7200' });
    const before = Date.now();
    const res = await call();
    const body = res.json ?? {};
    expect(body).toMatchObject({ path: 'CF', count: 4 });
    const url = new URL(String(body['url']));
    expect(url.origin).toBe(`https://${TEST.cfDomain}`);
    expect(url.pathname).toBe(`/${KEY}`);
    expect(url.searchParams.get('Key-Pair-Id')).toBe(TEST.keyPairId);
    expect(url.searchParams.get('Signature')).toBeTruthy();
    const expires = Number(url.searchParams.get('Expires')) * 1000;
    expect(expires).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000 + 7200_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 7200_000 + 1000); // signer rounds up to whole seconds
    expect(new Date(String(body['expiresAt'])).getTime()).toBeGreaterThan(before + 7100_000);
    // still goes through GetDataAccess + HeadObject (single data path, CloudTrail record)
    expect(s3ControlMock.commandCalls(GetDataAccessCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(1);
  });
});

describe('POST /api/downloads: mode hint and checksum', () => {
  it('size <= split threshold -> single; no CRC when S3 has none', async () => {
    setup({ prevCount: 0, size: SPLIT_THRESHOLD_BYTES });
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: SPLIT_THRESHOLD_BYTES });
    const res = await call();
    expect(res.json).toMatchObject({ mode: 'single', sizeBytes: SPLIT_THRESHOLD_BYTES });
    expect(res.json).not.toHaveProperty('checksumCrc32');
    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input.UpdateExpression).toBe(
      'ADD #c :one SET lastAt = :now, sizeBytes = :size',
    );
  });

  it('size just above the threshold -> split', async () => {
    setup({ prevCount: 0, size: SPLIT_THRESHOLD_BYTES + 1 });
    expect((await call()).json?.['mode']).toBe('split');
  });
});

describe('POST /api/downloads: failures', () => {
  it('object outside assigned locations -> 403 NOT_ASSIGNED, no GetDataAccess, no count', async () => {
    const res = await call({ bucket: B, key: 'other/P2/x.vcf' });
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ reason: 'NOT_ASSIGNED' });
    expect(auditEvents()[0]).toMatchObject({
      type: 'ACCESS_DENIED',
      reason: 'NOT_ASSIGNED',
      key: 'other/P2/x.vcf',
    });
    expect(s3ControlMock.commandCalls(GetDataAccessCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('foreign bucket -> 403 NOT_ASSIGNED', async () => {
    const res = await call({ bucket: 'someone-elses-bucket', key: KEY });
    expect(res.status).toBe(403);
  });

  it('inactive organisation -> 403 ORG_INACTIVE', async () => {
    ddbMock
      .on(GetCommand, { Key: { pk: `ORG#${USER_A.orgId}`, sk: 'META' } })
      .resolves({ Item: { active: false } });
    expect((await call()).json).toMatchObject({ reason: 'ORG_INACTIVE' });
  });

  it('no grant -> 403 NO_GRANT + audit, no count', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    s3ControlMock.on(GetDataAccessCommand).rejects(awsError('AccessDenied', 403));
    const res = await call();
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ reason: 'NO_GRANT' });
    expect(auditEvents()[0]).toMatchObject({ type: 'ACCESS_DENIED', reason: 'NO_GRANT', key: KEY });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it('missing object -> 404 and the counter is untouched', async () => {
    s3Mock.on(HeadObjectCommand).rejects(awsError('NotFound', 404));
    const res = await call();
    expect(res.status).toBe(404);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(auditEvents().filter((e) => e['type'] === 'DOWNLOAD_ISSUED')).toHaveLength(0);
  });

  it('invalid body -> 400', async () => {
    expect((await call({ bucket: B })).status).toBe(400);
    expect((await call({ bucket: B, key: 'folder/' })).status).toBe(400);
  });

  it('missing origin header -> 403', async () => {
    const res = parseResult(await handler(makeEvent({ withOrigin: false, body: { bucket: B, key: KEY } })));
    expect(res.status).toBe(403);
  });

  it('unexpected DynamoDB failure -> 500 INTERNAL', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ddbMock.on(UpdateCommand).rejects(new Error('ProvisionedThroughputExceeded'));
    const res = await call();
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: 'INTERNAL', message: 'Internal error' });
    err.mockRestore();
  });
});

describe('incrementDownloadCount', () => {
  it('treats a non-numeric stored count as 0', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { count: 'weird' } });
    expect(await incrementDownloadCount(B, KEY, { sizeBytes: 1, now: new Date() })).toEqual({
      prevCount: 0,
      count: 1,
    });
  });
});
