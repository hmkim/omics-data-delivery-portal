import { TEST } from './helpers/fixtures';
import { ddbMock, resetAllMocks } from './helpers/mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { AUDIT_TTL_DAYS } from '@genome-portal/contract';
import { buildAuditItem, buildEmf, emitMetric, metrics, recordAudit } from '../../../lambda/shared/audit';

beforeEach(() => resetAllMocks());

describe('audit items', () => {
  it('builds DAY#/TS# keys and a 400-day TTL', () => {
    const now = new Date('2026-10-05T12:34:56.789Z');
    const item = buildAuditItem({ type: 'DOWNLOAD_ISSUED', userSub: 'u', path: 'S3' }, now, 'uuid-1');
    expect(item.pk).toBe('DAY#2026-10-05');
    expect(item.sk).toBe('TS#2026-10-05T12:34:56.789Z#uuid-1');
    expect(item.at).toBe('2026-10-05T12:34:56.789Z');
    expect(item.expiresAt).toBe(Math.floor(now.getTime() / 1000) + AUDIT_TTL_DAYS * 86400);
    expect(item.type).toBe('DOWNLOAD_ISSUED');
  });

  it('honours an explicit at', () => {
    const item = buildAuditItem({ type: 'LOGIN_SUCCESS', at: '2026-01-02T00:00:00.000Z' }, new Date(), 'x');
    expect(item.pk).toBe('DAY#2026-01-02');
  });

  it('writes to the audit table', async () => {
    ddbMock.on(PutCommand).resolves({});
    await recordAudit({ type: 'ACCESS_DENIED', reason: 'NOT_ASSIGNED', userSub: 'u', orgId: 'o' });
    const call = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(call?.TableName).toBe(TEST.auditTable);
    expect(call?.Item).toMatchObject({
      type: 'ACCESS_DENIED',
      reason: 'NOT_ASSIGNED',
      userSub: 'u',
      orgId: 'o',
    });
    expect(String(call?.Item?.['pk'])).toMatch(/^DAY#\d{4}-\d{2}-\d{2}$/);
  });

  it('never throws when the write fails (a download must not fail on audit)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ddbMock.on(PutCommand).rejects(new Error('ddb down'));
    await expect(recordAudit({ type: 'URL_RENEWED' })).resolves.toMatchObject({ type: 'URL_RENEWED' });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

describe('EMF metrics', () => {
  it('builds a valid _aws envelope with dimensions', () => {
    const emf = buildEmf('BytesIssued', 1234, 'Bytes', { path: 'CF' }, 1_700_000_000_000);
    expect(emf._aws.Timestamp).toBe(1_700_000_000_000);
    expect(emf._aws.CloudWatchMetrics[0]).toEqual({
      Namespace: 'GenomePortalTest',
      Dimensions: [['path']],
      Metrics: [{ Name: 'BytesIssued', Unit: 'Bytes' }],
    });
    expect(emf['path']).toBe('CF');
    expect(emf['BytesIssued']).toBe(1234);
  });

  it('emits one JSON line per metric to stdout', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    emitMetric('AccessDenied', 1);
    metrics.downloadIssued('S3');
    metrics.bytesIssued('CF', 99);
    metrics.accessDenied();
    metrics.grantMissing();
    metrics.urlRenewed();
    expect(spy).toHaveBeenCalledTimes(6);
    const lines = spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    expect(lines.every((l) => '_aws' in l)).toBe(true);
    expect(lines[1]).toMatchObject({ DownloadIssued: 1, path: 'S3' });
    expect(lines[2]).toMatchObject({ BytesIssued: 99, path: 'CF' });
    expect(lines[4]).toMatchObject({ GrantMissing: 1 });
    spy.mockRestore();
  });
});
