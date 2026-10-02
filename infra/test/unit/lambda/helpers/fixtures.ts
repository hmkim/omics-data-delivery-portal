/**
 * Test fixtures: environment, HTTP API v2 events and JWT claims. Import this module FIRST in every
 * handler test so the env is populated before the handler's cold-start `requireEnv` calls run.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import {
  LAMBDA_ENV,
  ORIGIN_VERIFY_HEADER,
  VIEWER_ADDRESS_HEADER,
  VIEWER_COUNTRY_HEADER,
} from '@genome-portal/contract';

export const TEST = {
  accountId: '111111111111',
  region: 'ap-northeast-2',
  bucket: 'genome-portal-data-111111111111-ap-northeast-2',
  cfDomain: 'd111example.cloudfront.net',
  keyPairId: 'K1TESTKEYPAIR',
  originSecret: 'origin-verify-secret-value-0123456789abcdef',
  granteeRoleArn: 'arn:aws:iam::111111111111:role/genome-portal-grantee-role',
  locationId: 'loc-0123456789abcdef',
  userPoolId: 'ap-northeast-2_TESTPOOL',
  orgsTable: 'genome-portal-orgs',
  downloadsTable: 'genome-portal-object-downloads',
  auditTable: 'genome-portal-audit-events',
} as const;

export function installEnv(): void {
  const values: Record<keyof typeof LAMBDA_ENV, string> = {
    ACCOUNT_ID: TEST.accountId,
    REGION: TEST.region,
    ORGS_TABLE: TEST.orgsTable,
    DOWNLOADS_TABLE: TEST.downloadsTable,
    AUDIT_TABLE: TEST.auditTable,
    DATA_BUCKET: TEST.bucket,
    ACCESS_GRANTS_INSTANCE_ARN: 'arn:aws:s3:ap-northeast-2:111111111111:access-grants/default',
    ACCESS_GRANTS_LOCATION_ID: TEST.locationId,
    GRANTEE_ROLE_ARN: TEST.granteeRoleArn,
    CF_DOMAIN: TEST.cfDomain,
    CF_KEY_PAIR_ID: TEST.keyPairId,
    CF_SIGNING_KEY_SECRET_ARN:
      'arn:aws:secretsmanager:ap-northeast-2:111111111111:secret:genome-portal/cf-signing-key',
    ORIGIN_VERIFY_SECRET_ARN:
      'arn:aws:secretsmanager:ap-northeast-2:111111111111:secret:genome-portal/origin-verify',
    USER_POOL_ID: TEST.userPoolId,
    METRICS_NAMESPACE: 'GenomePortalTest',
  };
  for (const [key, value] of Object.entries(values)) {
    process.env[LAMBDA_ENV[key as keyof typeof LAMBDA_ENV]] = value;
  }
}

installEnv();

export interface ClaimsInput {
  sub?: string;
  orgId?: string | null;
  groups?: string[] | string;
  lang?: string;
}

export interface EventInput {
  method?: string;
  path?: string;
  body?: unknown;
  rawBody?: string;
  claims?: ClaimsInput | null;
  headers?: Record<string, string>;
  pathParameters?: Record<string, string>;
  withOrigin?: boolean;
}

export const USER_A: ClaimsInput & { sub: string; orgId: string } = { sub: 'sub-user-a', orgId: 'org-a' };
export const USER_B: ClaimsInput & { sub: string; orgId: string } = { sub: 'sub-user-b', orgId: 'org-b' };
export const ADMIN: ClaimsInput & { sub: string; groups: string[] } = {
  sub: 'sub-admin',
  groups: ['admins'],
};

export function makeEvent(input: EventInput = {}): APIGatewayProxyEventV2WithJWTAuthorizer {
  const claims: Record<string, string | string[]> = {};
  if (input.claims !== null) {
    const c: ClaimsInput = input.claims ?? USER_A;
    if (c.sub) claims['sub'] = c.sub;
    if (c.orgId) claims['custom:orgId'] = c.orgId;
    if (c.groups !== undefined) claims['cognito:groups'] = c.groups;
    if (c.lang) claims['custom:lang'] = c.lang;
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [VIEWER_ADDRESS_HEADER]: '203.0.113.7:51234',
    [VIEWER_COUNTRY_HEADER]: 'KR',
    ...(input.withOrigin === false ? {} : { [ORIGIN_VERIFY_HEADER]: TEST.originSecret }),
    ...(input.headers ?? {}),
  };
  const body = input.rawBody ?? (input.body === undefined ? undefined : JSON.stringify(input.body));
  return {
    version: '2.0',
    routeKey: `${input.method ?? 'POST'} ${input.path ?? '/api/test'}`,
    rawPath: input.path ?? '/api/test',
    rawQueryString: '',
    headers,
    requestContext: {
      accountId: TEST.accountId,
      apiId: 'api123',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: input.method ?? 'POST',
        path: input.path ?? '/api/test',
        protocol: 'HTTP/1.1',
        sourceIp: '10.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'req-1',
      routeKey: `${input.method ?? 'POST'} ${input.path ?? '/api/test'}`,
      stage: '$default',
      time: '01/Jan/2026:00:00:00 +0000',
      timeEpoch: 1_767_225_600_000,
      authorizer:
        input.claims === null
          ? (undefined as never)
          : { principalId: 'p', integrationLatency: 1, jwt: { claims, scopes: null } },
    },
    pathParameters: input.pathParameters,
    body,
    isBase64Encoded: false,
  } as APIGatewayProxyEventV2WithJWTAuthorizer;
}

export function parseResult(result: {
  statusCode?: number;
  body?: string;
  headers?: Record<string, unknown>;
}) {
  return {
    status: result.statusCode,
    headers: result.headers ?? {},
    json: result.body ? (JSON.parse(result.body) as Record<string, unknown>) : undefined,
  };
}
