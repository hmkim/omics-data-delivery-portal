import './helpers/fixtures';
import { resetAllMocks, ssmMock, ssmSettings } from './helpers/mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import { GetParametersCommand } from '@aws-sdk/client-ssm';
import { SSM_DEFAULTS, SSM_PARAMS } from '@genome-portal/contract';
import {
  SETTINGS_CACHE_MS,
  getSettings,
  parseSettings,
  resetSettingsCache,
} from '../../../lambda/shared/config';

beforeEach(() => {
  resetAllMocks();
  resetSettingsCache();
});

describe('parseSettings', () => {
  it('parses the contract defaults', () => {
    expect(parseSettings(SSM_DEFAULTS)).toEqual({
      cfThreshold: 1,
      urlTtlSeconds: 3600,
      splitThresholdBytes: 1_073_741_824,
      singleObjectLimitBytes: 50_000_000_000,
    });
  });

  it('accepts cf-threshold 0 (D4-B) and trims whitespace', () => {
    expect(parseSettings({ ...SSM_DEFAULTS, cfThreshold: ' 0 ' }).cfThreshold).toBe(0);
  });

  it.each([
    [{ cfThreshold: '-1' }, /must be >= 0/],
    [{ cfThreshold: 'one' }, /must be an integer/],
    [{ cfThreshold: undefined }, /is missing/],
    [{ urlTtlSeconds: '899' }, /within 900\.\.43200/],
    [{ urlTtlSeconds: '43201' }, /within 900\.\.43200/],
    [{ splitThresholdBytes: '0' }, /must be > 0/],
    [{ singleObjectLimitBytes: '0' }, /must be > 0/],
    [{ splitThresholdBytes: '100', singleObjectLimitBytes: '50' }, /must be >= /],
    [{ cfThreshold: '99999999999999999999' }, /out of range/],
  ])('rejects %j', (override, pattern) => {
    expect(() => parseSettings({ ...SSM_DEFAULTS, ...override } as never)).toThrow(pattern);
  });
});

describe('getSettings cache', () => {
  it('reads all four parameters in one call and caches for 60 s', async () => {
    const t0 = 1_000_000;
    const a = await getSettings(t0);
    const b = await getSettings(t0 + SETTINGS_CACHE_MS - 1);
    expect(a).toBe(b);
    expect(ssmMock.commandCalls(GetParametersCommand)).toHaveLength(1);
    const names = ssmMock.commandCalls(GetParametersCommand)[0]?.args[0].input.Names;
    expect(names).toEqual(Object.values(SSM_PARAMS));
    expect(names).toHaveLength(4);
  });

  it('reloads after the cache expires', async () => {
    const t0 = 5_000_000;
    await getSettings(t0);
    ssmMock.on(GetParametersCommand).resolves(ssmSettings({ cfThreshold: '0' }));
    const fresh = await getSettings(t0 + SETTINGS_CACHE_MS);
    expect(fresh.cfThreshold).toBe(0);
    expect(ssmMock.commandCalls(GetParametersCommand)).toHaveLength(2);
  });

  it('shares one in-flight request between concurrent callers', async () => {
    const [a, b] = await Promise.all([getSettings(1), getSettings(1)]);
    expect(a).toEqual(b);
    expect(ssmMock.commandCalls(GetParametersCommand)).toHaveLength(1);
  });

  it('fails clearly when a parameter is missing', async () => {
    ssmMock
      .on(GetParametersCommand)
      .resolves({ Parameters: [], InvalidParameters: [SSM_PARAMS.cfThreshold] });
    await expect(getSettings(1)).rejects.toThrow(/not found: \/genome-portal\/cf-threshold/);
    // a failed load must not poison the cache
    ssmMock.on(GetParametersCommand).resolves(ssmSettings());
    await expect(getSettings(2)).resolves.toMatchObject({ cfThreshold: 1 });
  });
});
