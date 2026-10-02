/**
 * Interactive Cognito sign-in for the admin CLI (design §7.3, T4.1).
 *
 * Flow: SRP sign-in with aws-amplify (Node runtime) -> TOTP challenge -> ID token cached at
 * ~/.genome-portal/token.json (mode 0600). While the cached token is valid it is reused; once it
 * expires the operator is asked to sign in again (the CLI does not keep the refresh token on disk).
 */
import { Amplify } from 'aws-amplify';
import { confirmSignIn, fetchAuthSession, signIn, signOut } from 'aws-amplify/auth';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AdminConfig } from './config.js';
import { promptHidden, promptLine } from './prompt.js';

export interface CachedToken {
  /** Cognito ID token (JWT) */
  idToken: string;
  /** epoch seconds */
  expiresAt: number;
  userPoolId: string;
  clientId: string;
  username?: string;
}

/** Tokens are considered expired this many seconds before their real exp, to survive slow requests. */
export const TOKEN_EXPIRY_SKEW_SECONDS = 60;

export function tokenCacheDir(): string {
  return path.join(homedir(), '.genome-portal');
}

export function tokenCachePath(): string {
  return path.join(tokenCacheDir(), 'token.json');
}

/** Pure check used by the CLI and the tests: is this cached token still usable for `cfg`? */
export function isCachedTokenValid(
  cached: CachedToken | undefined,
  cfg: Pick<AdminConfig, 'userPoolId' | 'clientId'>,
  nowSeconds = Math.floor(Date.now() / 1000),
): cached is CachedToken {
  if (!cached) return false;
  if (cached.userPoolId !== cfg.userPoolId || cached.clientId !== cfg.clientId) return false;
  if (typeof cached.idToken !== 'string' || cached.idToken.split('.').length !== 3) return false;
  return cached.expiresAt - TOKEN_EXPIRY_SKEW_SECONDS > nowSeconds;
}

export function readTokenCache(file = tokenCachePath()): CachedToken | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<CachedToken>;
    if (typeof parsed.idToken !== 'string' || typeof parsed.expiresAt !== 'number') return undefined;
    return parsed as CachedToken;
  } catch {
    return undefined;
  }
}

export function writeTokenCache(token: CachedToken, file = tokenCachePath()): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(token, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600); // writeFileSync's mode is ignored when the file already exists
}

export function clearTokenCache(file = tokenCachePath()): void {
  if (existsSync(file)) unlinkSync(file);
}

export function configureAmplify(cfg: AdminConfig): void {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: cfg.userPoolId,
        userPoolClientId: cfg.clientId,
      },
    },
  });
}

/**
 * Runs the interactive sign-in and returns the ID token. Handles the steps a portal admin can hit:
 * TOTP code, first-time TOTP setup, forced password change. Anything else is reported as unsupported
 * (an admin account should not have SMS/email MFA or custom challenges).
 */
export async function interactiveSignIn(
  cfg: AdminConfig,
  io = { promptLine, promptHidden },
): Promise<CachedToken> {
  configureAmplify(cfg);
  // Drop any in-memory session left from a previous call in the same process.
  await signOut().catch(() => undefined);

  const username = (await io.promptLine('Admin e-mail: ')).trim();
  if (!username) throw new Error('username is required');
  const password = await io.promptHidden('Password: ');

  let result = await signIn({ username, password });
  for (let guard = 0; guard < 6 && !result.isSignedIn; guard += 1) {
    const step = result.nextStep.signInStep;
    switch (step) {
      case 'CONFIRM_SIGN_IN_WITH_TOTP_CODE': {
        const code = (await io.promptLine('TOTP code: ')).trim();
        result = await confirmSignIn({ challengeResponse: code });
        break;
      }
      case 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP': {
        const details = result.nextStep.totpSetupDetails;
        console.error('TOTP is not set up for this account yet.');
        console.error(`  Secret: ${details.sharedSecret}`);
        console.error(`  otpauth URI: ${details.getSetupUri('genome-portal', username).toString()}`);
        const code = (await io.promptLine('Enter the first code from your authenticator app: ')).trim();
        result = await confirmSignIn({ challengeResponse: code });
        break;
      }
      case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED': {
        console.error('A new password is required (first sign-in with a temporary password).');
        const p1 = await io.promptHidden('New password: ');
        const p2 = await io.promptHidden('Repeat new password: ');
        if (p1 !== p2) throw new Error('passwords do not match');
        result = await confirmSignIn({ challengeResponse: p1 });
        break;
      }
      case 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION': {
        result = await confirmSignIn({ challengeResponse: 'TOTP' });
        break;
      }
      case 'DONE':
        break;
      default:
        throw new Error(`unsupported sign-in step "${step}"; complete it in the portal UI, then retry`);
    }
  }
  if (!result.isSignedIn) throw new Error('sign-in did not complete');

  const session = await fetchAuthSession({ forceRefresh: false });
  const idToken = session.tokens?.idToken;
  if (!idToken) throw new Error('signed in but no ID token was returned');
  const exp = idToken.payload.exp;
  if (typeof exp !== 'number') throw new Error('ID token has no exp claim');

  const groups = idToken.payload['cognito:groups'];
  const isAdmin = Array.isArray(groups) && groups.includes('admins');
  if (!isAdmin) {
    console.error('Warning: this account is not in the "admins" group; admin calls will return 403.');
  }

  return {
    idToken: idToken.toString(),
    expiresAt: exp,
    userPoolId: cfg.userPoolId,
    clientId: cfg.clientId,
    username,
  };
}

/** Returns a cached token when valid, otherwise signs in and caches the fresh one. */
export async function getIdToken(cfg: AdminConfig, opts: { forceLogin?: boolean; cacheFile?: string } = {}) {
  const file = opts.cacheFile ?? tokenCachePath();
  if (!opts.forceLogin) {
    const cached = readTokenCache(file);
    if (isCachedTokenValid(cached, cfg)) return cached.idToken;
  }
  const fresh = await interactiveSignIn(cfg);
  writeTokenCache(fresh, file);
  return fresh.idToken;
}
