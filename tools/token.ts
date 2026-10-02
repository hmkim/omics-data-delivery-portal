#!/usr/bin/env -S npx tsx
/**
 * tools/token.ts [--config tools/admin.config.json]
 * Reads "<email>\n<password>\n" from stdin, signs the user in (SRP, optional TOTP prompt) and prints the
 * Cognito ID token on stdout. Used by the integration tests (T6.1) and manual API checks:
 *   TOKEN=$(npx tsx tools/token.ts < creds.txt); curl -H "Authorization: Bearer $TOKEN" <portal>/api/locations
 */
import { Amplify } from 'aws-amplify';
import { confirmSignIn, fetchAuthSession, signIn, signOut } from 'aws-amplify/auth';
import { loadAdminConfig } from './src/config';
import { promptLine } from './src/prompt';

async function main(): Promise<void> {
  const i = process.argv.indexOf('--config');
  const cfg = loadAdminConfig(i >= 0 ? process.argv[i + 1] : undefined);
  Amplify.configure({
    Auth: { Cognito: { userPoolId: cfg.userPoolId, userPoolClientId: cfg.clientId } },
  });
  await signOut().catch(() => undefined);
  const username = (await promptLine('E-mail: ')).trim();
  const password = await promptLine('Password: ');
  let result = await signIn({ username, password });
  if (!result.isSignedIn && result.nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE') {
    const code = (await promptLine('TOTP code: ')).trim();
    result = await confirmSignIn({ challengeResponse: code });
  }
  if (!result.isSignedIn) {
    throw new Error(`sign-in did not complete: next step ${result.nextStep.signInStep}`);
  }
  const session = await fetchAuthSession();
  const idToken = session.tokens?.idToken?.toString();
  if (!idToken) throw new Error('no ID token in session');
  process.stdout.write(`${idToken}\n`);
}

main().catch((err: unknown) => {
  console.error(`[token] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
