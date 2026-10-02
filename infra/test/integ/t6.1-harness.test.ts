/**
 * T6.1 -- harness smoke: stack outputs, seed precondition, test users + SRP sign-in, org/prefix fixtures,
 * unauthenticated and direct-API access rules.
 */
import { ROUTES, type ListLocationsResponse } from '@genome-portal/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api } from './harness/api';
import { assertDefaults } from './harness/ssm';
import {
  PREFIXES,
  SEED_OBJECT_KEY,
  ensurePerfFixture,
  headChecksum,
  setupHarness,
  type Harness,
} from './harness/fixtures';
import { stackOutputs } from './harness/outputs';
import { evidence, runId } from './harness/state';

describe('T6.1 harness', () => {
  let h: Harness;

  beforeAll(async () => {
    await assertDefaults();
    h = await setupHarness();
    evidence(`run ${runId()} portal=${h.outputs.PortalUrl} bucket=${h.bucket}`);
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  it('스택 출력 로드: eight stacks expose every required output', async () => {
    const o = await stackOutputs();
    expect(o.UserPoolId).toMatch(/^ap-northeast-2_/);
    expect(o.PortalUrl).toMatch(/^https:\/\//);
    expect(o.ApiEndpoint).toMatch(/^https:\/\/.*execute-api/);
    expect(o.DataBucketName).toBe(
      `genome-portal-data-${o.AccessGrantsInstanceArn.split(':')[4]}-ap-northeast-2`,
    );
    expect(o.GranteeRoleArn).toMatch(/:role\/genome-portal-grantee-role$/);
    expect(o.OpsDailyFunctionName).toBe('genome-portal-ops-daily');
  });

  it('시드 데이터 전제 확인: projects/DEMO-0001/sample-1gib.bin carries a FULL_OBJECT CRC32', async () => {
    const head = await headChecksum(h.bucket, SEED_OBJECT_KEY);
    evidence(
      `seed ${SEED_OBJECT_KEY}: size=${head.size} checksumType=${head.checksumType} crc32=${head.crc32}`,
    );
    expect(head.size).toBe(1024 ** 3);
    expect(head.checksumType).toBe('FULL_OBJECT');
    expect(head.crc32).toBeTruthy();
  });

  it('test users exist, sign in via SRP and carry their org claim', () => {
    for (const key of ['a', 'b', 'admin'] as const) {
      expect(h.users[key].sub).toMatch(/^[0-9a-f-]{36}$/);
      expect(h.tokens[key].idToken.split('.')).toHaveLength(3);
      const payload = JSON.parse(
        Buffer.from(h.tokens[key].idToken.split('.')[1] ?? '', 'base64url').toString(),
      ) as Record<string, unknown>;
      expect(payload['custom:orgId']).toBe(h.users[key].orgId);
      expect(payload['sub']).toBe(h.users[key].sub);
      if (key === 'admin') expect(payload['cognito:groups']).toContain('admins');
      else expect(payload['cognito:groups'] ?? []).not.toContain('admins');
    }
  });

  it('GET /api/locations lists exactly the assigned prefixes per organisation', async () => {
    const a = await h.api.a.get<ListLocationsResponse>(ROUTES.locations);
    expect(a.status).toBe(200);
    const aPrefixes = a.json.items.map((it) => it.prefix).sort();
    expect(aPrefixes).toContain(PREFIXES.a);
    expect(aPrefixes).toContain(PREFIXES.perf);
    expect(aPrefixes).not.toContain(PREFIXES.b);
    expect(aPrefixes).not.toContain(PREFIXES.demo);

    const b = await h.api.b.get<ListLocationsResponse>(ROUTES.locations);
    expect(b.status).toBe(200);
    const bPrefixes = b.json.items.map((it) => it.prefix);
    expect(bPrefixes).toEqual([PREFIXES.b]);
    evidence(`locations a=${JSON.stringify(aPrefixes)} b=${JSON.stringify(bPrefixes)}`);
  });

  it('unauthenticated -> 401; non-admin on admin route -> 403 NOT_ADMIN', async () => {
    const anon = await api(undefined).get(ROUTES.locations);
    expect(anon.status).toBe(401);
    const notAdmin = await h.api.a.post<{ reason?: string }>(ROUTES.adminLocations, { action: 'list' });
    expect(notAdmin.status).toBe(403);
    expect(notAdmin.json.reason).toBe('NOT_ADMIN');
  });

  it('direct API Gateway: rejected without x-origin-verify, accepted with it', async () => {
    const { ApiEndpoint } = h.outputs;
    const res = await fetch(`${ApiEndpoint.replace(/\/+$/, '')}${ROUTES.locations}`, {
      headers: { authorization: `Bearer ${h.tokens.a.idToken}` },
    });
    await res.arrayBuffer();
    expect([401, 403]).toContain(res.status);
    const direct = await api(h.tokens.a.idToken, 'direct').get<ListLocationsResponse>(ROUTES.locations);
    expect(direct.status).toBe(200);
    expect(direct.json.items.length).toBeGreaterThan(0);
    evidence(
      `direct API without header -> ${res.status}; with header -> ${direct.status} in ${Math.round(direct.ms)} ms`,
    );
  });

  it('projects/PERF-1000/ fixture holds 1,000 objects assigned to integ-a (M7 first-render measurement)', async () => {
    const { total } = await ensurePerfFixture(h.bucket);
    expect(total).toBeGreaterThanOrEqual(1000);
    console.info(
      `[perf-1000] log in at ${h.outputs.PortalUrl} as ${h.users.a.email} (password: reset by this suite via ` +
        `AdminSetUserPassword each run; set a known one with the same call before the Playwright run) and open ${PREFIXES.perf}`,
    );
  }, 600_000);
});
