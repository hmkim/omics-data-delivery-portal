import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { keys } from '@genome-portal/contract';
import { ddbClient } from './clients';
import { requireEnv } from './env';

export interface OrgMeta {
  orgId: string;
  name: string;
  active: boolean;
  createdAt?: string;
}

export interface OrgLocation {
  bucket: string;
  prefix: string;
  label?: string;
  assignedAt?: string;
}

const LOC_PREFIX = 'LOC#';

/** ORG#<orgId> / META, or undefined when the organisation does not exist. */
export async function getOrg(orgId: string): Promise<OrgMeta | undefined> {
  const out = await ddbClient().send(
    new GetCommand({ TableName: requireEnv('ORGS_TABLE'), Key: { pk: keys.org(orgId), sk: keys.orgMeta } }),
  );
  const item = out.Item as Record<string, unknown> | undefined;
  if (!item) return undefined;
  return {
    orgId,
    name: typeof item['name'] === 'string' ? item['name'] : orgId,
    active: item['active'] === true,
    createdAt: typeof item['createdAt'] === 'string' ? item['createdAt'] : undefined,
  };
}

/** True only when the organisation exists and is active. */
export async function isOrgActive(orgId: string): Promise<boolean> {
  const org = await getOrg(orgId);
  return org?.active === true;
}

function toLocation(item: Record<string, unknown>): OrgLocation | undefined {
  const bucket = item['bucket'];
  const prefix = item['prefix'];
  if (typeof bucket !== 'string' || typeof prefix !== 'string') return undefined;
  return {
    bucket,
    prefix,
    label: typeof item['label'] === 'string' ? item['label'] : undefined,
    assignedAt: typeof item['assignedAt'] === 'string' ? item['assignedAt'] : undefined,
  };
}

/** All locations assigned to an organisation: Query ORG#<orgId>, begins_with(sk, 'LOC#'), following pagination. */
export async function listOrgLocations(orgId: string): Promise<OrgLocation[]> {
  const table = requireEnv('ORGS_TABLE');
  const items: OrgLocation[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const out = await ddbClient().send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :loc)',
        ExpressionAttributeValues: { ':pk': keys.org(orgId), ':loc': LOC_PREFIX },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const raw of out.Items ?? []) {
      const loc = toLocation(raw as Record<string, unknown>);
      if (loc) items.push(loc);
    }
    startKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return items;
}

/** Is exactly this (bucket, prefix) assigned to the organisation? One GetItem on ORG#/LOC#. */
export async function isLocationAssigned(orgId: string, bucket: string, prefix: string): Promise<boolean> {
  const out = await ddbClient().send(
    new GetCommand({
      TableName: requireEnv('ORGS_TABLE'),
      Key: { pk: keys.org(orgId), sk: keys.loc(bucket, prefix) },
      ProjectionExpression: 'pk',
    }),
  );
  return out.Item !== undefined;
}

/**
 * Longest-match: among the organisation's locations in `bucket`, the one whose prefix is the longest
 * prefix of `key`. Nested locations (projects/P1/ and projects/P1/sub/) both exist as grants, and
 * GetDataAccess picks the closest grant too, so the audit record names the same target.
 */
export function longestMatchingLocation(
  locations: readonly OrgLocation[],
  bucket: string,
  key: string,
): OrgLocation | undefined {
  let best: OrgLocation | undefined;
  for (const loc of locations) {
    if (loc.bucket !== bucket) continue;
    if (!key.startsWith(loc.prefix)) continue;
    if (!best || loc.prefix.length > best.prefix.length) best = loc;
  }
  return best;
}

/** Convenience: load the organisation's locations and resolve the one that covers `key`. */
export async function findAssignedLocation(
  orgId: string,
  bucket: string,
  key: string,
): Promise<OrgLocation | undefined> {
  const locations = await listOrgLocations(orgId);
  return longestMatchingLocation(locations, bucket, key);
}
