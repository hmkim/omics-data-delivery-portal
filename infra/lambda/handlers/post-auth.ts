import type { PostAuthenticationTriggerEvent } from 'aws-lambda';
import { recordAudit } from '../shared/audit';
import { requireEnv } from '../shared/env';

requireEnv('AUDIT_TABLE');
requireEnv('REGION');

/**
 * Cognito PostAuthentication trigger (R7.1): record LOGIN_SUCCESS and hand the event back unchanged.
 * A failed audit write must never block a login; recordAudit logs and swallows write errors.
 */
export async function handler(
  event: PostAuthenticationTriggerEvent,
): Promise<PostAuthenticationTriggerEvent> {
  const attrs = event.request?.userAttributes ?? {};
  const userSub = attrs['sub'] ?? event.userName;
  const orgId = attrs['custom:orgId'];
  await recordAudit({
    type: 'LOGIN_SUCCESS',
    userSub,
    orgId: orgId && orgId !== '' ? orgId : undefined,
    detail: {
      userPoolId: event.userPoolId,
      newDeviceUsed: event.request?.newDeviceUsed === true,
    },
  });
  return event;
}
