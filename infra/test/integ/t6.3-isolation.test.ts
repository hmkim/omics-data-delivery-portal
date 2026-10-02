/**
 * T6.3 -- isolation between organisations:
 *  (a) browsing credentials for INTEG-A cannot list or read INTEG-B,
 *  (b) an assignment without an Access Grant is refused with NO_GRANT and raises the GrantMissing metric,
 *  (c) a download outside the caller's locations is refused with NOT_ASSIGNED and audited.
 */
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  ROUTES,
  grantScopeFor,
  keys,
  type ApiError,
  type CredentialsResponse,
} from '@genome-portal/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectOk } from './harness/api';
import { metricSum, waitForAuditEvent } from './harness/audit';
import { aws, s3WithCredentials } from './harness/aws';
import { INTEG_B_OBJECT_KEY, ORGS, PREFIXES, setupHarness, type Harness } from './harness/fixtures';
import { assertDefaults } from './harness/ssm';
import { evidence } from './harness/state';
import { pollUntil } from './harness/util';

async function s3Error(fn: () => Promise<unknown>): Promise<{ name: string; status?: number }> {
  try {
    await fn();
    return { name: 'NoError' };
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    return { name: e.name ?? 'Unknown', status: e.$metadata?.httpStatusCode };
  }
}

describe('T6.3 isolation', () => {
  let h: Harness;

  beforeAll(async () => {
    await assertDefaults();
    h = await setupHarness();
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  it('(a) INTEG-A browsing credentials: list/get INTEG-B -> 403, list INTEG-A -> ok', async () => {
    const res = await h.api.a.post<CredentialsResponse>(ROUTES.credentials, {
      scope: grantScopeFor(h.bucket, PREFIXES.a),
      permission: 'READ',
    });
    const { credentials } = expectOk(res, 'credentials INTEG-A');
    const s3 = s3WithCredentials(credentials);

    const listB = await s3Error(() =>
      s3.send(new ListObjectsV2Command({ Bucket: h.bucket, Prefix: PREFIXES.b, MaxKeys: 5 })),
    );
    const getB = await s3Error(() =>
      s3.send(new GetObjectCommand({ Bucket: h.bucket, Key: INTEG_B_OBJECT_KEY })),
    );
    const listA = await s3.send(
      new ListObjectsV2Command({ Bucket: h.bucket, Prefix: PREFIXES.a, MaxKeys: 5 }),
    );
    evidence(
      `T6.3a list INTEG-B -> ${listB.name}/${listB.status}; get INTEG-B object -> ${getB.name}/${getB.status}; ` +
        `list INTEG-A -> 200 (${listA.KeyCount ?? 0} keys)`,
    );
    expect(listB.status).toBe(403);
    expect(listB.name).toBe('AccessDenied');
    expect(getB.status).toBe(403);
    expect(getB.name).toBe('AccessDenied');
    expect(listA.$metadata.httpStatusCode).toBe(200);
  });

  it('(b) assignment without a grant -> 403 NO_GRANT on /credentials and /downloads, GrantMissing >= 1', async () => {
    const table = h.outputs.OrgsTableName;
    const pk = keys.org(ORGS.a.orgId);
    const sk = keys.loc(h.bucket, PREFIXES.noGrant);
    // Mirror the fields admin.ts writes for an assignment; deliberately no LOC#/META row and no grant.
    await aws.ddb().send(
      new PutCommand({
        TableName: table,
        Item: { pk, sk, bucket: h.bucket, prefix: PREFIXES.noGrant, assignedAt: new Date().toISOString() },
      }),
    );
    const since = new Date().toISOString();
    // EMF datapoints land on minute boundaries: count only what this test produced (earlier runs are excluded).
    const metricWindowStart = new Date(Date.now() - 60_000);
    try {
      const creds = await h.api.a.post<ApiError>(ROUTES.credentials, {
        scope: grantScopeFor(h.bucket, PREFIXES.noGrant),
        permission: 'READ',
      });
      const dl = await h.api.a.post<ApiError>(ROUTES.downloads, {
        bucket: h.bucket,
        key: `${PREFIXES.noGrant}x.bin`,
      });
      evidence(
        `T6.3b credentials -> ${creds.status} ${JSON.stringify(creds.json)}; downloads -> ${dl.status} ${JSON.stringify(dl.json)}`,
      );
      expect(creds.status).toBe(403);
      expect(creds.json.reason).toBe('NO_GRANT');
      expect(dl.status).toBe(403);
      expect(dl.json.reason).toBe('NO_GRANT');

      const audit = await waitForAuditEvent(h.users.a.sub, {
        type: 'ACCESS_DENIED',
        reason: 'NO_GRANT',
        since,
      });
      expect(audit.key === PREFIXES.noGrant || audit.key === `${PREFIXES.noGrant}x.bin`).toBe(true);

      const started = Date.now();
      const sum = await pollUntil(
        async () => {
          const s = await metricSum('GrantMissing', metricWindowStart);
          return s >= 1 ? s : undefined;
        },
        { timeoutMs: 180_000, intervalMs: 10_000, what: 'GenomePortal GrantMissing Sum >= 1' },
      );
      evidence(
        `T6.3b GrantMissing Sum(since test start)=${sum} observed after ${Math.round((Date.now() - started) / 1000)} s`,
      );
      expect(sum).toBeGreaterThanOrEqual(1);
    } finally {
      await aws.ddb().send(new DeleteCommand({ TableName: table, Key: { pk, sk } }));
    }
    const check = await aws.ddb().send(new GetCommand({ TableName: table, Key: { pk, sk } }));
    expect(check.Item, 'INTEG-NOGRANT assignment item must be removed').toBeUndefined();
  });

  it('(c) user A downloading the INTEG-B object -> 403 NOT_ASSIGNED + ACCESS_DENIED audit event', async () => {
    const since = new Date().toISOString();
    const res = await h.api.a.post<ApiError>(ROUTES.downloads, { bucket: h.bucket, key: INTEG_B_OBJECT_KEY });
    evidence(`T6.3c downloads INTEG-B as A -> ${res.status} ${JSON.stringify(res.json)}`);
    expect(res.status).toBe(403);
    expect(res.json.reason).toBe('NOT_ASSIGNED');
    const audit = await waitForAuditEvent(h.users.a.sub, {
      type: 'ACCESS_DENIED',
      reason: 'NOT_ASSIGNED',
      key: INTEG_B_OBJECT_KEY,
      since,
    });
    evidence(
      `T6.3c audit ACCESS_DENIED at=${audit.at} org=${audit.orgId} key=${audit.key} ip=${audit.ip ?? '-'}`,
    );
    expect(audit.orgId).toBe(ORGS.a.orgId);
    expect(audit.bucket).toBe(h.bucket);
  });
});
