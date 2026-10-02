import { randomBytes } from 'node:crypto';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { names } from '../../../lib/constants';
import { aws } from './aws';
import { stackOutputs } from './outputs';

export type TestUserKey = 'a' | 'b' | 'admin';

export interface TestUserSpec {
  key: TestUserKey;
  email: string;
  orgId: string;
  lang: 'ko' | 'en';
  admin: boolean;
}

/** Fixed usernames so re-runs and the later Playwright suite reuse the same accounts (brief T6.1). */
export const TEST_USERS: Record<TestUserKey, TestUserSpec> = {
  a: { key: 'a', email: 'integ-a@genome-portal.invalid', orgId: 'integ-a', lang: 'ko', admin: false },
  b: { key: 'b', email: 'integ-b@genome-portal.invalid', orgId: 'integ-b', lang: 'en', admin: false },
  admin: {
    key: 'admin',
    email: 'integ-admin@genome-portal.invalid',
    orgId: 'integ-a',
    lang: 'ko',
    admin: true,
  },
};

export interface TestUser extends TestUserSpec {
  sub: string;
  /** In-memory only; regenerated on every run. Never logged. */
  password: string;
}

/** Cognito policy: >= 12 chars with upper, lower, digit and symbol. */
function randomPassword(): string {
  const body = randomBytes(18).toString('base64url');
  return `Aa1!${body}`;
}

async function getSub(userPoolId: string, username: string): Promise<string> {
  const out = await aws
    .cognito()
    .send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }));
  const sub = out.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
  if (!sub) throw new Error(`user ${username} has no sub attribute`);
  return sub;
}

/**
 * Create (or reuse) a test user with a fresh permanent password. `MessageAction: SUPPRESS` so no e-mail is
 * sent; `UsernameExistsException` means the account is already there and only the password is reset.
 */
export async function ensureUser(spec: TestUserSpec): Promise<TestUser> {
  const { UserPoolId } = await stackOutputs();
  const cognito = aws.cognito();
  const attributes = [
    { Name: 'email', Value: spec.email },
    { Name: 'email_verified', Value: 'true' },
    { Name: 'custom:orgId', Value: spec.orgId },
    { Name: 'custom:lang', Value: spec.lang },
  ];
  try {
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId,
        Username: spec.email,
        MessageAction: 'SUPPRESS',
        UserAttributes: attributes,
      }),
    );
    console.info(`[users] created ${spec.email} (org ${spec.orgId})`);
  } catch (err) {
    if ((err as { name?: string }).name !== 'UsernameExistsException') throw err;
    // custom:orgId is immutable in the pool (a user cannot be moved between organisations); verify instead.
    const existing = await cognito.send(new AdminGetUserCommand({ UserPoolId, Username: spec.email }));
    const orgId = existing.UserAttributes?.find((a) => a.Name === 'custom:orgId')?.Value;
    if (orgId !== spec.orgId) {
      throw new Error(
        `existing user ${spec.email} belongs to org ${orgId ?? '(none)'}, expected ${spec.orgId}`,
      );
    }
  }
  const password = randomPassword();
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId,
      Username: spec.email,
      Password: password,
      Permanent: true,
    }),
  );
  if (spec.admin) {
    await cognito.send(
      new AdminAddUserToGroupCommand({ UserPoolId, Username: spec.email, GroupName: names.adminsGroup }),
    );
  }
  const sub = await getSub(UserPoolId, spec.email);
  return { ...spec, sub, password };
}

export async function ensureAllUsers(): Promise<Record<TestUserKey, TestUser>> {
  const [a, b, admin] = await Promise.all([
    ensureUser(TEST_USERS.a),
    ensureUser(TEST_USERS.b),
    ensureUser(TEST_USERS.admin),
  ]);
  return { a, b, admin };
}
