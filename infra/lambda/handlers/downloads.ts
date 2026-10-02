import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { keys, modeHintForSize, nextPathForCount, type DownloadResponse } from '@genome-portal/contract';
import { z } from 'zod';
import { downloadAuditContext, getDataAccess } from '../shared/accessGrants';
import { metrics, recordAudit } from '../shared/audit';
import { getOrgClaims } from '../shared/auth';
import { ddbClient } from '../shared/clients';
import { getSettings } from '../shared/config';
import { auditingNoGrant, denied } from '../shared/deny';
import { putDownloadMeta } from '../shared/downloadMeta';
import { requireEnv } from '../shared/env';
import { notFound, parseBody, respond } from '../shared/errors';
import { findAssignedLocation, isOrgActive } from '../shared/orgs';
import { verifyOrigin } from '../shared/originVerify';
import {
  filenameFromKey,
  headObject,
  presignS3GetObject,
  s3ClientFor,
  signCloudFrontUrl,
} from '../shared/signing';

const DATA_BUCKET = requireEnv('DATA_BUCKET');
const DOWNLOADS_TABLE = requireEnv('DOWNLOADS_TABLE');
requireEnv('ACCOUNT_ID');
requireEnv('ORGS_TABLE');
requireEnv('AUDIT_TABLE');
requireEnv('ORIGIN_VERIFY_SECRET_ARN');
requireEnv('CF_DOMAIN');
requireEnv('CF_KEY_PAIR_ID');
requireEnv('CF_SIGNING_KEY_SECRET_ARN');

const bodySchema = z.object({
  bucket: z.string().min(1),
  key: z
    .string()
    .min(1)
    .refine((k) => !k.endsWith('/'), 'key must name an object, not a folder'),
});

/**
 * Step 4 (R4.5): atomically increment the object's counter and learn the previous value.
 * Exactly one of two concurrent requests sees prevCount = 0.
 */
export async function incrementDownloadCount(
  bucket: string,
  key: string,
  meta: { sizeBytes: number; checksumCrc32?: string; now: Date },
): Promise<{ prevCount: number; count: number }> {
  const setParts = ['lastAt = :now', 'sizeBytes = :size'];
  const values: Record<string, unknown> = {
    ':one': 1,
    ':now': meta.now.toISOString(),
    ':size': meta.sizeBytes,
  };
  if (meta.checksumCrc32 !== undefined) {
    setParts.push('checksumCrc32 = :crc');
    values[':crc'] = meta.checksumCrc32;
  }
  const out = await ddbClient().send(
    new UpdateCommand({
      TableName: DOWNLOADS_TABLE,
      Key: { pk: keys.obj(bucket, key) },
      UpdateExpression: `ADD #c :one SET ${setParts.join(', ')}`,
      ExpressionAttributeNames: { '#c': 'count' },
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_OLD',
    }),
  );
  const prevRaw = (out.Attributes as Record<string, unknown> | undefined)?.['count'];
  const prevCount = typeof prevRaw === 'number' && Number.isFinite(prevRaw) ? prevRaw : 0;
  return { prevCount, count: prevCount + 1 };
}

/** POST /api/downloads (design §4 steps 1-8). */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  return respond(async () => {
    const viewer = await verifyOrigin(event);
    const claims = getOrgClaims(event);
    const body = parseBody(event, bodySchema);
    const ctx = { userSub: claims.sub, orgId: claims.orgId, bucket: body.bucket, key: body.key, ...viewer };

    // 1. Authorisation: active organisation and an assigned location covering the key.
    if (body.bucket !== DATA_BUCKET)
      throw await denied('NOT_ASSIGNED', ctx, 'Bucket is not served by this portal');
    if (!(await isOrgActive(claims.orgId)))
      throw await denied('ORG_INACTIVE', ctx, 'Organisation is inactive');
    const location = await findAssignedLocation(claims.orgId, body.bucket, body.key);
    if (!location) throw await denied('NOT_ASSIGNED', ctx, 'Object is outside your assigned locations');

    const settings = await getSettings();
    const downloadId = randomUUID();
    const now = new Date();

    // 2. Object-scoped credentials whose lifetime equals the URL lifetime.
    const creds = await auditingNoGrant(ctx, () =>
      getDataAccess({
        target: `s3://${body.bucket}/${body.key}`,
        targetType: 'Object',
        durationSeconds: settings.urlTtlSeconds,
        auditContext: downloadAuditContext(claims.sub, claims.orgId, downloadId),
      }),
    );

    // 3. Metadata through the same credentials. A missing object does not count as a download.
    const s3 = s3ClientFor(creds);
    const head = await headObject(s3, body.bucket, body.key);
    if (!head) throw notFound('Object not found');

    // 4. Atomic counter -> path decision (D4).
    const { prevCount, count } = await incrementDownloadCount(body.bucket, body.key, {
      sizeBytes: head.sizeBytes,
      checksumCrc32: head.checksumCrc32,
      now,
    });
    const path = nextPathForCount(prevCount, settings.cfThreshold);

    // 5. URL for the chosen path.
    const filename = filenameFromKey(body.key);
    let url: string;
    let expiresAt: Date;
    if (path === 'S3') {
      expiresAt = creds.expiration;
      url = await presignS3GetObject({
        client: s3,
        bucket: body.bucket,
        key: body.key,
        filename,
        expiresInSeconds: settings.urlTtlSeconds,
      });
    } else {
      expiresAt = new Date(now.getTime() + settings.urlTtlSeconds * 1000);
      url = await signCloudFrontUrl({ key: body.key, expiresAt });
    }

    // 6. Size hint; the browser planner makes the final call (design §5.4).
    const mode = modeHintForSize(head.sizeBytes, settings.splitThresholdBytes);

    // 7. Audit + renewal metadata.
    await recordAudit({
      type: 'DOWNLOAD_ISSUED',
      ...ctx,
      sizeBytes: head.sizeBytes,
      path,
      mode,
      downloadId,
      matchedGrantTarget: creds.matchedGrantTarget,
      detail: { count, location: `${location.bucket}/${location.prefix}` },
    });
    metrics.downloadIssued(path);
    metrics.bytesIssued(path, head.sizeBytes);
    await putDownloadMeta({
      downloadId,
      userSub: claims.sub,
      orgId: claims.orgId,
      bucket: body.bucket,
      key: body.key,
      path,
      issuedAt: now.toISOString(),
      renewCount: 0,
      matchedGrantTarget: creds.matchedGrantTarget,
    });

    // 8. Response.
    const response: DownloadResponse = {
      downloadId,
      url,
      path,
      mode,
      expiresAt: expiresAt.toISOString(),
      sizeBytes: head.sizeBytes,
      checksumCrc32: head.checksumCrc32,
      count,
      filename,
    };
    return { body: response };
  });
}
