import { GetDataAccessCommand } from '@aws-sdk/client-s3-control';
import { metrics } from './audit';
import { s3ControlClient } from './clients';
import { requireEnv } from './env';
import { forbidden, unavailable } from './errors';

export interface GrantCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
  /** The grant Access Grants matched (audit field, design §4 step 2). */
  matchedGrantTarget?: string;
}

export interface GetDataAccessOptions {
  /** s3://bucket/prefix* for browsing, s3://bucket/key for a single object */
  target: string;
  /** Only set for a single object; prefixes leave it undefined. */
  targetType?: 'Object';
  durationSeconds: number;
  auditContext: string;
  /** Test hook: retry delays in ms (default 200, 800). */
  retryDelaysMs?: readonly number[];
}

/** AuditContext formats (design §2.4, §4). Both are visible in CloudTrail GetDataAccess events. */
export function browseAuditContext(sub: string, orgId: string): string {
  return `user=${sub};org=${orgId};kind=browse`;
}
export function downloadAuditContext(sub: string, orgId: string, downloadId: string): string {
  return `user=${sub};org=${orgId};dl=${downloadId}`;
}

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [200, 800];

const THROTTLE_NAMES = new Set([
  'SlowDown',
  'Throttling',
  'ThrottlingException',
  'TooManyRequestsException',
  'RequestLimitExceeded',
]);

function errorName(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { name?: unknown; Code?: unknown; code?: unknown };
    for (const v of [e.name, e.Code, e.code]) if (typeof v === 'string' && v !== '') return v;
  }
  return '';
}

function httpStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null) {
    const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
    return meta?.httpStatusCode;
  }
  return undefined;
}

export function isThrottle(err: unknown): boolean {
  return THROTTLE_NAMES.has(errorName(err)) || httpStatus(err) === 429 || httpStatus(err) === 503;
}

export function isAccessDenied(err: unknown): boolean {
  const name = errorName(err);
  return name === 'AccessDenied' || name === 'AccessDeniedException' || httpStatus(err) === 403;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * S3 Access Grants GetDataAccess wrapper (design §2.4 / §4 / §6).
 *  - Privilege Minimal, Permission READ, AccountId from env.
 *  - SlowDown / 429: exponential backoff, 2 retries, then 503 UNAVAILABLE.
 *  - AccessDenied (no grant covers the target): 403 FORBIDDEN reason NO_GRANT + GrantMissing metric.
 */
export async function getDataAccess(opts: GetDataAccessOptions): Promise<GrantCredentials> {
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const accountId = requireEnv('ACCOUNT_ID');
  for (let attempt = 0; ; attempt += 1) {
    try {
      const out = await s3ControlClient().send(
        new GetDataAccessCommand({
          AccountId: accountId,
          Target: opts.target,
          TargetType: opts.targetType,
          Permission: 'READ',
          Privilege: 'Minimal',
          DurationSeconds: opts.durationSeconds,
          AuditContext: opts.auditContext,
        }),
      );
      const c = out.Credentials;
      if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) {
        throw new Error('GetDataAccess returned incomplete credentials');
      }
      return {
        accessKeyId: c.AccessKeyId,
        secretAccessKey: c.SecretAccessKey,
        sessionToken: c.SessionToken,
        expiration: c.Expiration,
        matchedGrantTarget: out.MatchedGrantTarget,
      };
    } catch (err) {
      if (isAccessDenied(err)) {
        metrics.grantMissing();
        throw forbidden('NO_GRANT', 'No access grant covers the requested target');
      }
      if (isThrottle(err) && attempt < delays.length) {
        await sleep(delays[attempt] ?? 0);
        continue;
      }
      if (isThrottle(err)) throw unavailable('S3 Access Grants is throttling requests; retry later');
      throw err;
    }
  }
}
