import { Amplify } from 'aws-amplify';
import { fetchAuthSession, signIn, signOut } from 'aws-amplify/auth';
import { stackOutputs } from './outputs';
import type { TestUser } from './users';

let configured = false;

async function configure(): Promise<void> {
  if (configured) return;
  const { UserPoolId, ClientId } = await stackOutputs();
  Amplify.configure({ Auth: { Cognito: { userPoolId: UserPoolId, userPoolClientId: ClientId } } });
  configured = true;
}

export interface SignedIn {
  idToken: string;
  /** epoch seconds */
  exp: number;
}

/**
 * SRP sign-in through aws-amplify v6 (process-wide singleton: users are signed in one after another and the
 * ID tokens are kept). Dev pool: MFA OPTIONAL, permanent password -> no challenge. Tokens are never logged.
 */
export async function signInUser(user: TestUser): Promise<SignedIn> {
  await configure();
  await signOut().catch(() => undefined);
  const result = await signIn({ username: user.email, password: user.password });
  if (!result.isSignedIn) {
    throw new Error(`sign-in for ${user.email} did not complete: next step ${result.nextStep.signInStep}`);
  }
  const session = await fetchAuthSession({ forceRefresh: false });
  const idToken = session.tokens?.idToken;
  if (!idToken) throw new Error(`no ID token for ${user.email}`);
  const exp = idToken.payload.exp;
  if (typeof exp !== 'number') throw new Error('ID token has no exp claim');
  const claimedSub = idToken.payload.sub;
  if (claimedSub !== user.sub) throw new Error(`ID token sub mismatch for ${user.email}`);
  await signOut().catch(() => undefined);
  return { idToken: idToken.toString(), exp };
}

/** Sign in a, b and admin sequentially and return their tokens keyed like the users record. */
export async function signInAll<K extends string>(users: Record<K, TestUser>): Promise<Record<K, SignedIn>> {
  const out = {} as Record<K, SignedIn>;
  for (const key of Object.keys(users) as K[]) out[key] = await signInUser(users[key]);
  return out;
}
