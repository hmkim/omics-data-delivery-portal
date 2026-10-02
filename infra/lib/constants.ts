/**
 * Infra-side view of the shared contract. CDK code imports from here so every threshold,
 * SSM name and table name has exactly one source (contract/src/index.ts).
 */
export {
  API_BASE,
  AUDIT_TTL_DAYS,
  CF_THRESHOLD,
  GSI_NAMES,
  ID_TOKEN_VALIDITY_MINUTES,
  LAMBDA_ENV,
  METRICS_NAMESPACE,
  ORIGIN_VERIFY_HEADER,
  PROJECT_TAG,
  REFRESH_TOKEN_VALIDITY_HOURS,
  RESOURCE_PREFIX,
  SECRET_NAMES,
  SINGLE_OBJECT_LIMIT_BYTES,
  SPLIT_THRESHOLD_BYTES,
  SSM_DEFAULTS,
  SSM_PARAMS,
  TABLE_NAMES,
  URL_TTL_SECONDS,
} from '@genome-portal/contract';

/** Stack ids in deployment order (README): auth -> waf -> cdn -> cdn-logs (us-east-1) -> data -> api -> web -> ops */
export const STACK_IDS = {
  auth: 'genome-portal-auth',
  waf: 'genome-portal-waf',
  cdn: 'genome-portal-cdn',
  cdnLogs: 'genome-portal-cdn-logs',
  data: 'genome-portal-data',
  api: 'genome-portal-api',
  web: 'genome-portal-web',
  ops: 'genome-portal-ops',
} as const;

/** Name helpers: every physical name goes through here so the prefix aspect always passes. */
export const names = {
  dataBucket: (account: string, region: string) => `genome-portal-data-${account}-${region}`,
  /** S3 server access logs of the data bucket (design §8: detect out-of-portal access by IP / User-Agent). */
  s3AccessLogsBucket: (account: string, region: string) =>
    `genome-portal-s3-access-logs-${account}-${region}`,
  cfLogsBucket: (account: string) => `genome-portal-cf-logs-${account}`,
  webBucket: (account: string, region: string) => `genome-portal-web-${account}-${region}`,
  athenaBucket: (account: string) => `genome-portal-athena-${account}`,
  auditArchiveBucket: (account: string) => `genome-portal-audit-archive-${account}`,
  locationRole: 'genome-portal-ag-location-role',
  granteeRole: 'genome-portal-grantee-role',
  adminRole: 'genome-portal-admin-role',
  readOnlyRole: 'genome-portal-readonly-role',
  userPool: 'genome-portal-users',
  userPoolClient: 'genome-portal-spa',
  adminsGroup: 'admins',
  webAcl: 'genome-portal-data-cdn-acl',
  alertTopic: 'genome-portal-alerts',
  dashboard: 'genome-portal-ops',
  kmsAlias: 'alias/genome-portal-data',
  signingPublicKey: 'genome-portal-cf-signing-key',
  signingKeyGroup: 'genome-portal-cf-key-group',
  httpApi: 'genome-portal-api',
  apiAccessLogGroup: '/genome-portal/api-access',
  /** Lambda function names (FunctionName). */
  fn: (handler: string) => `genome-portal-${handler}`,
  glueDatabase: 'genome-portal-logs',
  glueTable: 'genome-portal-cf-access-logs',
  athenaWorkGroup: 'genome-portal-ops',
  cfLogDeliverySource: 'genome-portal-cf-data-logs',
  cfLogDeliveryDestination: 'genome-portal-cf-logs-s3',
} as const;

/** CloudFront Pro flat-rate monthly allowance (R7.3): 50 TiB. */
export const CF_MONTHLY_ALLOWANCE_BYTES = 50 * 1024 ** 4;

/** CloudFront standard logging v2 (parquet) record fields the ops job needs (design §7.1). */
export const CF_LOG_FIELDS = [
  'date',
  'time',
  'x-edge-location',
  'sc-bytes',
  'c-ip',
  'cs-method',
  'cs(Host)',
  'cs-uri-stem',
  'sc-status',
  'cs(User-Agent)',
  'x-edge-result-type',
  'x-edge-request-id',
  'cs-protocol',
  'cs-bytes',
  'time-taken',
  'x-edge-response-result-type',
  'x-edge-detailed-result-type',
  'sc-content-len',
  'sc-range-start',
  'sc-range-end',
  'c-country',
  'cache-behavior-path-pattern',
] as const;

/** Local dev origin allowed by the HTTP API CORS config (T1.9). */
export const LOCAL_DEV_ORIGIN = 'http://localhost:5173';
