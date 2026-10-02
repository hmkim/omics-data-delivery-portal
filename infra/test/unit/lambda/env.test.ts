import './helpers/fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import { LAMBDA_ENV } from '@genome-portal/contract';
import { readEnv, regionOrUndefined, requireEnv } from '../../../lambda/shared/env';

const saved = { ...process.env };
afterEach(() => {
  for (const name of Object.values(LAMBDA_ENV)) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe('env', () => {
  it('requireEnv reads by contract key', () => {
    expect(requireEnv('DATA_BUCKET')).toBe(process.env[LAMBDA_ENV.DATA_BUCKET]);
  });

  it('missing or blank variables fail with the variable name and the contract key', () => {
    delete process.env[LAMBDA_ENV.CF_DOMAIN];
    expect(() => requireEnv('CF_DOMAIN')).toThrow(
      'Missing required environment variable CF_DOMAIN (LAMBDA_ENV.CF_DOMAIN)',
    );
    process.env[LAMBDA_ENV.CF_DOMAIN] = '   ';
    expect(() => requireEnv('CF_DOMAIN')).toThrow(/CF_DOMAIN/);
  });

  it('readEnv returns a record keyed by contract key', () => {
    expect(readEnv(['ORGS_TABLE', 'AUDIT_TABLE'])).toEqual({
      ORGS_TABLE: 'genome-portal-orgs',
      AUDIT_TABLE: 'genome-portal-audit-events',
    });
    delete process.env[LAMBDA_ENV.AUDIT_TABLE];
    expect(() => readEnv(['ORGS_TABLE', 'AUDIT_TABLE'])).toThrow(/AUDIT_TABLE/);
  });

  it('regionOrUndefined tolerates a missing region', () => {
    expect(regionOrUndefined()).toBe('ap-northeast-2');
    process.env[LAMBDA_ENV.REGION] = '';
    expect(regionOrUndefined()).toBeUndefined();
    delete process.env[LAMBDA_ENV.REGION];
    expect(regionOrUndefined()).toBeUndefined();
  });
});
