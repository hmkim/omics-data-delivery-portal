import { TEST, makeEvent } from './helpers/fixtures';
import { resetAllMocks, secretsMock } from './helpers/mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { ORIGIN_VERIFY_HEADER, VIEWER_ADDRESS_HEADER, VIEWER_COUNTRY_HEADER } from '@genome-portal/contract';
import {
  extractSecretString,
  resetOriginVerifyCache,
  secretsEqual,
  verifyOrigin,
  viewerInfo,
  viewerIpFromAddress,
} from '../../../lambda/shared/originVerify';
import { HttpError } from '../../../lambda/shared/errors';

beforeEach(() => {
  resetAllMocks();
  resetOriginVerifyCache();
});

describe('x-origin-verify', () => {
  it('accepts the matching header and returns viewer ip + country', async () => {
    const info = await verifyOrigin(makeEvent());
    expect(info).toEqual({ ip: '203.0.113.7', country: 'KR' });
  });

  it('rejects a missing header with 403', async () => {
    await expect(verifyOrigin(makeEvent({ withOrigin: false }))).rejects.toMatchObject({
      status: 403,
      body: { reason: 'ORIGIN_VERIFY_FAILED' },
    });
  });

  it('rejects a wrong header (same length and different length) with 403', async () => {
    const wrongSameLen = TEST.originSecret.slice(0, -1) + 'X';
    await expect(
      verifyOrigin(makeEvent({ headers: { [ORIGIN_VERIFY_HEADER]: wrongSameLen } })),
    ).rejects.toBeInstanceOf(HttpError);
    await expect(
      verifyOrigin(makeEvent({ headers: { [ORIGIN_VERIFY_HEADER]: 'short' } })),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it('matches header names case-insensitively', async () => {
    const ev = makeEvent({ withOrigin: false, headers: { 'X-Origin-Verify': TEST.originSecret } });
    await expect(verifyOrigin(ev)).resolves.toBeTruthy();
  });

  it('loads the secret once per container', async () => {
    await verifyOrigin(makeEvent());
    await verifyOrigin(makeEvent());
    expect(secretsMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });

  it('retries the secret load after a failure', async () => {
    secretsMock
      .on(GetSecretValueCommand)
      .rejectsOnce(new Error('boom'))
      .resolves({ SecretString: TEST.originSecret });
    await expect(verifyOrigin(makeEvent())).rejects.toThrow('boom');
    await expect(verifyOrigin(makeEvent())).resolves.toBeTruthy();
  });

  it('accepts a JSON-wrapped secret', () => {
    expect(extractSecretString('{"value":"abc"}')).toBe('abc');
    expect(extractSecretString('{"token":"t"}')).toBe('t');
    expect(extractSecretString('  plain  ')).toBe('plain');
    expect(extractSecretString('{not json')).toBe('{not json');
    expect(() => extractSecretString(undefined)).toThrow(/SecretString/);
  });

  it('secretsEqual is false on length mismatch and true on equality', () => {
    const expected = Buffer.from('abc');
    expect(secretsEqual('abc', expected)).toBe(true);
    expect(secretsEqual('abd', expected)).toBe(false);
    expect(secretsEqual('ab', expected)).toBe(false);
  });
});

describe('viewer headers', () => {
  it.each([
    ['203.0.113.7:51234', '203.0.113.7'],
    ['203.0.113.7', '203.0.113.7'],
    ['2001:db8::1:443', '2001:db8::1'],
    ['[2001:db8::1]:443', '2001:db8::1'],
    ['2001:db8::abcd', '2001:db8::abcd'],
    ['', undefined],
    [undefined, undefined],
    ['[broken', undefined],
  ])('viewerIpFromAddress(%j) -> %j', (input, expected) => {
    expect(viewerIpFromAddress(input)).toBe(expected);
  });

  it('normalises country and drops garbage', () => {
    expect(viewerInfo({ [VIEWER_ADDRESS_HEADER]: '1.2.3.4:1', [VIEWER_COUNTRY_HEADER]: 'kr' })).toEqual({
      ip: '1.2.3.4',
      country: 'KR',
    });
    expect(viewerInfo({ [VIEWER_COUNTRY_HEADER]: 'Korea' })).toEqual({ ip: undefined, country: undefined });
    expect(viewerInfo(undefined)).toEqual({ ip: undefined, country: undefined });
  });
});
