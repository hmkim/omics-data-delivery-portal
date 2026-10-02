/**
 * T6.7 -- CloudTrail: the GetDataAccess event of the run's first download carries `dl=<downloadId>` in its
 * AuditContext (INTEG_SLOW=1, polls up to 20 min) and the audit table holds the matching DOWNLOAD_ISSUED item
 * (fast variant).
 */
import { LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectOk } from './harness/api';
import { waitForAuditEvent } from './harness/audit';
import { aws } from './harness/aws';
import { freshObject, setupHarness, type Harness } from './harness/fixtures';
import { assertDefaults } from './harness/ssm';
import { evidence, readFirstDownload, type FirstDownload } from './harness/state';
import { pollUntil, seconds } from './harness/util';

const SLOW = process.env['INTEG_SLOW'] === '1';

describe('T6.7 CloudTrail', () => {
  let h: Harness;
  let first: FirstDownload;

  beforeAll(async () => {
    await assertDefaults();
    h = await setupHarness();
    const recorded = readFirstDownload();
    if (recorded) {
      first = recorded;
    } else {
      // Single-file run: issue the download here so there is something to look up.
      const key = await freshObject(h.bucket, 't67-first');
      const dl = expectOk(await h.api.a.download(h.bucket, key, h.users.a.sub), 'download');
      first = {
        downloadId: dl.downloadId,
        bucket: h.bucket,
        key,
        userSub: h.users.a.sub,
        issuedAt: new Date().toISOString(),
      };
    }
    evidence(`T6.7 first download of run: ${first.downloadId} ${first.key} issuedAt=${first.issuedAt}`);
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  it('audit table has the DOWNLOAD_ISSUED item for the first download (downloadId, bucket, key)', async () => {
    const ev = await waitForAuditEvent(first.userSub, {
      type: 'DOWNLOAD_ISSUED',
      downloadId: first.downloadId,
    });
    evidence(
      `T6.7 audit DOWNLOAD_ISSUED at=${ev.at} path=${ev.path} matchedGrantTarget=${ev.matchedGrantTarget ?? '-'}`,
    );
    expect(ev.bucket).toBe(first.bucket);
    expect(ev.key).toBe(first.key);
    expect(ev.path).toBe('S3');
    expect(ev.matchedGrantTarget).toBeTruthy();
  });

  it.runIf(SLOW)(
    'INTEG_SLOW: CloudTrail GetDataAccess event contains dl=<downloadId> (poll every 60 s, up to 20 min)',
    async () => {
      const issuedAt = new Date(first.issuedAt);
      const startTime = new Date(issuedAt.getTime() - 5 * 60_000);
      const needle = `dl=${first.downloadId}`;
      const started = Date.now();
      const hit = await pollUntil(
        async () => {
          let nextToken: string | undefined;
          do {
            const out = await aws.cloudtrail().send(
              new LookupEventsCommand({
                LookupAttributes: [{ AttributeKey: 'EventName', AttributeValue: 'GetDataAccess' }],
                StartTime: startTime,
                EndTime: new Date(),
                MaxResults: 50,
                NextToken: nextToken,
              }),
            );
            for (const e of out.Events ?? []) {
              if (e.CloudTrailEvent?.includes(needle)) return e;
            }
            nextToken = out.NextToken;
          } while (nextToken);
          return undefined;
        },
        { timeoutMs: 20 * 60_000, intervalMs: 60_000, what: `CloudTrail GetDataAccess with ${needle}` },
      );
      const detail = JSON.parse(hit.CloudTrailEvent ?? '{}') as {
        eventTime?: string;
        requestParameters?: Record<string, unknown>;
        userIdentity?: { arn?: string };
      };
      const eventTime = detail.eventTime ? new Date(detail.eventTime) : undefined;
      const latencyMs = Date.now() - issuedAt.getTime();
      evidence(
        `T6.7 CloudTrail hit after ${seconds(Date.now() - started)} of polling; event time ${detail.eventTime ?? '-'}; ` +
          `visible ${seconds(latencyMs)} after issue; auditContext=${String(detail.requestParameters?.['auditContext'] ?? '')}; ` +
          `caller=${detail.userIdentity?.arn ?? '-'}`,
      );
      expect(hit.EventName).toBe('GetDataAccess');
      expect(String(detail.requestParameters?.['auditContext'] ?? hit.CloudTrailEvent)).toContain(needle);
      expect(String(detail.requestParameters?.['auditContext'] ?? '')).toContain(`user=${first.userSub}`);
      if (eventTime) expect(Math.abs(eventTime.getTime() - issuedAt.getTime())).toBeLessThan(5 * 60_000);
    },
    25 * 60_000,
  );
});
