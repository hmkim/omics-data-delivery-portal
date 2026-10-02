/**
 * T6.4 -- path rules (D4): first download S3 / second CF, concurrency safety of the atomic counter, renew keeps
 * the path and never counts, admin reset-count, and cf-threshold=0 sending the first download to CloudFront.
 */
import {
  ROUTES,
  type DownloadResponse,
  type ObjectStatusResponse,
  type RenewResponse,
} from '@genome-portal/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectOk } from './harness/api';
import { waitForAuditEvent } from './harness/audit';
import { freshObject, setupHarness, type Harness } from './harness/fixtures';
import { assertDefaults, withSetting } from './harness/ssm';
import { evidence } from './harness/state';

describe('T6.4 path rules', () => {
  let h: Harness;

  beforeAll(async () => {
    await assertDefaults();
    h = await setupHarness();
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  async function status(key: string) {
    const res = await h.api.a.post<ObjectStatusResponse>(ROUTES.objectStatus, {
      items: [{ bucket: h.bucket, key }],
    });
    const body = expectOk(res, 'objects/status');
    const item = body.items[0];
    if (!item) throw new Error(`objects/status returned no item for ${key}`);
    return item;
  }

  it('fresh object: first download path S3 count 1, second CF count 2', async () => {
    const key = await freshObject(h.bucket, 't64-first');
    const first = expectOk(await h.api.a.download(h.bucket, key, h.users.a.sub), 'first download');
    const second = expectOk(await h.api.a.download(h.bucket, key, h.users.a.sub), 'second download');
    evidence(`T6.4 first=${first.path}/${first.count} second=${second.path}/${second.count}`);
    expect(first.path).toBe('S3');
    expect(first.count).toBe(1);
    expect(second.path).toBe('CF');
    expect(second.count).toBe(2);
    expect(first.checksumCrc32).toBeTruthy();
    expect(first.mode).toBe('single');
    expect((await status(key)).count).toBe(2);
  });

  it('two concurrent first downloads: exactly one S3 and one CF, counts {1, 2}', async () => {
    const key = await freshObject(h.bucket, 't64-concurrent');
    const [x, y] = await Promise.all([
      h.api.a.download(h.bucket, key, h.users.a.sub),
      h.api.a.download(h.bucket, key, h.users.a.sub),
    ]);
    const a = expectOk(x, 'concurrent download 1');
    const b = expectOk(y, 'concurrent download 2');
    evidence(`T6.4 concurrent: ${a.path}/${a.count} and ${b.path}/${b.count}`);
    expect([a.path, b.path].sort()).toEqual(['CF', 'S3']);
    expect([a.count, b.count].sort()).toEqual([1, 2]);
    expect(a.downloadId).not.toBe(b.downloadId);
  });

  it('renew keeps the path, renewCount 1, count unchanged, URL_RENEWED audit event', async () => {
    const key = await freshObject(h.bucket, 't64-renew');
    const dl = expectOk(await h.api.a.download(h.bucket, key, h.users.a.sub), 'download');
    const since = new Date().toISOString();
    const renewed = expectOk(await h.api.a.post<RenewResponse>(ROUTES.renew(dl.downloadId), {}), 'renew');
    evidence(
      `T6.4 renew ${dl.downloadId}: path ${dl.path} -> ${renewed.path}, renewCount=${renewed.renewCount}`,
    );
    expect(renewed.downloadId).toBe(dl.downloadId);
    expect(renewed.path).toBe(dl.path);
    expect(renewed.renewCount).toBe(1);
    expect(renewed.url).not.toBe(dl.url);
    expect((await status(key)).count).toBe(1);
    const audit = await waitForAuditEvent(h.users.a.sub, {
      type: 'URL_RENEWED',
      downloadId: dl.downloadId,
      since,
    });
    expect(audit.key).toBe(key);
    expect(audit.path).toBe(dl.path);

    // A renew by another user of the same download is refused (NOT_OWNER).
    const other = await h.api.b.post<{ reason?: string }>(ROUTES.renew(dl.downloadId), {});
    expect(other.status).toBe(403);
    expect(other.json.reason).toBe('NOT_OWNER');
  });

  it('admin reset-count -> next download is S3 again with count 1', async () => {
    const key = await freshObject(h.bucket, 't64-reset');
    expectOk(await h.api.a.download(h.bucket, key, h.users.a.sub), 'download 1');
    expectOk(await h.api.a.download(h.bucket, key, h.users.a.sub), 'download 2');
    const reset = await h.api.admin.post<{ previousCount: number; count: number }>(ROUTES.adminResetCount, {
      bucket: h.bucket,
      key,
    });
    const body = expectOk(reset, 'reset-count');
    expect(body.previousCount).toBe(2);
    expect(body.count).toBe(0);
    expect((await status(key)).count).toBe(0);
    const again = expectOk(await h.api.a.download(h.bucket, key, h.users.a.sub), 'download after reset');
    evidence(`T6.4 reset-count previous=${body.previousCount}; next download ${again.path}/${again.count}`);
    expect(again.path).toBe('S3');
    expect(again.count).toBe(1);

    // reset-count is admin-only.
    const denied = await h.api.a.post<{ reason?: string }>(ROUTES.adminResetCount, { bucket: h.bucket, key });
    expect(denied.status).toBe(403);
    expect(denied.json.reason).toBe('NOT_ADMIN');
  });

  it('cf-threshold=0 -> the first download of a fresh object goes to CloudFront', async () => {
    await withSetting('cfThreshold', '0', async () => {
      const key = await freshObject(h.bucket, 't64-threshold0');
      const st = await status(key);
      expect(st.nextPath).toBe('CF');
      const dl = expectOk(await h.api.a.download(h.bucket, key, h.users.a.sub), 'download with threshold 0');
      evidence(
        `T6.4 cf-threshold=0: objects/status nextPath=${st.nextPath}; first download ${dl.path}/${dl.count}`,
      );
      expect(dl.path).toBe('CF');
      expect(dl.count).toBe(1);
      expect(new URL(dl.url).host).toBe(h.outputs.DomainName);
    });
    // Default restored (withSetting waited 65 s): a fresh object is S3 again.
    const key = await freshObject(h.bucket, 't64-threshold-restored');
    const dl = expectOk(await h.api.a.download(h.bucket, key, h.users.a.sub), 'download after restore');
    expect(dl.path).toBe('S3');
    void (dl satisfies DownloadResponse);
  });
});
