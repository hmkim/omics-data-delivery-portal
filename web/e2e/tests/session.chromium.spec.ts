import type { Page, Request } from '@playwright/test';
import { expect, test } from '../fixtures';
import { expectSignedOut, signIn } from '../helpers/auth';
import { DEV, formatMs, GiB, metric, OBJECTS } from '../helpers/env';
import { installPickFileHook, opfsCrc32 } from '../helpers/opfs';
import {
  clickDownload,
  expectSplitStatus,
  fileRow,
  notice,
  openLocation,
  splitRow,
  splitState,
  waitForProgressAbove,
} from '../helpers/portal';

/** `Authorization: Bearer <jwt>` → decoded payload (iat/exp/…) for comparison; never logged in full. */
function jwtPayload(authorization: string | undefined): Record<string, unknown> {
  const token = authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const part = token.split('.')[1];
  if (!part) return {};
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

function tokenId(authorization: string | undefined): string {
  const p = jwtPayload(authorization);
  return `iat=${p.iat} exp=${p.exp} jti=${String(p.jti ?? p.origin_jti ?? '').slice(0, 8)}`;
}

function isApi(req: Request, suffix: RegExp): boolean {
  return req.method() === 'POST' && suffix.test(new URL(req.url()).pathname);
}

/** Cognito IDP call names seen on the page (`x-amz-target` header without the service prefix). */
function watchCognito(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (req) => {
    if (!req.url().includes('cognito-idp.')) return;
    const target = req.headers()['x-amz-target'];
    if (target) seen.push(target.replace('AWSCognitoIdentityProviderService.', ''));
  });
  return seen;
}

/**
 * T7.3 — R1.5 / scenario 9. The fake clock (`page.clock`) drives Date.now/setTimeout/setInterval in the page:
 * `fastForward(65 min)` fires the session keeper's 1-minute check once (skipped because a download is active), fires
 * the engine's renew timer (scheduled at URL expiry − 5 min) and makes Amplify treat the 1-hour ID token as expired,
 * so the renew request goes out with a token refreshed through the refresh token. Real time keeps flowing for the
 * transfer itself. See README "How the fake clock interacts with Amplify".
 */
test('T7.3 65 min idle during a split download keeps the session; 60 min idle after completion signs out', async ({
  page,
  creds,
}) => {
  test.setTimeout(25 * 60_000);
  await page.clock.install();
  await installPickFileHook(page);
  const cognito = watchCognito(page);
  const authHeaders: Array<{ path: string; authorization: string | undefined; at: number }> = [];
  page.on('request', (req) => {
    if (isApi(req, /\/api\/downloads(\/[^/]+\/renew)?$/)) {
      authHeaders.push({
        path: new URL(req.url()).pathname,
        authorization: req.headers()['authorization'],
        at: Date.now(),
      });
    }
  });

  await signIn(page, creds);
  await openLocation(page, DEV.locations.demo);
  const row = fileRow(page, OBJECTS.gib12.name);
  const issued = await clickDownload(page, row);
  const split = splitRow(page, OBJECTS.gib12.name);
  await expectSplitStatus(split, 'running', 60_000);
  const issueAuth = authHeaders.find((h) => h.path.endsWith('/api/downloads'))?.authorization;
  expect(issueAuth).toBeTruthy();
  const issueExp = Number(jwtPayload(issueAuth).exp) * 1000;
  metric('T7.3 token at issue', tokenId(issueAuth));
  metric('T7.3 URL expiresAt', issued.expiresAt);

  await waitForProgressAbove(split, 3, 5 * 60_000);
  const renewRequest = page.waitForRequest((r) => isApi(r, /\/renew$/), { timeout: 3 * 60_000 });
  const cognitoBefore = cognito.length;

  // 65 minutes without any input
  await page.clock.fastForward('01:05:00');
  const renew = await renewRequest;
  const renewAuth = renew.headers()['authorization'];
  const renewResponse = await renew.response();
  expect(renewResponse?.status()).toBe(200);
  metric('T7.3 token at renew', tokenId(renewAuth));
  expect(renewAuth).not.toBe(issueAuth);
  expect(Number(jwtPayload(renewAuth).exp) * 1000).toBeGreaterThan(issueExp);
  // Amplify 6.x refreshes through Cognito's GetTokensFromRefreshToken API (rotating refresh tokens); older
  // versions used InitiateAuth REFRESH_TOKEN_AUTH — either one is the refresh we are looking for.
  const refreshCalls = cognito
    .slice(cognitoBefore)
    .filter((t) => t === 'GetTokensFromRefreshToken' || t === 'InitiateAuth');
  metric('T7.3 Cognito calls during the jump', cognito.slice(cognitoBefore).join(',') || '(none)');
  expect(
    refreshCalls.length,
    'ID token was refreshed through the refresh token (GetTokensFromRefreshToken / InitiateAuth REFRESH_TOKEN_AUTH)',
  ).toBeGreaterThanOrEqual(1);

  // still signed in, download still running, renew acknowledged
  await expect(page.locator('input[name="username"]')).toHaveCount(0);
  await expect(notice(page, '만료 전 URL을 갱신했습니다')).toBeVisible();
  expect(['running', 'merging', 'verifying', 'complete']).toContain((await splitState(split)).status);
  await expect(split).toHaveAttribute('data-renew-count', /^[1-9]\d*$/);

  const tResume = Date.now();
  await expectSplitStatus(split, 'complete', 15 * 60_000);
  metric('T7.3 transfer after the 65-min jump → complete', formatMs(Date.now() - tResume));
  const crc = await opfsCrc32(page, OBJECTS.gib12.name);
  expect(crc.base64).toBe(OBJECTS.gib12.crc32);
  metric('T7.3 CRC32', crc.base64);

  // 60 minutes idle after the last download finished → signOut()
  const signOutCalls = cognito.length;
  await page.clock.fastForward('01:01:00');
  await expectSignedOut(page, 60_000);
  await expect(notice(page, '60분 동안 조작이 없어 로그아웃되었습니다')).toBeVisible();
  const afterSignOut = cognito.slice(signOutCalls);
  metric('T7.3 Cognito calls at idle sign-out', afterSignOut.join(',') || '(none)');
  expect(afterSignOut, 'Amplify signOut() revokes the refresh token').toContain('RevokeToken');
  expect(issued.sizeBytes).toBe(12 * GiB);
});
