import { ADMIN, TEST, USER_A, makeEvent, parseResult, type ClaimsInput } from './helpers/fixtures';
import { awsError, cognitoMock, ddbMock, resetAllMocks, s3ControlMock } from './helpers/mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  CreateAccessGrantCommand,
  DeleteAccessGrantCommand,
  ListAccessGrantsCommand,
} from '@aws-sdk/client-s3-control';
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminUserGlobalSignOutCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { resetOriginVerifyCache } from '../../../lambda/shared/originVerify';
import { decodeNextToken, encodeNextToken, handler } from '../../../lambda/handlers/admin';

const B = TEST.bucket;
const P1 = 'projects/P1/';
const SCOPE1 = `s3://${B}/${P1}*`;

// ---------------------------------------------------------------------------
// In-memory orgs table (pk/sk) with the `inverted` GSI, and an in-memory grant store.
// ---------------------------------------------------------------------------
type Item = Record<string, unknown> & { pk: string; sk: string };
let orgs: Map<string, Item>;
let audit: Item[];
let grants: Map<string, { scope: string }>;
let grantSeq: number;

const k = (pk: string, sk: string) => `${pk}|${sk}`;

function installOrgsTable() {
  orgs = new Map();
  audit = [];
  grants = new Map();
  grantSeq = 0;

  ddbMock
    .on(PutCommand)
    .callsFake((input: { TableName: string; Item: Item; ConditionExpression?: string }) => {
      if (input.TableName === TEST.auditTable) {
        audit.push(input.Item);
        return {};
      }
      const key = k(input.Item.pk, input.Item.sk);
      if (input.ConditionExpression === 'attribute_not_exists(pk)' && orgs.has(key))
        throw awsError('ConditionalCheckFailedException', 400);
      orgs.set(key, input.Item);
      return {};
    });
  ddbMock.on(GetCommand).callsFake((input: { TableName: string; Key: { pk: string; sk: string } }) => {
    if (input.TableName !== TEST.orgsTable) return {};
    return { Item: orgs.get(k(input.Key.pk, input.Key.sk)) };
  });
  ddbMock.on(DeleteCommand).callsFake((input: { Key: { pk: string; sk: string } }) => {
    orgs.delete(k(input.Key.pk, input.Key.sk));
    return {};
  });
  ddbMock
    .on(UpdateCommand)
    .callsFake(
      (input: { TableName: string; Key: { pk: string; sk: string }; ConditionExpression?: string }) => {
        if (input.TableName !== TEST.orgsTable) return { Attributes: { count: 5 } };
        const key = k(input.Key.pk, input.Key.sk);
        const existing = orgs.get(key);
        if (input.ConditionExpression === 'attribute_exists(pk)' && !existing)
          throw awsError('ConditionalCheckFailedException', 400);
        orgs.set(key, { ...(existing ?? input.Key), active: false });
        return {};
      },
    );
  ddbMock
    .on(QueryCommand)
    .callsFake(
      (input: {
        TableName: string;
        IndexName?: string;
        ExpressionAttributeValues: Record<string, string>;
      }) => {
        if (input.TableName === TEST.auditTable) {
          return { Items: audit.filter((a) => a.pk === input.ExpressionAttributeValues[':pk']) };
        }
        const v = input.ExpressionAttributeValues;
        if (input.IndexName === 'inverted') {
          // sk = :meta AND begins_with(pk, :loc)  |  sk = :loc AND begins_with(pk, :org)
          const skEq = v[':meta'] ?? v[':loc'];
          const pkPrefix = v[':meta'] ? v[':loc'] : v[':org'];
          return {
            Items: [...orgs.values()].filter((i) => i.sk === skEq && i.pk.startsWith(pkPrefix ?? '')),
          };
        }
        return {
          Items: [...orgs.values()].filter((i) => i.pk === v[':pk'] && i.sk.startsWith(v[':loc'] ?? '')),
        };
      },
    );

  s3ControlMock.on(ListAccessGrantsCommand).callsFake((input: { GrantScope?: string }) => ({
    AccessGrantsList: [...grants.entries()]
      .filter(([, g]) => g.scope === input.GrantScope)
      .map(([id, g]) => ({ AccessGrantId: id, GrantScope: g.scope, Permission: 'READ' })),
  }));
  s3ControlMock
    .on(CreateAccessGrantCommand)
    .callsFake((input: { AccessGrantsLocationConfiguration: { S3SubPrefix: string } }) => {
      grantSeq += 1;
      const id = `grant-${grantSeq}`;
      grants.set(id, { scope: `s3://${B}/${input.AccessGrantsLocationConfiguration.S3SubPrefix}` });
      return { AccessGrantId: id };
    });
  s3ControlMock.on(DeleteAccessGrantCommand).callsFake((input: { AccessGrantId: string }) => {
    if (!grants.delete(input.AccessGrantId)) throw awsError('NoSuchAccessGrant', 404);
    return {};
  });
}

beforeEach(() => {
  resetAllMocks();
  resetOriginVerifyCache();
  installOrgsTable();
});

const admin = (route: string, body: unknown, claims: ClaimsInput = ADMIN) =>
  handler(makeEvent({ path: `/api/admin/${route}`, pathParameters: { proxy: route }, body, claims })).then(
    parseResult,
  );

async function createOrg(orgId: string) {
  const res = await admin('orgs', { action: 'create', orgId, name: `Org ${orgId}` });
  expect(res.status).toBe(201);
}

describe('admin: authorisation and routing', () => {
  it('non-admin -> 403 NOT_ADMIN, nothing written', async () => {
    const res = await admin('orgs', { action: 'create', orgId: 'x', name: 'x' }, USER_A);
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ reason: 'NOT_ADMIN' });
    expect(orgs.size).toBe(0);
  });

  it('admin without an orgId claim is fine', async () => {
    await createOrg('org-a');
  });

  it('unknown route -> 404; missing origin header -> 403', async () => {
    expect((await admin('nope', {})).status).toBe(404);
    const res = parseResult(
      await handler(
        makeEvent({ withOrigin: false, pathParameters: { proxy: 'orgs' }, claims: ADMIN, body: {} }),
      ),
    );
    expect(res.status).toBe(403);
  });
});

describe('admin: orgs', () => {
  it('create -> META row + ORG_CREATED; duplicate -> 409', async () => {
    await createOrg('org-a');
    expect(orgs.get(k('ORG#org-a', 'META'))).toMatchObject({ name: 'Org org-a', active: true });
    expect(audit[0]).toMatchObject({ type: 'ORG_CREATED', userSub: ADMIN.sub, orgId: 'org-a' });
    expect((await admin('orgs', { action: 'create', orgId: 'org-a', name: 'again' })).status).toBe(409);
  });

  it('disable -> active=false + ORG_DISABLED; unknown -> 404; bad orgId -> 400', async () => {
    await createOrg('org-a');
    const res = await admin('orgs', { action: 'disable', orgId: 'org-a' });
    expect(res.status).toBe(200);
    expect(orgs.get(k('ORG#org-a', 'META'))).toMatchObject({ active: false });
    expect(audit.at(-1)).toMatchObject({ type: 'ORG_DISABLED', orgId: 'org-a' });
    expect((await admin('orgs', { action: 'disable', orgId: 'ghost' })).status).toBe(404);
    expect((await admin('orgs', { action: 'create', orgId: 'bad id!', name: 'n' })).status).toBe(400);
  });
});

describe('admin: location assign / unassign reference-count state machine', () => {
  beforeEach(async () => {
    await createOrg('org-a');
    await createOrg('org-b');
  });

  it('assign to first org creates the grant, META and ORG#/LOC#', async () => {
    const res = await admin('locations', {
      action: 'assign',
      orgId: 'org-a',
      bucket: B,
      prefix: P1,
      label: 'P1',
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      orgId: 'org-a',
      bucket: B,
      prefix: P1,
      accessGrantId: 'grant-1',
      grantCreated: true,
    });
    const create = s3ControlMock.commandCalls(CreateAccessGrantCommand)[0]?.args[0].input;
    expect(create).toEqual({
      AccountId: TEST.accountId,
      AccessGrantsLocationId: TEST.locationId,
      AccessGrantsLocationConfiguration: { S3SubPrefix: `${P1}*` },
      Grantee: { GranteeType: 'IAM', GranteeIdentifier: TEST.granteeRoleArn },
      Permission: 'READ',
    });
    expect(orgs.get(k(`LOC#${B}/${P1}`, 'META'))).toMatchObject({
      bucket: B,
      prefix: P1,
      accessGrantId: 'grant-1',
      grantScope: SCOPE1,
    });
    expect(orgs.get(k('ORG#org-a', `LOC#${B}/${P1}`))).toMatchObject({ bucket: B, prefix: P1, label: 'P1' });
    expect(audit.at(-1)).toMatchObject({
      type: 'LOCATION_ASSIGNED',
      orgId: 'org-a',
      bucket: B,
      key: P1,
      detail: { accessGrantId: 'grant-1', grantCreated: true },
    });
  });

  it('assigning the same location to a second org reuses the grant (idempotent)', async () => {
    await admin('locations', { action: 'assign', orgId: 'org-a', bucket: B, prefix: P1 });
    const res = await admin('locations', { action: 'assign', orgId: 'org-b', bucket: B, prefix: P1 });
    expect(res.json).toMatchObject({ accessGrantId: 'grant-1', grantCreated: false });
    expect(s3ControlMock.commandCalls(CreateAccessGrantCommand)).toHaveLength(1);
    expect(grants.size).toBe(1);
    // re-assigning to the same org is a no-op on the grant too
    await admin('locations', { action: 'assign', orgId: 'org-a', bucket: B, prefix: P1 });
    expect(s3ControlMock.commandCalls(CreateAccessGrantCommand)).toHaveLength(1);
  });

  it('recovers when META is missing but the grant already exists (partial failure)', async () => {
    grants.set('grant-pre', { scope: SCOPE1 });
    const res = await admin('locations', { action: 'assign', orgId: 'org-a', bucket: B, prefix: P1 });
    expect(res.json).toMatchObject({ accessGrantId: 'grant-pre', grantCreated: false });
    expect(s3ControlMock.commandCalls(ListAccessGrantsCommand)[0]?.args[0].input).toMatchObject({
      GrantScope: SCOPE1,
      GranteeType: 'IAM',
      GranteeIdentifier: TEST.granteeRoleArn,
    });
    expect(s3ControlMock.commandCalls(CreateAccessGrantCommand)).toHaveLength(0);
  });

  it('unassign keeps the grant while another org remains, deletes it with the last org', async () => {
    await admin('locations', { action: 'assign', orgId: 'org-a', bucket: B, prefix: P1 });
    await admin('locations', { action: 'assign', orgId: 'org-b', bucket: B, prefix: P1 });

    const first = await admin('locations', { action: 'unassign', orgId: 'org-a', bucket: B, prefix: P1 });
    expect(first.json).toMatchObject({ grantDeleted: false, remainingOrgs: ['org-b'] });
    expect(orgs.has(k('ORG#org-a', `LOC#${B}/${P1}`))).toBe(false);
    expect(orgs.has(k(`LOC#${B}/${P1}`, 'META'))).toBe(true);
    expect(grants.size).toBe(1);
    expect(audit.at(-1)).toMatchObject({
      type: 'LOCATION_UNASSIGNED',
      orgId: 'org-a',
      detail: { grantDeleted: false, remainingOrgs: 1 },
    });

    const last = await admin('locations', { action: 'unassign', orgId: 'org-b', bucket: B, prefix: P1 });
    expect(last.json).toMatchObject({ grantDeleted: true, remainingOrgs: [] });
    expect(orgs.has(k(`LOC#${B}/${P1}`, 'META'))).toBe(false);
    expect(grants.size).toBe(0);
    expect(s3ControlMock.commandCalls(DeleteAccessGrantCommand)[0]?.args[0].input).toEqual({
      AccountId: TEST.accountId,
      AccessGrantId: 'grant-1',
    });
  });

  it('unassign of a never-assigned location is harmless', async () => {
    const res = await admin('locations', {
      action: 'unassign',
      orgId: 'org-a',
      bucket: B,
      prefix: 'projects/P9/',
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ grantDeleted: false });
  });

  it('nested prefixes are independent grants', async () => {
    await admin('locations', { action: 'assign', orgId: 'org-a', bucket: B, prefix: P1 });
    await admin('locations', { action: 'assign', orgId: 'org-b', bucket: B, prefix: 'projects/P1/sub/' });
    expect(grants.size).toBe(2);
    await admin('locations', { action: 'unassign', orgId: 'org-a', bucket: B, prefix: P1 });
    expect(grants.size).toBe(1);
    expect([...grants.values()][0]?.scope).toBe(`s3://${B}/projects/P1/sub/*`);
  });

  it.each([
    ['no trailing slash', 'projects/P1'],
    ['dot-dot', 'projects/../P1/'],
    ['star', 'projects/P*/'],
    ['empty segment', 'projects//P1/'],
  ])('rejects prefix %s -> 400 BAD_SCOPE', async (_n, prefix) => {
    const res = await admin('locations', { action: 'assign', orgId: 'org-a', bucket: B, prefix });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ reason: 'BAD_SCOPE' });
    expect(grants.size).toBe(0);
  });

  it('rejects a foreign bucket and an unknown org', async () => {
    expect(
      (await admin('locations', { action: 'assign', orgId: 'org-a', bucket: 'other-bucket', prefix: P1 }))
        .status,
    ).toBe(400);
    expect(
      (await admin('locations', { action: 'assign', orgId: 'ghost', bucket: B, prefix: P1 })).status,
    ).toBe(404);
    expect(grants.size).toBe(0);
  });

  it('list returns every location with its orgs; filter by org', async () => {
    await admin('locations', { action: 'assign', orgId: 'org-a', bucket: B, prefix: P1 });
    await admin('locations', { action: 'assign', orgId: 'org-b', bucket: B, prefix: P1 });
    await admin('locations', { action: 'assign', orgId: 'org-b', bucket: B, prefix: 'projects/P2/' });
    const all = await admin('locations', { action: 'list' });
    const items = all.json?.['items'] as Array<{
      prefix: string;
      orgIds: string[];
      accessGrantId: string;
      grantScope: string;
    }>;
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.prefix === P1)).toMatchObject({
      orgIds: expect.arrayContaining(['org-a', 'org-b']),
      accessGrantId: 'grant-1',
      grantScope: SCOPE1,
    });
    const onlyA = await admin('locations', { action: 'list', orgId: 'org-a' });
    expect((onlyA.json?.['items'] as Array<{ prefix: string }>).map((i) => i.prefix)).toEqual([P1]);
  });

  it('unassign-all removes every assignment, grant and META', async () => {
    await admin('locations', { action: 'assign', orgId: 'org-a', bucket: B, prefix: P1 });
    await admin('locations', { action: 'assign', orgId: 'org-b', bucket: B, prefix: P1 });
    await admin('locations', { action: 'assign', orgId: 'org-b', bucket: B, prefix: 'projects/P2/' });
    const res = await admin('locations', { action: 'unassign-all' });
    expect(res.status).toBe(200);
    expect((res.json?.['removed'] as unknown[]).length).toBe(2);
    expect(grants.size).toBe(0);
    expect([...orgs.keys()].filter((key) => key.includes('LOC#'))).toEqual([]);
    expect([...orgs.keys()]).toEqual([k('ORG#org-a', 'META'), k('ORG#org-b', 'META')]);
    expect(audit.filter((a) => a.type === 'LOCATION_UNASSIGNED')).toHaveLength(2);
  });

  it('tolerates a grant that is already gone during unassign', async () => {
    await admin('locations', { action: 'assign', orgId: 'org-a', bucket: B, prefix: P1 });
    grants.clear();
    const res = await admin('locations', { action: 'unassign', orgId: 'org-a', bucket: B, prefix: P1 });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ grantDeleted: false });
    expect(orgs.has(k(`LOC#${B}/${P1}`, 'META'))).toBe(false);
  });
});

describe('admin: users', () => {
  beforeEach(async () => {
    await createOrg('org-a');
    cognitoMock
      .on(AdminCreateUserCommand)
      .resolves({ User: { Attributes: [{ Name: 'sub', Value: 'new-sub' }] } });
    cognitoMock.on(AdminDisableUserCommand).resolves({});
    cognitoMock.on(AdminEnableUserCommand).resolves({});
    cognitoMock.on(AdminDeleteUserCommand).resolves({});
    cognitoMock.on(AdminUserGlobalSignOutCommand).resolves({});
  });

  it('create sets custom:orgId / custom:lang and emails a temporary password', async () => {
    const res = await admin('users', {
      action: 'create',
      email: 'lee@ku.example',
      orgId: 'org-a',
      lang: 'en',
    });
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ email: 'lee@ku.example', orgId: 'org-a', lang: 'en', sub: 'new-sub' });
    const input = cognitoMock.commandCalls(AdminCreateUserCommand)[0]?.args[0].input;
    expect(input).toEqual({
      UserPoolId: TEST.userPoolId,
      Username: 'lee@ku.example',
      DesiredDeliveryMediums: ['EMAIL'],
      UserAttributes: [
        { Name: 'email', Value: 'lee@ku.example' },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'custom:orgId', Value: 'org-a' },
        { Name: 'custom:lang', Value: 'en' },
      ],
    });
    expect(audit.at(-1)).toMatchObject({
      type: 'USER_CREATED',
      userSub: ADMIN.sub,
      orgId: 'org-a',
      detail: { email: 'lee@ku.example', lang: 'en', sub: 'new-sub' },
    });
  });

  it('create: unknown org 404, inactive org 400, duplicate 409, bad email 400', async () => {
    expect(
      (await admin('users', { action: 'create', email: 'a@b.co', orgId: 'ghost', lang: 'ko' })).status,
    ).toBe(404);
    await admin('orgs', { action: 'disable', orgId: 'org-a' });
    expect(
      (await admin('users', { action: 'create', email: 'a@b.co', orgId: 'org-a', lang: 'ko' })).status,
    ).toBe(400);
    await createOrg('org-c');
    cognitoMock.on(AdminCreateUserCommand).rejects(awsError('UsernameExistsException', 400));
    expect(
      (await admin('users', { action: 'create', email: 'a@b.co', orgId: 'org-c', lang: 'ko' })).status,
    ).toBe(409);
    expect(
      (await admin('users', { action: 'create', email: 'not-an-email', orgId: 'org-c', lang: 'ko' })).status,
    ).toBe(400);
  });

  it('disable revokes sessions; enable; delete -- each audited', async () => {
    expect((await admin('users', { action: 'disable', email: 'a@b.co' })).json).toEqual({
      email: 'a@b.co',
      enabled: false,
    });
    expect(cognitoMock.commandCalls(AdminDisableUserCommand)).toHaveLength(1);
    expect(cognitoMock.commandCalls(AdminUserGlobalSignOutCommand)[0]?.args[0].input).toEqual({
      UserPoolId: TEST.userPoolId,
      Username: 'a@b.co',
    });
    expect((await admin('users', { action: 'enable', email: 'a@b.co' })).json).toEqual({
      email: 'a@b.co',
      enabled: true,
    });
    expect((await admin('users', { action: 'delete', email: 'a@b.co' })).json).toEqual({
      email: 'a@b.co',
      deleted: true,
    });
    expect(audit.slice(-3).map((a) => a.type)).toEqual(['USER_DISABLED', 'USER_ENABLED', 'USER_DELETED']);
    expect(audit.slice(-3).every((a) => (a.detail as { email: string }).email === 'a@b.co')).toBe(true);
  });
});

describe('admin: reset-count', () => {
  it('sets count to 0 and records COUNT_RESET with the previous value', async () => {
    const res = await admin('reset-count', { bucket: B, key: 'projects/P1/s.bam' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ bucket: B, key: 'projects/P1/s.bam', previousCount: 5, count: 0 });
    const upd = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.TableName === TEST.downloadsTable)?.args[0].input;
    expect(upd?.Key).toEqual({ pk: `OBJ#${B}/projects/P1/s.bam` });
    expect(upd?.UpdateExpression).toBe('SET #c = :zero, resetAt = :now');
    expect(upd?.ExpressionAttributeValues).toMatchObject({ ':zero': 0 });
    expect(audit.at(-1)).toMatchObject({
      type: 'COUNT_RESET',
      userSub: ADMIN.sub,
      bucket: B,
      key: 'projects/P1/s.bam',
      detail: { previousCount: 5 },
    });
  });

  it('validates the body', async () => {
    expect((await admin('reset-count', { bucket: B })).status).toBe(400);
  });
});

describe('admin: audit-export', () => {
  it('returns the day partition without storage keys and encodes pagination', async () => {
    audit.push({
      pk: 'DAY#2026-10-05',
      sk: 'TS#2026-10-05T01:00:00.000Z#u1',
      type: 'DOWNLOAD_ISSUED',
      at: '2026-10-05T01:00:00.000Z',
      expiresAt: 1,
      userSub: 'u',
    });
    audit.push({ pk: 'DAY#2026-10-06', sk: 'TS#x', type: 'URL_RENEWED', at: 'x', expiresAt: 1 });
    const res = await admin('audit-export', { day: '2026-10-05' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      items: [{ type: 'DOWNLOAD_ISSUED', at: '2026-10-05T01:00:00.000Z', userSub: 'u' }],
    });
    const q = ddbMock.commandCalls(QueryCommand).at(-1)?.args[0].input;
    expect(q?.TableName).toBe(TEST.auditTable);
    expect(q?.ExpressionAttributeValues).toEqual({ ':pk': 'DAY#2026-10-05', ':ts': 'TS#' });
  });

  it('passes nextToken through as ExclusiveStartKey and returns a new token', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: { pk: 'DAY#2026-10-05', sk: 'TS#z' } });
    const token = encodeNextToken({ pk: 'DAY#2026-10-05', sk: 'TS#a' });
    const res = await admin('audit-export', { day: '2026-10-05', nextToken: token });
    expect(ddbMock.commandCalls(QueryCommand).at(-1)?.args[0].input.ExclusiveStartKey).toEqual({
      pk: 'DAY#2026-10-05',
      sk: 'TS#a',
    });
    expect(decodeNextToken(res.json?.['nextToken'] as string)).toEqual({ pk: 'DAY#2026-10-05', sk: 'TS#z' });
    expect(encodeNextToken(undefined)).toBeUndefined();
    expect(decodeNextToken(undefined)).toBeUndefined();
  });

  it('rejects bad days and bad tokens', async () => {
    expect((await admin('audit-export', { day: '2026/10/05' })).status).toBe(400);
    expect((await admin('audit-export', { day: '2026-13-45' })).status).toBe(400);
    expect((await admin('audit-export', { day: '2026-10-05', nextToken: '!!!' })).status).toBe(400);
    expect(
      (
        await admin('audit-export', {
          day: '2026-10-05',
          nextToken: Buffer.from('[1]').toString('base64url'),
        })
      ).status,
    ).toBe(400);
  });
});
