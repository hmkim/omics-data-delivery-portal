import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { RenewResponse } from '@genome-portal/contract';
import { downloadAuditContext, getDataAccess } from '../shared/accessGrants';
import { metrics, recordAudit } from '../shared/audit';
import { getOrgClaims } from '../shared/auth';
import { getSettings } from '../shared/config';
import { auditingNoGrant, denied } from '../shared/deny';
import { getDownloadMeta, incrementRenewCount } from '../shared/downloadMeta';
import { requireEnv } from '../shared/env';
import { badRequest, notFound, parseBody, respond } from '../shared/errors';
import { verifyOrigin } from '../shared/originVerify';
import { filenameFromKey, presignS3GetObject, s3ClientFor, signCloudFrontUrl } from '../shared/signing';
import { z } from 'zod';

requireEnv('ACCOUNT_ID');
requireEnv('AUDIT_TABLE');
requireEnv('ORIGIN_VERIFY_SECRET_ARN');
requireEnv('CF_DOMAIN');
requireEnv('CF_KEY_PAIR_ID');
requireEnv('CF_SIGNING_KEY_SECRET_ARN');

const optionalBody = z.object({}).passthrough().optional();

/**
 * POST /api/downloads/{id}/renew (R4.6, R5.5): re-issue a URL on the SAME path the download was
 * issued with. Never increments the download counter.
 */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  return respond(async () => {
    const viewer = await verifyOrigin(event);
    const claims = getOrgClaims(event);
    const downloadId = event.pathParameters?.['id'];
    if (!downloadId) throw badRequest('Missing download id');
    if (event.body) parseBody(event, optionalBody); // tolerate an empty JSON body, reject garbage

    const meta = await getDownloadMeta(downloadId);
    if (!meta) throw notFound('Unknown or expired download');
    const ctx = {
      userSub: claims.sub,
      orgId: claims.orgId,
      bucket: meta.bucket,
      key: meta.key,
      downloadId,
      ...viewer,
    };
    if (meta.userSub !== claims.sub) throw await denied('NOT_OWNER', ctx, 'Download belongs to another user');

    const settings = await getSettings();
    const now = new Date();
    let url: string;
    let expiresAt: Date;
    if (meta.path === 'S3') {
      const creds = await auditingNoGrant(ctx, () =>
        getDataAccess({
          target: `s3://${meta.bucket}/${meta.key}`,
          targetType: 'Object',
          durationSeconds: settings.urlTtlSeconds,
          auditContext: downloadAuditContext(claims.sub, claims.orgId, downloadId),
        }),
      );
      expiresAt = creds.expiration;
      url = await presignS3GetObject({
        client: s3ClientFor(creds),
        bucket: meta.bucket,
        key: meta.key,
        filename: filenameFromKey(meta.key),
        expiresInSeconds: settings.urlTtlSeconds,
      });
    } else {
      expiresAt = new Date(now.getTime() + settings.urlTtlSeconds * 1000);
      url = await signCloudFrontUrl({ key: meta.key, expiresAt });
    }

    const renewCount = await incrementRenewCount(downloadId);
    await recordAudit({ type: 'URL_RENEWED', ...ctx, path: meta.path, detail: { renewCount } });
    metrics.urlRenewed();

    const response: RenewResponse = {
      downloadId,
      url,
      path: meta.path,
      expiresAt: expiresAt.toISOString(),
      renewCount,
    };
    return { body: response };
  });
}
