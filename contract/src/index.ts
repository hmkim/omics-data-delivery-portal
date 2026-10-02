/**
 * Shared contract for the genome data delivery portal.
 *
 * Everything that must agree between the CDK app (infra), the Lambda handlers (infra/lambda),
 * the SPA (web) and the admin CLI (tools) lives here. Do not duplicate these values elsewhere:
 * CDK writes the constants to SSM and to the SPA's config.json, Lambdas read SSM, the SPA reads config.json.
 *
 * References: design.md §3 (settings), §4 (download API), §6 (routes), §7.3 (admin API).
 */

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Prefix for every physical resource name (N7). Customer names never appear in identifiers. */
export const RESOURCE_PREFIX = 'genome-portal';
export const PROJECT_TAG = { key: 'Project', value: 'genome-portal' } as const;

// ---------------------------------------------------------------------------
// Runtime settings (defaults; the deployed values live in SSM and config.json)
// ---------------------------------------------------------------------------

/** D4-A: downloads with prevCount >= CF_THRESHOLD go to CloudFront. 0 = every download via CloudFront (D4-B). */
export const CF_THRESHOLD = 1;
/** R4.6: signed URL lifetime. Applied to GetDataAccess DurationSeconds (S3 path) and dateLessThan (CF path). */
export const URL_TTL_SECONDS = 3600;
export const URL_TTL_MIN_SECONDS = 900;
export const URL_TTL_MAX_SECONDS = 43_200;
/** D5-A / R5.1: above this size a File-System-Access browser uses the split engine (resume + auto renew). 1 GiB. */
export const SPLIT_THRESHOLD_BYTES = 1_073_741_824;
/** R5.1: CloudFront single-object limit, decimal 50 GB. Above it: no zip, command fallback without FS Access. */
export const SINGLE_OBJECT_LIMIT_BYTES = 50_000_000_000;
/** R5.2: Range part size (8 GiB) and parallelism. */
export const PART_SIZE_BYTES = 8 * 1024 ** 3;
export const MAX_PARALLEL_PARTS = 4;
/** R4.9 */
export const ZIP_MAX_FILES = 5000;
/** R3.5 / objectStatus batch size */
export const OBJECT_STATUS_MAX_ITEMS = 100;
/** R1.5 */
export const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_VALIDITY_HOURS = 24;
export const ID_TOKEN_VALIDITY_MINUTES = 60;
/** R5.5: renew this long before expiresAt */
export const RENEW_LEAD_MS = 5 * 60 * 1000;
/** R3.4 */
export const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
/** R3.1 */
export const LIST_PAGE_SIZE = 100;

export const SSM_PARAMS = {
  cfThreshold: '/genome-portal/cf-threshold',
  urlTtlSeconds: '/genome-portal/url-ttl-seconds',
  splitThresholdBytes: '/genome-portal/split-threshold-bytes',
  singleObjectLimitBytes: '/genome-portal/single-object-limit-bytes',
} as const;

export const SSM_DEFAULTS: Record<keyof typeof SSM_PARAMS, string> = {
  cfThreshold: String(CF_THRESHOLD),
  urlTtlSeconds: String(URL_TTL_SECONDS),
  splitThresholdBytes: String(SPLIT_THRESHOLD_BYTES),
  singleObjectLimitBytes: String(SINGLE_OBJECT_LIMIT_BYTES),
};

/** Runtime settings as the Lambdas see them after reading SSM (config.ts, 60 s cache). */
export interface RuntimeSettings {
  cfThreshold: number;
  urlTtlSeconds: number;
  splitThresholdBytes: number;
  singleObjectLimitBytes: number;
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

/** The SPA calls the API through the web distribution's /api/* behaviour (same origin). */
export const API_BASE = '/api';
/** Secret header CloudFront adds on the /api/* origin request; Lambda rejects requests without it (design §6). */
export const ORIGIN_VERIFY_HEADER = 'x-origin-verify';
export const VIEWER_ADDRESS_HEADER = 'cloudfront-viewer-address';
export const VIEWER_COUNTRY_HEADER = 'cloudfront-viewer-country';

export const ROUTES = {
  locations: `${API_BASE}/locations`,
  credentials: `${API_BASE}/credentials`,
  downloads: `${API_BASE}/downloads`,
  renew: (downloadId: string) => `${API_BASE}/downloads/${encodeURIComponent(downloadId)}/renew`,
  objectStatus: `${API_BASE}/objects/status`,
  adminOrgs: `${API_BASE}/admin/orgs`,
  adminLocations: `${API_BASE}/admin/locations`,
  adminUsers: `${API_BASE}/admin/users`,
  adminResetCount: `${API_BASE}/admin/reset-count`,
  adminAuditExport: `${API_BASE}/admin/audit-export`,
} as const;

// ---------------------------------------------------------------------------
// config.json served to the SPA (written by the web stack, design §1 / §5)
// ---------------------------------------------------------------------------

export type MfaMode = 'REQUIRED' | 'OPTIONAL';

export interface BrandConfig {
  name: string;
  logoUrl: string;
  primaryColor: string;
}

export interface PortalConfig {
  region: string;
  accountId: string;
  userPoolId: string;
  clientId: string;
  /** Always API_BASE; kept in config so local dev can point elsewhere. */
  apiBase: string;
  dataBucket: string;
  cfDomain: string;
  splitThresholdBytes: number;
  singleObjectLimitBytes: number;
  mfaMode: MfaMode;
  brand: BrandConfig;
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type DownloadPath = 'S3' | 'CF';
/** Server-side size hint (design §4 step 6). */
export type ModeHint = 'single' | 'split';
/** Client planner outcome (design §5.4). */
export type ClientMode = 'single' | 'split' | 'command';
/** How the download was actually delivered, for audit (design §3). */
export type DownloadMode = 'single' | 'zip' | 'split' | 'command';

export type AuditEventType =
  | 'DOWNLOAD_ISSUED'
  | 'URL_RENEWED'
  | 'ACCESS_DENIED'
  | 'LOGIN_SUCCESS'
  | 'ORG_CREATED'
  | 'ORG_DISABLED'
  | 'LOCATION_ASSIGNED'
  | 'LOCATION_UNASSIGNED'
  | 'USER_CREATED'
  | 'USER_DISABLED'
  | 'USER_ENABLED'
  | 'USER_DELETED'
  | 'COUNT_RESET';

export type AccessDeniedReason =
  'NOT_ASSIGNED' | 'NO_GRANT' | 'BAD_SCOPE' | 'NOT_OWNER' | 'ORG_INACTIVE' | 'NOT_ADMIN';

export interface AuditEvent {
  type: AuditEventType;
  at: string;
  userSub?: string;
  orgId?: string;
  bucket?: string;
  key?: string;
  sizeBytes?: number;
  path?: DownloadPath;
  mode?: DownloadMode;
  ip?: string;
  country?: string;
  downloadId?: string;
  matchedGrantTarget?: string;
  reason?: AccessDeniedReason;
  detail?: Record<string, string | number | boolean>;
}

// ---------------------------------------------------------------------------
// API request / response shapes
// ---------------------------------------------------------------------------

/** GET /api/locations -- Storage Browser listLocations shape */
export interface LocationItem {
  id: string;
  bucket: string;
  prefix: string;
  type: 'PREFIX';
  permissions: Array<'get' | 'list'>;
}
export interface ListLocationsResponse {
  items: LocationItem[];
  nextToken?: string;
}

/** POST /api/credentials -- Storage Browser getLocationCredentials shape */
export interface CredentialsRequest {
  scope: string; // s3://bucket/prefix*
  permission: 'READ' | 'READWRITE';
}
export interface CredentialsResponse {
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    /** ISO-8601; the SPA converts to Date */
    expiration: string;
  };
}

/** POST /api/downloads */
export interface DownloadRequest {
  bucket: string;
  key: string;
}
export interface DownloadResponse {
  downloadId: string;
  url: string;
  path: DownloadPath;
  mode: ModeHint;
  /** ISO-8601 */
  expiresAt: string;
  sizeBytes: number;
  /** base64 CRC32 (full-object) when recorded at upload time */
  checksumCrc32?: string;
  /** count after this issue (1 for the first download) */
  count: number;
  filename: string;
}

/** POST /api/downloads/{id}/renew */
export interface RenewResponse {
  downloadId: string;
  url: string;
  path: DownloadPath;
  expiresAt: string;
  renewCount: number;
}

/** POST /api/objects/status */
export interface ObjectStatusRequest {
  items: Array<{ bucket: string; key: string }>;
}
export interface ObjectStatusItem {
  bucket: string;
  key: string;
  count: number;
  nextPath: DownloadPath;
}
export interface ObjectStatusResponse {
  items: ObjectStatusItem[];
}

/** Error body for every non-2xx response */
export interface ApiError {
  error: string; // e.g. 'FORBIDDEN', 'BAD_REQUEST', 'NOT_FOUND', 'UNAVAILABLE'
  reason?: AccessDeniedReason | string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Admin API (design §7.3). All routes: POST, JWT must carry cognito:groups=admins.
// ---------------------------------------------------------------------------

export type AdminOrgRequest =
  { action: 'create'; orgId: string; name: string } | { action: 'disable'; orgId: string };

export type AdminLocationRequest =
  | { action: 'assign'; orgId: string; bucket: string; prefix: string; label?: string }
  | { action: 'unassign'; orgId: string; bucket: string; prefix: string }
  | { action: 'unassign-all' }
  | { action: 'list'; orgId?: string };

export type AdminUserRequest =
  | { action: 'create'; email: string; orgId: string; lang: 'ko' | 'en' }
  | { action: 'disable'; email: string }
  | { action: 'enable'; email: string }
  | { action: 'delete'; email: string };

export interface AdminResetCountRequest {
  bucket: string;
  key: string;
}

export interface AdminAuditExportRequest {
  /** YYYY-MM-DD (UTC day partition) */
  day: string;
  nextToken?: string;
}
export interface AdminAuditExportResponse {
  items: AuditEvent[];
  nextToken?: string;
}

export interface LocationRecord {
  bucket: string;
  prefix: string;
  label?: string;
  accessGrantId?: string;
  grantScope: string;
  orgIds: string[];
}
export interface AdminLocationListResponse {
  items: LocationRecord[];
}

// ---------------------------------------------------------------------------
// DynamoDB key helpers (design §3)
// ---------------------------------------------------------------------------

export const keys = {
  org: (orgId: string) => `ORG#${orgId}`,
  orgMeta: 'META',
  loc: (bucket: string, prefix: string) => `LOC#${bucket}/${prefix}`,
  obj: (bucket: string, key: string) => `OBJ#${bucket}/${key}`,
  day: (isoDate: string) => `DAY#${isoDate}`,
  ts: (iso: string, uuid: string) => `TS#${iso}#${uuid}`,
  dl: (downloadId: string) => `DL#${downloadId}`,
} as const;

export const TABLE_NAMES = {
  orgs: `${RESOURCE_PREFIX}-orgs`,
  objectDownloads: `${RESOURCE_PREFIX}-object-downloads`,
  auditEvents: `${RESOURCE_PREFIX}-audit-events`,
} as const;

export const GSI_NAMES = {
  byUser: 'byUser',
  inverted: 'inverted',
} as const;

/** DL# meta TTL (design §3) */
export const DOWNLOAD_META_TTL_DAYS = 7;
/** audit-events TTL; the daily export to Glacier IR keeps records beyond that (R7.1) */
export const AUDIT_TTL_DAYS = 400;

// ---------------------------------------------------------------------------
// Lambda environment variable names (set by the api stack, read by handlers)
// ---------------------------------------------------------------------------

export const LAMBDA_ENV = {
  ACCOUNT_ID: 'ACCOUNT_ID',
  REGION: 'PORTAL_REGION',
  ORGS_TABLE: 'ORGS_TABLE',
  DOWNLOADS_TABLE: 'DOWNLOADS_TABLE',
  AUDIT_TABLE: 'AUDIT_TABLE',
  DATA_BUCKET: 'DATA_BUCKET',
  ACCESS_GRANTS_INSTANCE_ARN: 'ACCESS_GRANTS_INSTANCE_ARN',
  ACCESS_GRANTS_LOCATION_ID: 'ACCESS_GRANTS_LOCATION_ID',
  GRANTEE_ROLE_ARN: 'GRANTEE_ROLE_ARN',
  CF_DOMAIN: 'CF_DOMAIN',
  CF_KEY_PAIR_ID: 'CF_KEY_PAIR_ID',
  CF_SIGNING_KEY_SECRET_ARN: 'CF_SIGNING_KEY_SECRET_ARN',
  ORIGIN_VERIFY_SECRET_ARN: 'ORIGIN_VERIFY_SECRET_ARN',
  USER_POOL_ID: 'USER_POOL_ID',
  METRICS_NAMESPACE: 'METRICS_NAMESPACE',
} as const;

export const METRICS_NAMESPACE = 'GenomePortal';

/** Secrets Manager names (design §1, §6) */
export const SECRET_NAMES = {
  cfSigningKey: 'genome-portal/cf-signing-key',
  originVerify: 'genome-portal/origin-verify',
} as const;

// ---------------------------------------------------------------------------
// Pure helpers shared by server and client
// ---------------------------------------------------------------------------

/** D4 rule: which path the *next* download of an object takes given its current count. */
export function nextPathForCount(count: number, cfThreshold: number): DownloadPath {
  return count >= cfThreshold ? 'CF' : 'S3';
}

/** Server-side size hint (design §4 step 6). */
export function modeHintForSize(sizeBytes: number, splitThresholdBytes: number): ModeHint {
  return sizeBytes > splitThresholdBytes ? 'split' : 'single';
}

/**
 * Client planner (design §5.4 matrix).
 *   size <= split threshold                      -> single
 *   split threshold < size <= single-object limit -> split (FS Access) | single (no FS Access, R5.9 hint)
 *   size > single-object limit                    -> split (FS Access) | command
 */
export function planClientMode(
  sizeBytes: number,
  hasFileSystemAccess: boolean,
  settings: Pick<RuntimeSettings, 'splitThresholdBytes' | 'singleObjectLimitBytes'>,
): ClientMode {
  if (sizeBytes <= settings.splitThresholdBytes) return 'single';
  if (hasFileSystemAccess) return 'split';
  return sizeBytes > settings.singleObjectLimitBytes ? 'command' : 'single';
}

/** R5.2 part plan */
export function planParts(sizeBytes: number, partSize: number = PART_SIZE_BYTES) {
  const parts: Array<{ idx: number; start: number; end: number }> = [];
  for (let start = 0, idx = 0; start < sizeBytes; start += partSize, idx += 1) {
    parts.push({ idx, start, end: Math.min(start + partSize, sizeBytes) - 1 });
  }
  return { parts, concurrency: Math.max(1, Math.min(MAX_PARALLEL_PARTS, parts.length)) };
}

/**
 * Parse a Storage Browser / Access Grants scope of the form s3://bucket/prefix* (design §2.4).
 * Returns null when the scope is malformed or not inside the expected bucket.
 */
export function parseScope(scope: string, expectedBucket: string): { bucket: string; prefix: string } | null {
  if (!scope.startsWith('s3://')) return null;
  const rest = scope.slice('s3://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const bucket = rest.slice(0, slash);
  if (bucket !== expectedBucket) return null;
  let prefix = rest.slice(slash + 1);
  if (prefix.endsWith('*')) prefix = prefix.slice(0, -1);
  if (prefix.length === 0) return null; // the bucket root is never a portal location
  if (!prefix.endsWith('/')) return null;
  const segments = prefix.slice(0, -1).split('/');
  if (segments.some((s) => s.length === 0 || s === '.' || s === '..')) return null;
  if (prefix.includes('*')) return null;
  return { bucket, prefix };
}

export function grantScopeFor(bucket: string, prefix: string): string {
  return `s3://${bucket}/${prefix}*`;
}
