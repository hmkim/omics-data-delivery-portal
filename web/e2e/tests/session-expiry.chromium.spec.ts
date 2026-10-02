import { expect, test } from '../fixtures';
import { expectSignedOut, signIn } from '../helpers/auth';
import { adminUserGlobalSignOut, awsGate } from '../helpers/aws';
import { DEV, formatMs, metric, OBJECTS } from '../helpers/env';
import { installPickFileHook, opfsCrc32, readSplitRecords } from '../helpers/opfs';
import {
  clickDownload,
  expectSplitStatus,
  fileRow,
  notice,
  openLocation,
  resumeSplit,
  splitRow,
  splitState,
  waitForProgressAbove,
} from '../helpers/portal';

/**
 * T7.4 — R1.5 / R5.4 / scenario 11 (needs AWS credentials for `AdminUserGlobalSignOut`).
 * The revoked refresh token only bites when Amplify tries to refresh, so after the revocation the fake clock jumps
 * 65 min: the engine's renew timer fires, Amplify sees the ID token as expired, the refresh fails
 * (`NotAuthorizedException`) → `AuthExpiredError` → the download is PAUSED with reason AUTH_EXPIRED (never "failed"),
 * the session keeper shows the banner and returns to the sign-in form. Signing in again offers "재개".
 */
test('T7.4 AdminUserGlobalSignOut during a split download → paused(AUTH_EXPIRED) → re-login → resume → CRC32', async ({
  page,
  creds,
}) => {
  test.setTimeout(25 * 60_000);
  const gate = await awsGate();
  test.skip(
    !gate.ok,
    `${gate.ok ? '' : gate.reason}\n  npx playwright test session-expiry --project=chromium`,
  );

  await page.clock.install();
  await installPickFileHook(page);
  await signIn(page, creds);
  await openLocation(page, DEV.locations.demo);
  const issued = await clickDownload(page, fileRow(page, OBJECTS.gib12.name));
  const split = splitRow(page, OBJECTS.gib12.name);
  await expectSplitStatus(split, 'running', 60_000);
  await waitForProgressAbove(split, 3, 5 * 60_000);

  const tRevoke = Date.now();
  await adminUserGlobalSignOut(creds.email);
  metric('T7.4 AdminUserGlobalSignOut issued at', new Date(tRevoke).toISOString());

  const renewFailed = page
    .waitForResponse(
      (r) => r.request().method() === 'POST' && /\/renew$/.test(new URL(r.url()).pathname) && !r.ok(),
      { timeout: 3 * 60_000 },
    )
    .catch(() => undefined); // a refresh failure inside Amplify never reaches the API — both paths are acceptable
  await page.clock.fastForward('01:05:00');

  // AUTH_EXPIRED path: banner + sign-in form, and the record is paused (not failed) in IndexedDB
  await expectSignedOut(page, 3 * 60_000);
  metric('T7.4 revoke → back at sign-in form', formatMs(Date.now() - tRevoke));
  await expect(notice(page, '세션이 끝났습니다. 다시 로그인하면 이어받습니다.')).toBeVisible();
  const failedRenew = await Promise.race([
    renewFailed,
    new Promise<undefined>((r) => setTimeout(() => r(undefined), 5000)),
  ]);
  metric(
    'T7.4 renew response after revocation',
    failedRenew ? String(failedRenew.status()) : 'refresh failed client-side (no API call)',
  );
  const paused = (await readSplitRecords(page)).find((r) => r.downloadId === issued.downloadId);
  expect(paused?.status).toBe('paused');
  expect(paused?.reason).toBe('AUTH_EXPIRED');

  // sign in again → the panel offers 재개 with the AUTH_EXPIRED explanation
  await signIn(page, creds);
  const offered = splitRow(page, OBJECTS.gib12.name);
  await expectSplitStatus(offered, 'paused', 60_000);
  expect((await splitState(offered)).reason).toBe('AUTH_EXPIRED');
  await expect(offered.getByText('세션이 끝나 일시정지되었습니다. 재개하면 이어받습니다.')).toBeVisible();
  await expect(offered.getByRole('button', { name: '재개' })).toBeVisible();
  const tResume = Date.now();
  await resumeSplit(offered);
  await expectSplitStatus(offered, 'complete', 15 * 60_000);
  metric('T7.4 resume after re-login → complete', formatMs(Date.now() - tResume));
  const crc = await opfsCrc32(page, OBJECTS.gib12.name);
  metric('T7.4 CRC32', crc.base64);
  expect(crc.base64).toBe(OBJECTS.gib12.crc32);
});
