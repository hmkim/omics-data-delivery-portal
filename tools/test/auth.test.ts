import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isCachedTokenValid,
  readTokenCache,
  TOKEN_EXPIRY_SKEW_SECONDS,
  writeTokenCache,
  type CachedToken,
} from '../src/auth.js';
import { parseAdminConfig } from '../src/config.js';

const cfg = { userPoolId: 'ap-northeast-2_ABC', clientId: 'client-1' };
const jwt = 'aaa.bbb.ccc';

describe('isCachedTokenValid', () => {
  const now = 1_800_000_000;
  const base: CachedToken = {
    idToken: jwt,
    expiresAt: now + 3600,
    userPoolId: cfg.userPoolId,
    clientId: cfg.clientId,
  };

  it('accepts a matching, unexpired token', () => {
    expect(isCachedTokenValid(base, cfg, now)).toBe(true);
  });
  it('rejects undefined', () => {
    expect(isCachedTokenValid(undefined, cfg, now)).toBe(false);
  });
  it('rejects a token for another pool or client', () => {
    expect(isCachedTokenValid({ ...base, userPoolId: 'other' }, cfg, now)).toBe(false);
    expect(isCachedTokenValid({ ...base, clientId: 'other' }, cfg, now)).toBe(false);
  });
  it('applies the expiry skew', () => {
    expect(isCachedTokenValid({ ...base, expiresAt: now + TOKEN_EXPIRY_SKEW_SECONDS + 1 }, cfg, now)).toBe(
      true,
    );
    expect(isCachedTokenValid({ ...base, expiresAt: now + TOKEN_EXPIRY_SKEW_SECONDS }, cfg, now)).toBe(false);
    expect(isCachedTokenValid({ ...base, expiresAt: now - 1 }, cfg, now)).toBe(false);
  });
  it('rejects something that is not a JWT', () => {
    expect(isCachedTokenValid({ ...base, idToken: 'not-a-jwt' }, cfg, now)).toBe(false);
  });
});

describe('token cache file', () => {
  it('round-trips and is written with mode 0600', () => {
    const dir = mkdtempSync(path.join(process.env.PORTAL_SCRATCH ?? tmpdir(), 'gp-token-'));
    const file = path.join(dir, 'nested', 'token.json');
    const token: CachedToken = {
      idToken: jwt,
      expiresAt: 1,
      userPoolId: 'p',
      clientId: 'c',
      username: 'u@x.y',
    };
    writeTokenCache(token, file);
    expect(readTokenCache(file)).toEqual(token);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
  });
  it('returns undefined for a missing or corrupt file', () => {
    const dir = mkdtempSync(path.join(process.env.PORTAL_SCRATCH ?? tmpdir(), 'gp-token-'));
    expect(readTokenCache(path.join(dir, 'none.json'))).toBeUndefined();
  });
});

describe('parseAdminConfig', () => {
  const good = {
    userPoolId: 'ap-northeast-2_ABC',
    clientId: 'c',
    region: 'ap-northeast-2',
    portalUrl: 'https://p.example/',
  };
  it('strips the trailing slash from portalUrl', () => {
    expect(parseAdminConfig(good, 'x').portalUrl).toBe('https://p.example');
  });
  it('requires every field', () => {
    for (const key of ['userPoolId', 'clientId', 'region', 'portalUrl'] as const) {
      const bad: Record<string, unknown> = { ...good };
      delete bad[key];
      expect(() => parseAdminConfig(bad, 'x')).toThrow(new RegExp(key));
    }
  });
  it('requires https', () => {
    expect(() => parseAdminConfig({ ...good, portalUrl: 'http://p.example' }, 'x')).toThrow(/https/);
  });
});
