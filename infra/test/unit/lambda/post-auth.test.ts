import { TEST } from './helpers/fixtures';
import { ddbMock, resetAllMocks } from './helpers/mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostAuthenticationTriggerEvent } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { handler } from '../../../lambda/handlers/post-auth';

beforeEach(() => {
  resetAllMocks();
  ddbMock.on(PutCommand).resolves({});
});

function event(attrs: Record<string, string>): PostAuthenticationTriggerEvent {
  return {
    version: '1',
    region: TEST.region,
    userPoolId: TEST.userPoolId,
    userName: 'lee@example.org',
    callerContext: { awsSdkVersion: 'x', clientId: 'c' },
    triggerSource: 'PostAuthentication_Authentication',
    request: { userAttributes: attrs, newDeviceUsed: true },
    response: {},
  };
}

describe('Cognito post-authentication trigger', () => {
  it('records LOGIN_SUCCESS with sub and orgId and returns the event unchanged', async () => {
    const ev = event({ sub: 'sub-1', 'custom:orgId': 'org-a', email: 'lee@example.org' });
    const out = await handler(ev);
    expect(out).toBe(ev);
    const item = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(item?.TableName).toBe(TEST.auditTable);
    expect(item?.Item).toMatchObject({
      type: 'LOGIN_SUCCESS',
      userSub: 'sub-1',
      orgId: 'org-a',
      detail: { userPoolId: TEST.userPoolId, newDeviceUsed: true },
    });
    expect(item?.Item).not.toHaveProperty('email');
  });

  it('falls back to userName when sub is absent and omits an empty orgId', async () => {
    await handler(event({ 'custom:orgId': '' }));
    const item = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(item).toMatchObject({ userSub: 'lee@example.org' });
    expect(item?.['orgId']).toBeUndefined();
  });

  it('never blocks a login when the audit write fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ddbMock.on(PutCommand).rejects(new Error('down'));
    const ev = event({ sub: 's' });
    await expect(handler(ev)).resolves.toBe(ev);
    spy.mockRestore();
  });
});
