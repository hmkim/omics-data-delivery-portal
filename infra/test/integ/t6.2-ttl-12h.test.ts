/**
 * T6.2 -- GetDataAccess 12 h: with url-ttl-seconds = 43200 a fresh download's expiresAt is ~12 h away (this is the
 * Access Grants credential Expiration; role chaining must not cap it at 1 h) and the S3 URL carries X-Amz-Expires=43200.
 */
import { URL_TTL_MAX_SECONDS } from '@genome-portal/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectOk } from './harness/api';
import { freshObject, setupHarness, type Harness } from './harness/fixtures';
import { assertDefaults, withSetting } from './harness/ssm';
import { evidence } from './harness/state';
import { s3UrlInfo, seconds } from './harness/util';

const TWELVE_HOURS_MS = URL_TTL_MAX_SECONDS * 1000;
const TOLERANCE_MS = 5 * 60 * 1000;

describe('T6.2 GetDataAccess 12 h', () => {
  let h: Harness;

  beforeAll(async () => {
    await assertDefaults();
    h = await setupHarness();
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  it('url-ttl-seconds=43200 -> expiresAt ~ now + 12 h (+-5 min) and X-Amz-Expires = 43200', async () => {
    await withSetting('urlTtlSeconds', String(URL_TTL_MAX_SECONDS), async () => {
      const key = await freshObject(h.bucket, 't62-12h');
      const before = Date.now();
      const dl = expectOk(await h.api.a.download(h.bucket, key, h.users.a.sub), 'download 12h');
      const after = Date.now();
      const expiresAt = new Date(dl.expiresAt).getTime();
      const lifetimeMs = expiresAt - (before + after) / 2;
      evidence(
        `T6.2 path=${dl.path} expiresAt=${dl.expiresAt} lifetime=${seconds(lifetimeMs)} ` +
          `(target ${seconds(TWELVE_HOURS_MS)}, delta ${seconds(lifetimeMs - TWELVE_HOURS_MS)})`,
      );
      expect(dl.path).toBe('S3');
      expect(Math.abs(lifetimeMs - TWELVE_HOURS_MS)).toBeLessThanOrEqual(TOLERANCE_MS);
      const info = s3UrlInfo(dl.url);
      evidence(`T6.2 X-Amz-Expires=${info.expiresSeconds} X-Amz-Date=${info.signedAt.toISOString()}`);
      expect(info.expiresSeconds).toBe(URL_TTL_MAX_SECONDS);
      // The presigned URL's own window ends where the credentials end (within a few seconds).
      expect(Math.abs(info.expiresAt.getTime() - expiresAt)).toBeLessThanOrEqual(10_000);
    });
  });
});
