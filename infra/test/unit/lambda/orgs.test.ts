import { TEST } from './helpers/fixtures';
import { ddbMock, resetAllMocks } from './helpers/mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  findAssignedLocation,
  getOrg,
  isLocationAssigned,
  isOrgActive,
  listOrgLocations,
  longestMatchingLocation,
  type OrgLocation,
} from '../../../lambda/shared/orgs';

beforeEach(() => resetAllMocks());

const B = TEST.bucket;
const locs: OrgLocation[] = [
  { bucket: B, prefix: 'projects/P1/' },
  { bucket: B, prefix: 'projects/P1/sub/' },
  { bucket: B, prefix: 'projects/P10/' },
  { bucket: 'other-bucket', prefix: 'projects/P1/sub/deep/' },
];

describe('longestMatchingLocation', () => {
  it('picks the longest prefix that covers the key', () => {
    expect(longestMatchingLocation(locs, B, 'projects/P1/sub/a.bam')?.prefix).toBe('projects/P1/sub/');
    expect(longestMatchingLocation(locs, B, 'projects/P1/a.bam')?.prefix).toBe('projects/P1/');
  });

  it('does not confuse P1 with P10 and respects the bucket', () => {
    expect(longestMatchingLocation(locs, B, 'projects/P10/x.vcf')?.prefix).toBe('projects/P10/');
    expect(longestMatchingLocation(locs, B, 'projects/P100/x.vcf')).toBeUndefined();
    expect(longestMatchingLocation(locs, 'other-bucket', 'projects/P1/sub/deep/x')?.bucket).toBe(
      'other-bucket',
    );
    expect(longestMatchingLocation(locs, 'other-bucket', 'projects/P1/x')).toBeUndefined();
  });

  it('returns undefined for keys outside every location', () => {
    expect(longestMatchingLocation(locs, B, 'projects/P2/x')).toBeUndefined();
    expect(longestMatchingLocation([], B, 'projects/P1/x')).toBeUndefined();
  });
});

describe('org lookups', () => {
  it('getOrg / isOrgActive', async () => {
    ddbMock
      .on(GetCommand, { Key: { pk: 'ORG#org-a', sk: 'META' } })
      .resolves({ Item: { pk: 'ORG#org-a', sk: 'META', name: 'A', active: true, createdAt: 't' } });
    ddbMock
      .on(GetCommand, { Key: { pk: 'ORG#org-off', sk: 'META' } })
      .resolves({ Item: { pk: 'ORG#org-off', sk: 'META', active: false } });
    ddbMock.on(GetCommand, { Key: { pk: 'ORG#none', sk: 'META' } }).resolves({});
    expect(await getOrg('org-a')).toEqual({ orgId: 'org-a', name: 'A', active: true, createdAt: 't' });
    expect(await getOrg('org-off')).toMatchObject({ name: 'org-off', active: false, createdAt: undefined });
    expect(await getOrg('none')).toBeUndefined();
    expect(await isOrgActive('org-a')).toBe(true);
    expect(await isOrgActive('org-off')).toBe(false);
    expect(await isOrgActive('none')).toBe(false);
  });

  it('listOrgLocations follows pagination and skips malformed rows', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({
        Items: [
          { pk: 'ORG#org-a', sk: `LOC#${B}/projects/P1/`, bucket: B, prefix: 'projects/P1/', label: 'L' },
          { pk: 'ORG#org-a', sk: 'LOC#bad' },
        ],
        LastEvaluatedKey: { pk: 'x' },
      })
      .resolvesOnce({
        Items: [{ pk: 'ORG#org-a', sk: `LOC#${B}/projects/P2/`, bucket: B, prefix: 'projects/P2/' }],
      });
    const out = await listOrgLocations('org-a');
    expect(out).toEqual([
      { bucket: B, prefix: 'projects/P1/', label: 'L', assignedAt: undefined },
      { bucket: B, prefix: 'projects/P2/', label: undefined, assignedAt: undefined },
    ]);
    const first = ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(first?.KeyConditionExpression).toBe('pk = :pk AND begins_with(sk, :loc)');
    expect(first?.ExpressionAttributeValues).toEqual({ ':pk': 'ORG#org-a', ':loc': 'LOC#' });
    expect(ddbMock.commandCalls(QueryCommand)[1]?.args[0].input.ExclusiveStartKey).toEqual({ pk: 'x' });
  });

  it('isLocationAssigned is a single GetItem on ORG#/LOC#', async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: { pk: 'ORG#org-a' } })
      .resolvesOnce({});
    expect(await isLocationAssigned('org-a', B, 'projects/P1/')).toBe(true);
    expect(await isLocationAssigned('org-a', B, 'projects/P9/')).toBe(false);
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input.Key).toEqual({
      pk: 'ORG#org-a',
      sk: `LOC#${B}/projects/P1/`,
    });
  });

  it('findAssignedLocation combines listing and longest match', async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: locs.map((l) => ({ ...l, pk: 'ORG#org-a', sk: `LOC#${l.bucket}/${l.prefix}` })) });
    expect((await findAssignedLocation('org-a', B, 'projects/P1/sub/x.bam'))?.prefix).toBe(
      'projects/P1/sub/',
    );
    expect(await findAssignedLocation('org-a', B, 'nope/x')).toBeUndefined();
  });
});
