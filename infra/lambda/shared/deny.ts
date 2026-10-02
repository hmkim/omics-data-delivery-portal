import type { AccessDeniedReason, AuditEvent } from '@genome-portal/contract';
import { metrics, recordAudit } from './audit';
import { HttpError, badRequest, forbidden } from './errors';

export type DenyContext = Pick<
  AuditEvent,
  'userSub' | 'orgId' | 'bucket' | 'key' | 'ip' | 'country' | 'detail'
>;

/**
 * Record an ACCESS_DENIED audit event (R2.3, R7.1) plus the AccessDenied metric and return the error
 * to throw. BAD_SCOPE is a client error (400); every other reason is 403.
 */
export async function denied(
  reason: AccessDeniedReason,
  ctx: DenyContext,
  message?: string,
): Promise<HttpError> {
  await recordAudit({ type: 'ACCESS_DENIED', reason, ...ctx });
  metrics.accessDenied();
  if (reason === 'BAD_SCOPE') return badRequest(message ?? 'Malformed scope', reason);
  return forbidden(reason, message);
}

/** True when an error is the NO_GRANT 403 thrown by accessGrants.getDataAccess. */
export function isNoGrantError(err: unknown): err is HttpError {
  return err instanceof HttpError && err.status === 403 && err.body.reason === 'NO_GRANT';
}

/**
 * Wrap a GetDataAccess call so a NO_GRANT rejection is also written to the audit table with the
 * caller's context (the accessGrants module only knows the target, not the user).
 */
export async function auditingNoGrant<T>(ctx: DenyContext, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isNoGrantError(err)) {
      await recordAudit({ type: 'ACCESS_DENIED', reason: 'NO_GRANT', ...ctx });
      metrics.accessDenied();
    }
    throw err;
  }
}
