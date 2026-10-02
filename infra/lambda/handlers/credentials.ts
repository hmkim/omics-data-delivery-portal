import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { grantScopeFor, parseScope, type CredentialsResponse } from '@genome-portal/contract';
import { z } from 'zod';
import { browseAuditContext, getDataAccess } from '../shared/accessGrants';
import { getOrgClaims } from '../shared/auth';
import { auditingNoGrant, denied } from '../shared/deny';
import { requireEnv } from '../shared/env';
import { badRequest, parseBody, respond } from '../shared/errors';
import { isLocationAssigned, isOrgActive } from '../shared/orgs';
import { verifyOrigin } from '../shared/originVerify';

/** Design §2.4 step 3: browsing credentials always live 1 hour, independent of url-ttl-seconds. */
export const BROWSE_CREDENTIALS_SECONDS = 3600;

const DATA_BUCKET = requireEnv('DATA_BUCKET');
requireEnv('ACCOUNT_ID');
requireEnv('ORGS_TABLE');
requireEnv('AUDIT_TABLE');
requireEnv('ORIGIN_VERIFY_SECRET_ARN');

const bodySchema = z.object({
  scope: z.string().min(1),
  permission: z.string().min(1),
});

/** POST /api/credentials -- Storage Browser getLocationCredentials (design §2.4). */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  return respond(async () => {
    const viewer = await verifyOrigin(event);
    const claims = getOrgClaims(event);
    const body = parseBody(event, bodySchema);
    const ctx = { userSub: claims.sub, orgId: claims.orgId, ...viewer };

    // 1. READ only (D2-A) and a well-formed scope inside the data bucket.
    if (body.permission !== 'READ') throw badRequest('Only READ permission is supported', 'READ_ONLY');
    const scope = parseScope(body.scope, DATA_BUCKET);
    if (!scope)
      throw await denied(
        'BAD_SCOPE',
        { ...ctx, detail: { scope: body.scope } },
        'Malformed or out-of-bucket scope',
      );

    // 2. The organisation must be active and the location assigned to it.
    if (!(await isOrgActive(claims.orgId)))
      throw await denied('ORG_INACTIVE', ctx, 'Organisation is inactive');
    if (!(await isLocationAssigned(claims.orgId, scope.bucket, scope.prefix))) {
      throw await denied(
        'NOT_ASSIGNED',
        { ...ctx, bucket: scope.bucket, key: scope.prefix },
        'Location is not assigned to your organisation',
      );
    }

    // 3. Access Grants issues the prefix-scoped credentials.
    const creds = await auditingNoGrant({ ...ctx, bucket: scope.bucket, key: scope.prefix }, () =>
      getDataAccess({
        target: grantScopeFor(scope.bucket, scope.prefix),
        durationSeconds: BROWSE_CREDENTIALS_SECONDS,
        auditContext: browseAuditContext(claims.sub, claims.orgId),
      }),
    );

    const response: CredentialsResponse = {
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
        expiration: creds.expiration.toISOString(),
      },
    };
    return { body: response };
  });
}
