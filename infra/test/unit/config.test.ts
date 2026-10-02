import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOGO_URL, loadConfig } from '../../lib/config';

const base = {
  region: 'ap-northeast-2',
  mfaMode: 'OPTIONAL',
  alertEmail: 'ops@example.com',
};

function writeConfig(dir: string, env: string, brand: Record<string, unknown>): void {
  writeFileSync(join(dir, `${env}.json`), JSON.stringify({ ...base, brand }));
}

describe('deployment config: brand logo (R1.7, dev 2026-10-01 broken logo)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gp-config-test-'));

  it('default logoUrl without logoFile is accepted (served by the SPA bundle)', () => {
    writeConfig(dir, 'a', { name: 'Portal', logoUrl: DEFAULT_LOGO_URL, primaryColor: '#0f6cbd' });
    expect(loadConfig('a', dir).brand.logoFile).toBeUndefined();
  });

  it('a site-relative logoUrl other than the default needs a logoFile', () => {
    writeConfig(dir, 'b', { name: 'Portal', logoUrl: '/brand/custom.svg', primaryColor: '#0f6cbd' });
    expect(() => loadConfig('b', dir)).toThrow(/no brand\.logoFile is configured/);
  });

  it('logoFile is resolved relative to the config dir and must exist', () => {
    writeFileSync(join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeConfig(dir, 'c', {
      name: 'Portal',
      logoUrl: '/brand/custom.svg',
      logoFile: 'logo.svg',
      primaryColor: '#0f6cbd',
    });
    expect(loadConfig('c', dir).brand.logoFile).toBe(join(dir, 'logo.svg'));

    writeConfig(dir, 'd', {
      name: 'Portal',
      logoUrl: '/brand/custom.svg',
      logoFile: 'missing.svg',
      primaryColor: '#0f6cbd',
    });
    expect(() => loadConfig('d', dir)).toThrow(/does not exist/);
  });

  it('logoFile with an absolute https logoUrl is rejected (nowhere to upload it)', () => {
    writeConfig(dir, 'e', {
      name: 'Portal',
      logoUrl: 'https://cdn.example.com/logo.svg',
      logoFile: 'logo.svg',
      primaryColor: '#0f6cbd',
    });
    expect(() => loadConfig('e', dir)).toThrow(/site-relative path/);
  });

  it('an absolute https logoUrl without logoFile is accepted as-is', () => {
    writeConfig(dir, 'f', {
      name: 'Portal',
      logoUrl: 'https://cdn.example.com/logo.svg',
      primaryColor: '#0f6cbd',
    });
    expect(loadConfig('f', dir).brand.logoUrl).toBe('https://cdn.example.com/logo.svg');
  });
});
