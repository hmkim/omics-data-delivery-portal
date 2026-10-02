import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ListLocationsResponse, LocationItem } from '@genome-portal/contract';
import { getOrgClaims } from '../shared/auth';
import { denied } from '../shared/deny';
import { requireEnv } from '../shared/env';
import { respond } from '../shared/errors';
import { isOrgActive, listOrgLocations } from '../shared/orgs';
import { verifyOrigin } from '../shared/originVerify';

// Fail at cold start when the function is misconfigured.
requireEnv('ORGS_TABLE');
requireEnv('AUDIT_TABLE');
requireEnv('ORIGIN_VERIFY_SECRET_ARN');

/** GET /api/locations (design §6, R2.1): the caller's organisation's locations in Storage Browser shape. */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  return respond(async () => {
    const viewer = await verifyOrigin(event);
    const claims = getOrgClaims(event);
    if (!(await isOrgActive(claims.orgId))) {
      throw await denied(
        'ORG_INACTIVE',
        { userSub: claims.sub, orgId: claims.orgId, ...viewer },
        'Organisation is inactive',
      );
    }
    const locations = await listOrgLocations(claims.orgId);
    const items: LocationItem[] = locations.map((loc) => ({
      id: `${loc.bucket}/${loc.prefix}`,
      bucket: loc.bucket,
      prefix: loc.prefix,
      type: 'PREFIX',
      permissions: ['get', 'list'],
    }));
    const body: ListLocationsResponse = { items };
    return { body };
  });
}
