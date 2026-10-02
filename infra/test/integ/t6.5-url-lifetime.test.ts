/**
 * T6.5 -- URL lifetime and Range support. Fast part: lifetimes match the current TTL on both paths and both URLs
 * serve a 1 MiB Range with 206. Slow part (INTEG_SLOW=1): with a 15-minute TTL both URLs work right away and
 * return 403 once expiresAt has passed.
 */
import type { DownloadResponse } from '@genome-portal/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectOk } from './harness/api';
import { MiB, freshObject, setupHarness, type Harness } from './harness/fixtures';
import {
  assertDefaults,
  getSetting,
  putSetting,
  restoreSetting,
  SETTINGS_PROPAGATION_MS,
} from './harness/ssm';
import { evidence } from './harness/state';
import { cfUrlInfo, getRange, s3UrlInfo, seconds, sleep } from './harness/util';

const SLOW = process.env['INTEG_SLOW'] === '1';
const RANGE_END = MiB - 1;

describe('T6.5 URL lifetime / Range', () => {
  let h: Harness;

  beforeAll(async () => {
    await assertDefaults();
    h = await setupHarness();
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  it('S3 and CF URLs: expiresAt ~ TTL, signature parameters agree with expiresAt, Range GET -> 206', async () => {
    const ttl = Number(await getSetting('urlTtlSeconds'));
    const size = 2 * MiB;
    const key = await freshObject(h.bucket, 't65-fast', size);

    const t0 = Date.now();
    const s3 = expectOk(await h.api.a.download(h.bucket, key, h.users.a.sub), 'S3 download');
    const t1 = Date.now();
    const cf = expectOk(await h.api.a.download(h.bucket, key, h.users.a.sub), 'CF download');
    const t2 = Date.now();
    expect(s3.path).toBe('S3');
    expect(cf.path).toBe('CF');

    const s3Life = new Date(s3.expiresAt).getTime() - (t0 + t1) / 2;
    const cfLife = new Date(cf.expiresAt).getTime() - (t1 + t2) / 2;
    evidence(`T6.5 ttl=${ttl}s S3 lifetime=${seconds(s3Life)} CF lifetime=${seconds(cfLife)}`);
    expect(Math.abs(s3Life - ttl * 1000)).toBeLessThanOrEqual(30_000);
    expect(Math.abs(cfLife - ttl * 1000)).toBeLessThanOrEqual(30_000);

    const s3Info = s3UrlInfo(s3.url);
    expect(s3Info.expiresSeconds).toBe(ttl);
    expect(Math.abs(s3Info.expiresAt.getTime() - new Date(s3.expiresAt).getTime())).toBeLessThanOrEqual(
      5_000,
    );
    const cfInfo = cfUrlInfo(cf.url);
    expect(cfInfo.host).toBe(h.outputs.DomainName);
    expect(cfInfo.keyPairId).toBe(h.outputs.KeyPairId);
    expect(
      Math.abs(cfInfo.expiresEpoch - Math.floor(new Date(cf.expiresAt).getTime() / 1000)),
    ).toBeLessThanOrEqual(1);
    evidence(
      `T6.5 S3 X-Amz-Expires=${s3Info.expiresSeconds} X-Amz-Date+Expires=${s3Info.expiresAt.toISOString()} ` +
        `expiresAt=${s3.expiresAt}; CF Expires=${cfInfo.expiresEpoch} expiresAt=${cf.expiresAt}`,
    );

    const expectedRange = `bytes 0-${RANGE_END}/${size}`;
    const r1 = await getRange(s3.url);
    const r2 = await getRange(cf.url);
    evidence(
      `T6.5 Range S3 -> ${r1.status} ${r1.contentRange} (${r1.contentLength} B); CF -> ${r2.status} ${r2.contentRange} (${r2.contentLength} B)`,
    );
    expect(r1.status).toBe(206);
    expect(r1.contentRange).toBe(expectedRange);
    expect(r1.contentLength).toBe(MiB);
    expect(r2.status).toBe(206);
    expect(r2.contentRange).toBe(expectedRange);
    expect(r2.contentLength).toBe(MiB);

    // An unsigned CloudFront URL is refused.
    const unsigned = await getRange(`https://${h.outputs.DomainName}/${encodeURI(key)}`);
    expect(unsigned.status).toBe(403);
  });

  it.runIf(SLOW)(
    'INTEG_SLOW: 15-minute TTL -> URLs work immediately and return 403 after expiresAt on both paths',
    async () => {
      await putSetting('urlTtlSeconds', '900');
      await sleep(SETTINGS_PROPAGATION_MS);
      let s3: DownloadResponse;
      let cf: DownloadResponse;
      try {
        const key = await freshObject(h.bucket, 't65-slow', 2 * MiB);
        s3 = expectOk(await h.api.a.download(h.bucket, key, h.users.a.sub), 'S3 download (900 s)');
        cf = expectOk(await h.api.a.download(h.bucket, key, h.users.a.sub), 'CF download (900 s)');
      } finally {
        await restoreSetting('urlTtlSeconds'); // restore immediately; the issued URLs keep their 900 s
      }
      expect(s3.path).toBe('S3');
      expect(cf.path).toBe('CF');
      expect(s3UrlInfo(s3.url).expiresSeconds).toBe(900);

      const early1 = await getRange(s3.url);
      const early2 = await getRange(cf.url);
      evidence(
        `T6.5 slow: fresh GET S3 -> ${early1.status}, CF -> ${early2.status}; expiresAt S3=${s3.expiresAt} CF=${cf.expiresAt}`,
      );
      expect([200, 206]).toContain(early1.status);
      expect([200, 206]).toContain(early2.status);

      const until = Math.max(new Date(s3.expiresAt).getTime(), new Date(cf.expiresAt).getTime()) + 15_000;
      const waitMs = Math.max(0, until - Date.now());
      evidence(`T6.5 slow: waiting ${seconds(waitMs)} until ${new Date(until).toISOString()}`);
      await sleep(waitMs);

      const late1 = await getRange(s3.url);
      const late2 = await getRange(cf.url);
      evidence(
        `T6.5 slow: expired GET S3 -> ${late1.status} ${late1.bodyText?.replace(/\s+/g, ' ') ?? ''}; ` +
          `CF -> ${late2.status} ${late2.bodyText?.replace(/\s+/g, ' ') ?? ''}`,
      );
      expect(late1.status).toBe(403);
      expect(late1.bodyText ?? '').toMatch(/AccessDenied|ExpiredToken|expired/i);
      expect(late2.status).toBe(403);
      expect(late2.bodyText ?? '').toMatch(/MissingKey|Access denied|expired/i);
      // Later files depend on the default TTL: give the Lambda caches time to drop the 900 s value.
      await sleep(SETTINGS_PROPAGATION_MS);
    },
    30 * 60_000,
  );
});
