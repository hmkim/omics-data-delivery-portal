import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import {
  OBJECT_STATUS_MAX_ITEMS,
  keys,
  nextPathForCount,
  type ObjectStatusItem,
  type ObjectStatusResponse,
} from '@genome-portal/contract';
import { z } from 'zod';
import { getOrgClaims } from '../shared/auth';
import { ddbClient } from '../shared/clients';
import { getSettings } from '../shared/config';
import { denied } from '../shared/deny';
import { requireEnv } from '../shared/env';
import { badRequest, parseBody, respond } from '../shared/errors';
import { isOrgActive, listOrgLocations, longestMatchingLocation } from '../shared/orgs';
import { verifyOrigin } from '../shared/originVerify';

const DOWNLOADS_TABLE = requireEnv('DOWNLOADS_TABLE');
requireEnv('ORGS_TABLE');
requireEnv('AUDIT_TABLE');
requireEnv('ORIGIN_VERIFY_SECRET_ARN');

/** DynamoDB BatchGetItem accepts at most 100 keys per call. */
export const BATCH_GET_LIMIT = 100;
export const UNPROCESSED_RETRIES = 3;

const bodySchema = z.object({
  items: z.array(z.object({ bucket: z.string().min(1), key: z.string().min(1) })),
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Read `count` for many objects, chunking at 100 keys and retrying UnprocessedKeys with backoff.
 * Returns a map from pk to count (missing items are absent from the map).
 */
export async function batchGetCounts(
  pks: readonly string[],
  retryDelaysMs: readonly number[] = [50, 200, 800],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const unique = Array.from(new Set(pks));
  for (let i = 0; i < unique.length; i += BATCH_GET_LIMIT) {
    let pending: Array<Record<string, unknown>> = unique.slice(i, i + BATCH_GET_LIMIT).map((pk) => ({ pk }));
    for (let attempt = 0; pending.length > 0; attempt += 1) {
      const out = await ddbClient().send(
        new BatchGetCommand({
          RequestItems: {
            [DOWNLOADS_TABLE]: {
              Keys: pending,
              ProjectionExpression: 'pk, #c',
              ExpressionAttributeNames: { '#c': 'count' },
            },
          },
        }),
      );
      for (const item of out.Responses?.[DOWNLOADS_TABLE] ?? []) {
        const rec = item as Record<string, unknown>;
        if (typeof rec['pk'] === 'string')
          counts.set(rec['pk'], typeof rec['count'] === 'number' ? rec['count'] : 0);
      }
      pending = (out.UnprocessedKeys?.[DOWNLOADS_TABLE]?.Keys ?? []) as Array<Record<string, unknown>>;
      if (pending.length === 0) break;
      if (attempt >= UNPROCESSED_RETRIES) throw new Error('BatchGetItem left keys unprocessed after retries');
      await sleep(retryDelaysMs[attempt] ?? 0);
    }
  }
  return counts;
}

/** POST /api/objects/status (R3.5): download count and next path per object, at most 100 per call. */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  return respond(async () => {
    const viewer = await verifyOrigin(event);
    const claims = getOrgClaims(event);
    const body = parseBody(event, bodySchema);
    if (body.items.length > OBJECT_STATUS_MAX_ITEMS)
      throw badRequest(`At most ${OBJECT_STATUS_MAX_ITEMS} items per request`);

    if (!(await isOrgActive(claims.orgId))) {
      throw await denied(
        'ORG_INACTIVE',
        { userSub: claims.sub, orgId: claims.orgId, ...viewer },
        'Organisation is inactive',
      );
    }
    // R2.3: only objects inside the caller's assigned locations are reported; anything else is dropped silently.
    const locations = await listOrgLocations(claims.orgId);
    const visible = body.items.filter(
      (it) => longestMatchingLocation(locations, it.bucket, it.key) !== undefined,
    );

    const settings = await getSettings();
    const counts = await batchGetCounts(visible.map((it) => keys.obj(it.bucket, it.key)));
    const items: ObjectStatusItem[] = visible.map((it) => {
      const count = counts.get(keys.obj(it.bucket, it.key)) ?? 0;
      return {
        bucket: it.bucket,
        key: it.key,
        count,
        nextPath: nextPathForCount(count, settings.cfThreshold),
      };
    });
    const response: ObjectStatusResponse = { items };
    return { body: response };
  });
}
