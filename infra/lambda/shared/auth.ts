import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { forbidden, unauthorized } from './errors';

export const ADMIN_GROUP = 'admins';

export interface Claims {
  sub: string;
  /** custom:orgId. Absent for principals that were never assigned to an organisation (admins may be). */
  orgId?: string;
  lang?: 'ko' | 'en';
  groups: string[];
  email?: string;
}

/** Claims with a guaranteed organisation, as every end-user route requires. */
export type OrgClaims = Claims & { orgId: string };

type ClaimValue = string | number | boolean | string[] | undefined;

function asString(v: ClaimValue): string | undefined {
  if (typeof v === 'string') return v.trim() === '' ? undefined : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/** cognito:groups arrives as a JSON array in the payload but HTTP API may serialise it as "[admins]" or "admins". */
export function parseGroups(v: ClaimValue): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== 'string') return [];
  const s = v.trim();
  if (s === '') return [];
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1);
    try {
      const parsed = JSON.parse(s) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // fall through: API Gateway renders arrays as "[a b]" without quotes
    }
    return inner
      .split(/[\s,]+/)
      .map((g) => g.trim())
      .filter((g) => g !== '');
  }
  return s
    .split(',')
    .map((g) => g.trim())
    .filter((g) => g !== '');
}

/** Extract claims from the HTTP API JWT authorizer context. Missing authorizer or sub is a 401. */
export function getClaims(event: Pick<APIGatewayProxyEventV2WithJWTAuthorizer, 'requestContext'>): Claims {
  const claims = event.requestContext?.authorizer?.jwt?.claims as Record<string, ClaimValue> | undefined;
  if (!claims) throw unauthorized();
  const sub = asString(claims['sub']);
  if (!sub) throw unauthorized('JWT is missing the sub claim');
  const langRaw = asString(claims['custom:lang']);
  const lang = langRaw === 'ko' || langRaw === 'en' ? langRaw : undefined;
  return {
    sub,
    orgId: asString(claims['custom:orgId']),
    lang,
    groups: parseGroups(claims['cognito:groups']),
    email: asString(claims['email']),
  };
}

/**
 * End-user routes: the caller must belong to an organisation. A user without custom:orgId has no
 * data to see, so this is reported like an inactive organisation (403 FORBIDDEN / ORG_INACTIVE).
 */
export function getOrgClaims(
  event: Pick<APIGatewayProxyEventV2WithJWTAuthorizer, 'requestContext'>,
): OrgClaims {
  const claims = getClaims(event);
  if (!claims.orgId) throw forbidden('ORG_INACTIVE', 'User is not assigned to an organisation');
  return { ...claims, orgId: claims.orgId };
}

export function isAdmin(claims: Claims): boolean {
  return claims.groups.includes(ADMIN_GROUP);
}

/** R6.5: admin routes require membership of the Cognito `admins` group. */
export function requireAdmin(claims: Claims): void {
  if (!isAdmin(claims)) throw forbidden('NOT_ADMIN', 'Administrator group membership required');
}
