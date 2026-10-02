/**
 * T6.6 -- grant lifecycle (design §7.3): the first assignment of a prefix creates exactly one Access Grant, a second
 * organisation shares it, the grant survives until the last organisation is unassigned, and opsDaily reports no drift.
 */
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { ListAccessGrantsCommand, type ListAccessGrantEntry } from '@aws-sdk/client-s3-control';
import { ROUTES, grantScopeFor, type ApiError } from '@genome-portal/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aws } from './harness/aws';
import {
  ORGS,
  PREFIXES,
  assign,
  listLocations,
  setupHarness,
  unassign,
  type Harness,
} from './harness/fixtures';
import { assertDefaults } from './harness/ssm';
import { evidence } from './harness/state';
import { pollUntil } from './harness/util';

interface OpsResult {
  day: string;
  metrics: Record<string, number>;
  archivedEvents: number;
  errors: string[];
}

describe('T6.6 grant lifecycle', () => {
  let h: Harness;
  let scope: string;

  beforeAll(async () => {
    await assertDefaults();
    h = await setupHarness();
    scope = grantScopeFor(h.bucket, PREFIXES.shared);
  });

  afterAll(async () => {
    // Leave INTEG-SHARED unassigned even when an assertion failed part-way (best effort).
    if (h) {
      for (const org of [ORGS.a.orgId, ORGS.b.orgId]) {
        await unassign(h.api.admin, org, h.bucket, PREFIXES.shared).catch(() => undefined);
      }
    }
    await h?.cleanup();
  });

  /** Every grant of the grantee role whose scope equals `scope` (client-side exact match, paginated). */
  async function grantsForScope(): Promise<ListAccessGrantEntry[]> {
    const accountId = h.outputs.GranteeRoleArn.split(':')[4] ?? '';
    const found: ListAccessGrantEntry[] = [];
    let nextToken: string | undefined;
    do {
      const out = await aws.s3control().send(
        new ListAccessGrantsCommand({
          AccountId: accountId,
          GranteeType: 'IAM',
          GranteeIdentifier: h.outputs.GranteeRoleArn,
          NextToken: nextToken,
        }),
      );
      for (const g of out.AccessGrantsList ?? []) if (g.GrantScope === scope) found.push(g);
      nextToken = out.NextToken;
    } while (nextToken);
    return found;
  }

  it('assign to integ-a creates one grant; integ-b reuses it; unassign a keeps it; unassign b deletes it', async () => {
    expect(await grantsForScope()).toHaveLength(0);

    const first = await assign(h.api.admin, ORGS.a.orgId, h.bucket, PREFIXES.shared);
    expect(first.grantCreated).toBe(true);
    expect(first.accessGrantId).toBeTruthy();
    const afterA = await pollUntil(
      async () => {
        const g = await grantsForScope();
        return g.length > 0 ? g : undefined;
      },
      { timeoutMs: 30_000, intervalMs: 2_000, what: 'grant listed after assign' },
    );
    evidence(
      `T6.6 assign a: grantCreated=${first.grantCreated} id=${first.accessGrantId} listed=${afterA.length}`,
    );
    expect(afterA).toHaveLength(1);
    expect(afterA[0]?.AccessGrantId).toBe(first.accessGrantId);
    expect(afterA[0]?.Permission).toBe('READ');

    const second = await assign(h.api.admin, ORGS.b.orgId, h.bucket, PREFIXES.shared);
    evidence(`T6.6 assign b: grantCreated=${second.grantCreated} id=${second.accessGrantId}`);
    expect(second.grantCreated).toBe(false);
    expect(second.accessGrantId).toBe(first.accessGrantId);
    expect(await grantsForScope()).toHaveLength(1);
    const listed = await listLocations(h.api.admin);
    const shared = listed.items.find((it) => it.prefix === PREFIXES.shared);
    expect(shared?.orgIds.sort()).toEqual([ORGS.a.orgId, ORGS.b.orgId]);
    expect(shared?.accessGrantId).toBe(first.accessGrantId);

    const unA = await unassign(h.api.admin, ORGS.a.orgId, h.bucket, PREFIXES.shared);
    evidence(
      `T6.6 unassign a: grantDeleted=${unA.grantDeleted} remaining=${JSON.stringify(unA.remainingOrgs)}`,
    );
    expect(unA.grantDeleted).toBe(false);
    expect(unA.remainingOrgs).toEqual([ORGS.b.orgId]);
    expect(await grantsForScope()).toHaveLength(1);

    const unB = await unassign(h.api.admin, ORGS.b.orgId, h.bucket, PREFIXES.shared);
    evidence(
      `T6.6 unassign b: grantDeleted=${unB.grantDeleted} remaining=${JSON.stringify(unB.remainingOrgs)}`,
    );
    expect(unB.grantDeleted).toBe(true);
    expect(unB.remainingOrgs).toEqual([]);
    const gone = await pollUntil(async () => ((await grantsForScope()).length === 0 ? true : undefined), {
      timeoutMs: 30_000,
      intervalMs: 2_000,
      what: 'grant removed after last unassign',
    });
    expect(gone).toBe(true);
    expect((await listLocations(h.api.admin)).items.some((it) => it.prefix === PREFIXES.shared)).toBe(false);

    const creds = await h.api.b.post<ApiError>(ROUTES.credentials, { scope, permission: 'READ' });
    evidence(`T6.6 credentials as b after unassign -> ${creds.status} ${JSON.stringify(creds.json)}`);
    expect(creds.status).toBe(403);
    expect(creds.json.reason).toBe('NOT_ASSIGNED');
  });

  it('opsDaily: GrantDrift === 0 and no step errors', async () => {
    const out = await aws
      .lambda()
      .send(new InvokeCommand({ FunctionName: h.outputs.OpsDailyFunctionName, Payload: Buffer.from('{}') }));
    const text = Buffer.from(out.Payload ?? new Uint8Array()).toString('utf8');
    evidence(
      `T6.6 opsDaily status=${out.StatusCode} functionError=${out.FunctionError ?? '-'} payload=${text.slice(0, 600)}`,
    );
    expect(out.FunctionError).toBeUndefined();
    const result = JSON.parse(text) as OpsResult;
    expect(result.errors).toEqual([]);
    expect(result.metrics['GrantDrift']).toBe(0);
  });
});
