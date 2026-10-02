import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
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
import {
  GSI_NAMES,
  grantScopeFor,
  keys,
  parseScope,
  type AdminAuditExportResponse,
  type AdminLocationListResponse,
  type AuditEvent,
  type LocationRecord,
} from '@genome-portal/contract';
import { z } from 'zod';
import { recordAudit } from '../shared/audit';
import { getClaims, requireAdmin, type Claims } from '../shared/auth';
import { cognitoClient, ddbClient, s3ControlClient } from '../shared/clients';
import { requireEnv } from '../shared/env';
import { badRequest, conflict, notFound, parseBody, respond } from '../shared/errors';
import { getOrg } from '../shared/orgs';
import { verifyOrigin } from '../shared/originVerify';

const ORGS_TABLE = requireEnv('ORGS_TABLE');
const DOWNLOADS_TABLE = requireEnv('DOWNLOADS_TABLE');
const AUDIT_TABLE = requireEnv('AUDIT_TABLE');
const DATA_BUCKET = requireEnv('DATA_BUCKET');
const ACCOUNT_ID = requireEnv('ACCOUNT_ID');
const LOCATION_ID = requireEnv('ACCESS_GRANTS_LOCATION_ID');
const GRANTEE_ROLE_ARN = requireEnv('GRANTEE_ROLE_ARN');
const USER_POOL_ID = requireEnv('USER_POOL_ID');
requireEnv('ORIGIN_VERIFY_SECRET_ARN');

const META = 'META';
const ORG_PK_PREFIX = 'ORG#';
const LOC_PK_PREFIX = 'LOC#';

// ---------------------------------------------------------------------------
// Request schemas (contract Admin*Request)
// ---------------------------------------------------------------------------

const orgId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, 'orgId may contain letters, digits, . _ -');
const bucket = z.string().min(3).max(63);
const prefix = z.string().min(1);
const email = z.string().email();

const orgRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), orgId, name: z.string().min(1).max(200) }),
  z.object({ action: z.literal('disable'), orgId }),
]);

const locationRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('assign'), orgId, bucket, prefix, label: z.string().max(200).optional() }),
  z.object({ action: z.literal('unassign'), orgId, bucket, prefix }),
  z.object({ action: z.literal('unassign-all') }),
  z.object({ action: z.literal('list'), orgId: orgId.optional() }),
]);

const userRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), email, orgId, lang: z.enum(['ko', 'en']) }),
  z.object({ action: z.literal('disable'), email }),
  z.object({ action: z.literal('enable'), email }),
  z.object({ action: z.literal('delete'), email }),
]);

const resetCountRequest = z.object({ bucket, key: z.string().min(1) });

const auditExportRequest = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'day must be YYYY-MM-DD'),
  nextToken: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Location ledger helpers (design §7.3)
// ---------------------------------------------------------------------------

interface LocationMeta {
  bucket: string;
  prefix: string;
  accessGrantId?: string;
  grantScope: string;
  createdAt?: string;
}

function toLocationMeta(item: Record<string, unknown> | undefined): LocationMeta | undefined {
  if (!item || typeof item['bucket'] !== 'string' || typeof item['prefix'] !== 'string') return undefined;
  return {
    bucket: item['bucket'],
    prefix: item['prefix'],
    accessGrantId: typeof item['accessGrantId'] === 'string' ? item['accessGrantId'] : undefined,
    grantScope:
      typeof item['grantScope'] === 'string'
        ? item['grantScope']
        : grantScopeFor(item['bucket'], item['prefix']),
    createdAt: typeof item['createdAt'] === 'string' ? item['createdAt'] : undefined,
  };
}

async function getLocationMeta(b: string, p: string): Promise<LocationMeta | undefined> {
  const out = await ddbClient().send(
    new GetCommand({ TableName: ORGS_TABLE, Key: { pk: keys.loc(b, p), sk: META } }),
  );
  return toLocationMeta(out.Item as Record<string, unknown> | undefined);
}

/** Every LOC#…/META item via the inverted GSI (sk = META, pk begins_with LOC#). */
async function listLocationMetas(): Promise<LocationMeta[]> {
  const metas: LocationMeta[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const out = await ddbClient().send(
      new QueryCommand({
        TableName: ORGS_TABLE,
        IndexName: GSI_NAMES.inverted,
        KeyConditionExpression: 'sk = :meta AND begins_with(pk, :loc)',
        ExpressionAttributeValues: { ':meta': META, ':loc': LOC_PK_PREFIX },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const raw of out.Items ?? []) {
      const meta = toLocationMeta(raw as Record<string, unknown>);
      if (meta) metas.push(meta);
    }
    startKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return metas;
}

/** Organisations that hold ORG#<id>/LOC#<bucket>/<prefix>, via the inverted GSI. */
async function orgsForLocation(b: string, p: string): Promise<string[]> {
  const orgIds: string[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const out = await ddbClient().send(
      new QueryCommand({
        TableName: ORGS_TABLE,
        IndexName: GSI_NAMES.inverted,
        KeyConditionExpression: 'sk = :loc AND begins_with(pk, :org)',
        ExpressionAttributeValues: { ':loc': keys.loc(b, p), ':org': ORG_PK_PREFIX },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const raw of out.Items ?? []) {
      const pk = (raw as Record<string, unknown>)['pk'];
      if (typeof pk === 'string' && pk.startsWith(ORG_PK_PREFIX)) orgIds.push(pk.slice(ORG_PK_PREFIX.length));
    }
    startKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return orgIds;
}

/** Find an existing grant for the scope granted to our grantee role (idempotency after a partial failure). */
async function findExistingGrant(scope: string): Promise<string | undefined> {
  let nextToken: string | undefined;
  do {
    const out = await s3ControlClient().send(
      new ListAccessGrantsCommand({
        AccountId: ACCOUNT_ID,
        GrantScope: scope,
        GranteeType: 'IAM',
        GranteeIdentifier: GRANTEE_ROLE_ARN,
        NextToken: nextToken,
      }),
    );
    for (const g of out.AccessGrantsList ?? []) {
      if (g.GrantScope === scope && g.Permission === 'READ' && g.AccessGrantId) return g.AccessGrantId;
    }
    nextToken = out.NextToken;
  } while (nextToken);
  return undefined;
}

async function createGrant(p: string): Promise<string> {
  const out = await s3ControlClient().send(
    new CreateAccessGrantCommand({
      AccountId: ACCOUNT_ID,
      AccessGrantsLocationId: LOCATION_ID,
      AccessGrantsLocationConfiguration: { S3SubPrefix: `${p}*` },
      Grantee: { GranteeType: 'IAM', GranteeIdentifier: GRANTEE_ROLE_ARN },
      Permission: 'READ',
    }),
  );
  if (!out.AccessGrantId) throw new Error('CreateAccessGrant returned no AccessGrantId');
  return out.AccessGrantId;
}

async function deleteGrantIfAny(accessGrantId: string | undefined): Promise<boolean> {
  if (!accessGrantId) return false;
  try {
    await s3ControlClient().send(
      new DeleteAccessGrantCommand({ AccountId: ACCOUNT_ID, AccessGrantId: accessGrantId }),
    );
    return true;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'NoSuchAccessGrant' || name === 'NotFoundException') return false; // already gone: still consistent
    throw err;
  }
}

/** Validate (bucket, prefix) against the portal rules: data bucket, trailing slash, no `..`, no `*`. */
function validateLocation(b: string, p: string): { bucket: string; prefix: string; scope: string } {
  const parsed = parseScope(grantScopeFor(b, p), DATA_BUCKET);
  if (!parsed)
    throw badRequest(
      'prefix must end with "/", contain no empty/"."/".." segments, and live in the data bucket',
      'BAD_SCOPE',
    );
  return { ...parsed, scope: grantScopeFor(parsed.bucket, parsed.prefix) };
}

/**
 * Idempotent assign (design §7.3): LOC#/META -> existing grant -> CreateAccessGrant -> ORG#/LOC# -> audit.
 */
export async function assignLocation(
  actor: Claims,
  input: { orgId: string; bucket: string; prefix: string; label?: string },
) {
  const loc = validateLocation(input.bucket, input.prefix);
  const org = await getOrg(input.orgId);
  if (!org) throw notFound(`Organisation ${input.orgId} does not exist`);

  const now = new Date().toISOString();
  let meta = await getLocationMeta(loc.bucket, loc.prefix);
  let grantCreated = false;
  if (!meta || !meta.accessGrantId) {
    let accessGrantId = await findExistingGrant(loc.scope);
    if (!accessGrantId) {
      accessGrantId = await createGrant(loc.prefix);
      grantCreated = true;
    }
    meta = {
      bucket: loc.bucket,
      prefix: loc.prefix,
      accessGrantId,
      grantScope: loc.scope,
      createdAt: meta?.createdAt ?? now,
    };
    await ddbClient().send(
      new PutCommand({
        TableName: ORGS_TABLE,
        Item: {
          pk: keys.loc(loc.bucket, loc.prefix),
          sk: META,
          bucket: loc.bucket,
          prefix: loc.prefix,
          accessGrantId,
          grantScope: loc.scope,
          createdAt: meta.createdAt,
        },
      }),
    );
  }

  await ddbClient().send(
    new PutCommand({
      TableName: ORGS_TABLE,
      Item: {
        pk: keys.org(input.orgId),
        sk: keys.loc(loc.bucket, loc.prefix),
        bucket: loc.bucket,
        prefix: loc.prefix,
        label: input.label,
        assignedAt: now,
      },
    }),
  );
  await recordAudit({
    type: 'LOCATION_ASSIGNED',
    userSub: actor.sub,
    orgId: input.orgId,
    bucket: loc.bucket,
    key: loc.prefix,
    detail: { accessGrantId: meta.accessGrantId ?? '', grantCreated },
  });
  return {
    orgId: input.orgId,
    bucket: loc.bucket,
    prefix: loc.prefix,
    accessGrantId: meta.accessGrantId,
    grantCreated,
  };
}

/**
 * Unassign (design §7.3): delete ORG#/LOC#, then if no organisation still references the location,
 * delete the grant and the META row. Returns whether the grant was removed.
 */
export async function unassignLocation(
  actor: Claims,
  input: { orgId: string; bucket: string; prefix: string },
) {
  const loc = validateLocation(input.bucket, input.prefix);
  await ddbClient().send(
    new DeleteCommand({
      TableName: ORGS_TABLE,
      Key: { pk: keys.org(input.orgId), sk: keys.loc(loc.bucket, loc.prefix) },
    }),
  );

  const remaining = (await orgsForLocation(loc.bucket, loc.prefix)).filter((o) => o !== input.orgId);
  let grantDeleted = false;
  if (remaining.length === 0) {
    const meta = await getLocationMeta(loc.bucket, loc.prefix);
    grantDeleted = await deleteGrantIfAny(meta?.accessGrantId);
    await ddbClient().send(
      new DeleteCommand({ TableName: ORGS_TABLE, Key: { pk: keys.loc(loc.bucket, loc.prefix), sk: META } }),
    );
  }
  await recordAudit({
    type: 'LOCATION_UNASSIGNED',
    userSub: actor.sub,
    orgId: input.orgId,
    bucket: loc.bucket,
    key: loc.prefix,
    detail: { grantDeleted, remainingOrgs: remaining.length },
  });
  return {
    orgId: input.orgId,
    bucket: loc.bucket,
    prefix: loc.prefix,
    grantDeleted,
    remainingOrgs: remaining,
  };
}

/** Teardown helper (design §7.2 step 5): remove every assignment, every grant and every META row. */
export async function unassignAll(actor: Claims) {
  const metas = await listLocationMetas();
  const removed: Array<{ bucket: string; prefix: string; grantDeleted: boolean; orgIds: string[] }> = [];
  for (const meta of metas) {
    const orgIds = await orgsForLocation(meta.bucket, meta.prefix);
    for (const o of orgIds) {
      await ddbClient().send(
        new DeleteCommand({
          TableName: ORGS_TABLE,
          Key: { pk: keys.org(o), sk: keys.loc(meta.bucket, meta.prefix) },
        }),
      );
    }
    const grantDeleted = await deleteGrantIfAny(meta.accessGrantId);
    await ddbClient().send(
      new DeleteCommand({ TableName: ORGS_TABLE, Key: { pk: keys.loc(meta.bucket, meta.prefix), sk: META } }),
    );
    await recordAudit({
      type: 'LOCATION_UNASSIGNED',
      userSub: actor.sub,
      bucket: meta.bucket,
      key: meta.prefix,
      detail: { grantDeleted, remainingOrgs: 0, orgs: orgIds.join(','), all: true },
    });
    removed.push({ bucket: meta.bucket, prefix: meta.prefix, grantDeleted, orgIds });
  }
  return { removed };
}

export async function listLocations(filterOrgId?: string): Promise<AdminLocationListResponse> {
  const metas = await listLocationMetas();
  const items: LocationRecord[] = [];
  for (const meta of metas) {
    const orgIds = await orgsForLocation(meta.bucket, meta.prefix);
    if (filterOrgId && !orgIds.includes(filterOrgId)) continue;
    items.push({
      bucket: meta.bucket,
      prefix: meta.prefix,
      accessGrantId: meta.accessGrantId,
      grantScope: meta.grantScope,
      orgIds,
    });
  }
  return { items };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleOrgs(actor: Claims, event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const req = parseBody(event, orgRequest);
  const now = new Date().toISOString();
  if (req.action === 'create') {
    try {
      await ddbClient().send(
        new PutCommand({
          TableName: ORGS_TABLE,
          Item: {
            pk: keys.org(req.orgId),
            sk: META,
            orgId: req.orgId,
            name: req.name,
            active: true,
            createdAt: now,
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException')
        throw conflict(`Organisation ${req.orgId} already exists`);
      throw err;
    }
    await recordAudit({
      type: 'ORG_CREATED',
      userSub: actor.sub,
      orgId: req.orgId,
      detail: { name: req.name },
    });
    return { status: 201, body: { orgId: req.orgId, name: req.name, active: true, createdAt: now } };
  }
  try {
    await ddbClient().send(
      new UpdateCommand({
        TableName: ORGS_TABLE,
        Key: { pk: keys.org(req.orgId), sk: META },
        UpdateExpression: 'SET active = :f, disabledAt = :now',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':f': false, ':now': now },
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException')
      throw notFound(`Organisation ${req.orgId} does not exist`);
    throw err;
  }
  await recordAudit({ type: 'ORG_DISABLED', userSub: actor.sub, orgId: req.orgId });
  return { body: { orgId: req.orgId, active: false } };
}

async function handleLocations(actor: Claims, event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const req = parseBody(event, locationRequest);
  switch (req.action) {
    case 'assign':
      return { body: await assignLocation(actor, req) };
    case 'unassign':
      return { body: await unassignLocation(actor, req) };
    case 'unassign-all':
      return { body: await unassignAll(actor) };
    case 'list':
      return { body: await listLocations(req.orgId) };
  }
}

async function handleUsers(actor: Claims, event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const req = parseBody(event, userRequest);
  const cognito = cognitoClient();
  switch (req.action) {
    case 'create': {
      const org = await getOrg(req.orgId);
      if (!org) throw notFound(`Organisation ${req.orgId} does not exist`);
      if (!org.active) throw badRequest(`Organisation ${req.orgId} is inactive`, 'ORG_INACTIVE');
      let userSub: string | undefined;
      try {
        const out = await cognito.send(
          new AdminCreateUserCommand({
            UserPoolId: USER_POOL_ID,
            Username: req.email,
            DesiredDeliveryMediums: ['EMAIL'],
            UserAttributes: [
              { Name: 'email', Value: req.email },
              { Name: 'email_verified', Value: 'true' },
              { Name: 'custom:orgId', Value: req.orgId },
              { Name: 'custom:lang', Value: req.lang },
            ],
          }),
        );
        userSub = out.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
      } catch (err) {
        if ((err as { name?: string }).name === 'UsernameExistsException')
          throw conflict(`User ${req.email} already exists`);
        throw err;
      }
      await recordAudit({
        type: 'USER_CREATED',
        userSub: actor.sub,
        orgId: req.orgId,
        detail: { email: req.email, lang: req.lang, sub: userSub ?? '' },
      });
      return { status: 201, body: { email: req.email, orgId: req.orgId, lang: req.lang, sub: userSub } };
    }
    case 'disable':
      await cognito.send(new AdminDisableUserCommand({ UserPoolId: USER_POOL_ID, Username: req.email }));
      // Revoke refresh tokens too so an in-flight session stops at its next renewal (R1.5, scenario 11).
      await cognito.send(
        new AdminUserGlobalSignOutCommand({ UserPoolId: USER_POOL_ID, Username: req.email }),
      );
      await recordAudit({ type: 'USER_DISABLED', userSub: actor.sub, detail: { email: req.email } });
      return { body: { email: req.email, enabled: false } };
    case 'enable':
      await cognito.send(new AdminEnableUserCommand({ UserPoolId: USER_POOL_ID, Username: req.email }));
      await recordAudit({ type: 'USER_ENABLED', userSub: actor.sub, detail: { email: req.email } });
      return { body: { email: req.email, enabled: true } };
    case 'delete':
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: req.email }));
      await recordAudit({ type: 'USER_DELETED', userSub: actor.sub, detail: { email: req.email } });
      return { body: { email: req.email, deleted: true } };
  }
}

async function handleResetCount(actor: Claims, event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const req = parseBody(event, resetCountRequest);
  const out = await ddbClient().send(
    new UpdateCommand({
      TableName: DOWNLOADS_TABLE,
      Key: { pk: keys.obj(req.bucket, req.key) },
      UpdateExpression: 'SET #c = :zero, resetAt = :now',
      ExpressionAttributeNames: { '#c': 'count' },
      ExpressionAttributeValues: { ':zero': 0, ':now': new Date().toISOString() },
      ReturnValues: 'ALL_OLD',
    }),
  );
  const prevRaw = (out.Attributes as Record<string, unknown> | undefined)?.['count'];
  const previousCount = typeof prevRaw === 'number' ? prevRaw : 0;
  await recordAudit({
    type: 'COUNT_RESET',
    userSub: actor.sub,
    bucket: req.bucket,
    key: req.key,
    detail: { previousCount },
  });
  return { body: { bucket: req.bucket, key: req.key, previousCount, count: 0 } };
}

export function encodeNextToken(key: Record<string, unknown> | undefined): string | undefined {
  return key ? Buffer.from(JSON.stringify(key), 'utf8').toString('base64url') : undefined;
}

export function decodeNextToken(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw badRequest('Invalid nextToken');
}

const AUDIT_PAGE_SIZE = 1000;

async function handleAuditExport(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const req = parseBody(event, auditExportRequest);
  if (Number.isNaN(Date.parse(`${req.day}T00:00:00Z`))) throw badRequest('day is not a valid calendar date');
  const out = await ddbClient().send(
    new QueryCommand({
      TableName: AUDIT_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :ts)',
      ExpressionAttributeValues: { ':pk': keys.day(req.day), ':ts': 'TS#' },
      ExclusiveStartKey: decodeNextToken(req.nextToken),
      Limit: AUDIT_PAGE_SIZE,
    }),
  );
  const items: AuditEvent[] = (out.Items ?? []).map((raw) => {
    const rec = { ...(raw as Record<string, unknown>) };
    delete rec['pk'];
    delete rec['sk'];
    delete rec['expiresAt'];
    return rec as unknown as AuditEvent;
  });
  const response: AdminAuditExportResponse = {
    items,
    nextToken: encodeNextToken(out.LastEvaluatedKey as Record<string, unknown> | undefined),
  };
  return { body: response };
}

/** POST /api/admin/{proxy+} (R6.1-R6.5, design §7.3). */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  return respond(async () => {
    await verifyOrigin(event);
    const actor = getClaims(event);
    requireAdmin(actor);
    const route = (event.pathParameters?.['proxy'] ?? '').replace(/^\/+|\/+$/g, '');
    switch (route) {
      case 'orgs':
        return handleOrgs(actor, event);
      case 'locations':
        return handleLocations(actor, event);
      case 'users':
        return handleUsers(actor, event);
      case 'reset-count':
        return handleResetCount(actor, event);
      case 'audit-export':
        return handleAuditExport(event);
      default:
        throw notFound(`Unknown admin route: ${route || '(empty)'}`);
    }
  });
}
