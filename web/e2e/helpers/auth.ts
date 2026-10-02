import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { DEFAULT_CREDENTIALS_FILE } from '../../playwright.config';

export interface PortalCredentials {
  email: string;
  password: string;
}

/**
 * Reads the portal test user from `E2E_CREDENTIALS_FILE` (line 1 e-mail, line 2 password). The file is 0600 and is
 * read by the Playwright process only — never log its contents. The password never appears in traces either:
 * `signIn()` fills it with `fill()` and Playwright redacts `type=password` inputs from snapshots.
 */
export function readCredentials(): PortalCredentials {
  const file = process.env.E2E_CREDENTIALS_FILE ?? DEFAULT_CREDENTIALS_FILE;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(
      `E2E credentials file not readable: ${file} (${(err as Error).message}). ` +
        'Create it with the portal user e-mail on line 1 and the password on line 2 (chmod 600), ' +
        'or point E2E_CREDENTIALS_FILE at it.',
    );
  }
  const [email, password] = text.split(/\r?\n/).map((l) => l.trim());
  if (!email || !password)
    throw new Error(`E2E credentials file ${file} must contain e-mail (line 1) and password (line 2)`);
  return { email, password };
}

/** Amplify Authenticator (ko): e-mail + password → the Storage Browser locations table. */
export async function signIn(page: Page, creds: PortalCredentials = readCredentials()): Promise<void> {
  await page.goto('/');
  const username = page.locator('input[name="username"]');
  await expect(username).toBeVisible({ timeout: 60_000 });
  await username.fill(creds.email);
  await page.locator('input[name="password"]').fill(creds.password);
  await page.locator('button[type="submit"]').click();
  await expectSignedIn(page);
}

/** Signed-in state = the location list rendered (`projects/…/` rows) and the sign-out button in the header. */
export async function expectSignedIn(page: Page): Promise<void> {
  const totp = page.locator('input[name="confirmation_code"]');
  const locations = page.getByRole('row').filter({ hasText: /projects\// });
  await expect(locations.first().or(totp)).toBeVisible({ timeout: 90_000 });
  if (await totp.isVisible()) {
    throw new Error(
      'The portal test user has TOTP MFA enabled; the e2e suite needs a user without MFA (pool MFA is OPTIONAL).',
    );
  }
}

/** Back at the Authenticator sign-in form. */
export async function expectSignedOut(page: Page, timeout = 60_000): Promise<void> {
  await expect(page.locator('input[name="username"]')).toBeVisible({ timeout });
}
