import { makeEvent, ADMIN, USER_A } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';
import { getClaims, getOrgClaims, isAdmin, parseGroups, requireAdmin } from '../../../lambda/shared/auth';
import { HttpError } from '../../../lambda/shared/errors';

function expectHttp(fn: () => unknown, status: number, reason?: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(status);
    if (reason) expect((err as HttpError).body.reason).toBe(reason);
    return;
  }
  throw new Error(`expected HttpError ${status}`);
}

describe('auth claims', () => {
  it('extracts sub, orgId, lang and groups', () => {
    const ev = makeEvent({ claims: { ...USER_A, groups: ['admins', 'x'], lang: 'en' } });
    expect(getClaims(ev)).toEqual({
      sub: USER_A.sub,
      orgId: USER_A.orgId,
      lang: 'en',
      groups: ['admins', 'x'],
      email: undefined,
    });
  });

  it('401 when the authorizer or sub is missing', () => {
    expectHttp(() => getClaims(makeEvent({ claims: null })), 401);
    expectHttp(() => getClaims(makeEvent({ claims: { orgId: 'o' } })), 401);
  });

  it('403 ORG_INACTIVE when the user has no organisation', () => {
    expectHttp(() => getOrgClaims(makeEvent({ claims: { sub: 's' } })), 403, 'ORG_INACTIVE');
    expect(getOrgClaims(makeEvent()).orgId).toBe(USER_A.orgId);
  });

  it('ignores unknown lang values', () => {
    expect(getClaims(makeEvent({ claims: { ...USER_A, lang: 'fr' } })).lang).toBeUndefined();
  });

  it('requireAdmin needs the admins group', () => {
    const admin = getClaims(makeEvent({ claims: ADMIN }));
    expect(isAdmin(admin)).toBe(true);
    expect(() => requireAdmin(admin)).not.toThrow();
    const user = getClaims(makeEvent());
    expectHttp(() => requireAdmin(user), 403, 'NOT_ADMIN');
    // string-encoded groups as HTTP API serialises them
    expect(isAdmin(getClaims(makeEvent({ claims: { sub: 's', groups: '[admins]' } })))).toBe(true);
  });
});

describe('parseGroups', () => {
  it.each([
    [
      ['a', 'b'],
      ['a', 'b'],
    ],
    ['["admins","other"]', ['admins', 'other']],
    ['[admins other]', ['admins', 'other']],
    ['[admins, other]', ['admins', 'other']],
    ['admins', ['admins']],
    ['admins,other', ['admins', 'other']],
    ['', []],
    ['[]', []],
    [undefined, []],
    [42, []],
  ])('parses %j -> %j', (input, expected) => {
    expect(parseGroups(input as never)).toEqual(expected);
  });
});
