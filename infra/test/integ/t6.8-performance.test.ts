/**
 * T6.8 -- performance: 200 sequential POST /downloads over 4 fresh 1 MiB objects through the portal domain;
 * p50 / p95 / max are printed and p95 must stay below 500 ms (design §10). The direct-API numbers are printed too,
 * so a miss can be attributed to CloudFront vs. API Gateway + Lambda.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, expectOk } from './harness/api';
import { freshObject, setupHarness, type Harness } from './harness/fixtures';
import { assertDefaults } from './harness/ssm';
import { evidence } from './harness/state';
import { summarize } from './harness/util';

const ITERATIONS = 200;
const OBJECTS = 4;
const P95_BUDGET_MS = 500;

describe('T6.8 performance', () => {
  let h: Harness;

  beforeAll(async () => {
    await assertDefaults();
    h = await setupHarness();
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  it(
    `${ITERATIONS} sequential POST /downloads via the portal domain: p95 < ${P95_BUDGET_MS} ms`,
    async () => {
      const keys: string[] = [];
      for (let i = 0; i < OBJECTS; i += 1) keys.push(await freshObject(h.bucket, 't68-perf'));

      // Warm up: one call per object (first download S3, cold containers) is not part of the sample.
      for (const key of keys) expectOk(await h.api.a.download(h.bucket, key, h.users.a.sub), 'warm-up');

      const portal: number[] = [];
      const paths = { S3: 0, CF: 0 };
      for (let i = 0; i < ITERATIONS; i += 1) {
        const key = keys[i % OBJECTS] ?? '';
        const res = await h.api.a.download(h.bucket, key, h.users.a.sub);
        const body = expectOk(res, `download #${i + 1}`);
        paths[body.path] += 1;
        portal.push(res.ms);
      }
      const p = summarize(portal);
      evidence(
        `T6.8 portal n=${p.n} p50=${p.p50} ms p95=${p.p95} ms max=${p.max} ms min=${p.min} ms mean=${p.mean} ms paths=${JSON.stringify(paths)}`,
      );

      const direct = api(h.tokens.a.idToken, 'direct');
      const directMs: number[] = [];
      for (let i = 0; i < 40; i += 1) {
        const key = keys[i % OBJECTS] ?? '';
        const res = await direct.download(h.bucket, key, h.users.a.sub);
        expectOk(res, `direct download #${i + 1}`);
        directMs.push(res.ms);
      }
      const d = summarize(directMs);
      evidence(
        `T6.8 direct API n=${d.n} p50=${d.p50} ms p95=${d.p95} ms max=${d.max} ms (CloudFront overhead ~ ${p.p50 - d.p50} ms at p50)`,
      );

      expect(p.n).toBe(ITERATIONS);
      expect(p.p95).toBeLessThan(P95_BUDGET_MS);
    },
    20 * 60_000,
  );
});
