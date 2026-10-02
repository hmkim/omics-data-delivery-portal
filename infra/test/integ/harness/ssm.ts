import { GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { SSM_DEFAULTS, SSM_PARAMS } from '@genome-portal/contract';
import { aws } from './aws';
import { evidence } from './state';
import { sleep } from './util';

/** Lambdas cache SSM settings for 60 s (infra/lambda/shared/config.ts); wait a little longer. */
export const SETTINGS_PROPAGATION_MS = 65_000;

export type SettingKey = keyof typeof SSM_PARAMS;

export async function getSetting(key: SettingKey): Promise<string> {
  const out = await aws.ssm().send(new GetParameterCommand({ Name: SSM_PARAMS[key] }));
  const value = out.Parameter?.Value;
  if (value === undefined) throw new Error(`SSM parameter ${SSM_PARAMS[key]} has no value`);
  return value;
}

export async function putSetting(key: SettingKey, value: string): Promise<void> {
  await aws.ssm().send(new PutParameterCommand({ Name: SSM_PARAMS[key], Value: value, Overwrite: true }));
  evidence(`ssm ${SSM_PARAMS[key]} <- ${value}`);
}

/**
 * Set a runtime setting, wait for every Lambda container to drop its cache, run `fn`, then restore the
 * contract default in `finally` (and wait again when `waitAfterRestore`, so later tests see the default).
 */
export async function withSetting<T>(
  key: SettingKey,
  value: string,
  fn: () => Promise<T>,
  opts: { waitAfterRestore?: boolean; restoreBeforeFn?: boolean } = {},
): Promise<T> {
  const restoreValue = SSM_DEFAULTS[key];
  await putSetting(key, value);
  await sleep(SETTINGS_PROPAGATION_MS);
  try {
    return await fn();
  } finally {
    await putSetting(key, restoreValue);
    if (opts.waitAfterRestore !== false) await sleep(SETTINGS_PROPAGATION_MS);
  }
}

/** Restore a setting to its contract default without waiting (used when a test must restore immediately). */
export async function restoreSetting(key: SettingKey): Promise<void> {
  await putSetting(key, SSM_DEFAULTS[key]);
}

/** Fail fast when a previous interrupted run left a non-default value behind. */
export async function assertDefaults(keys: SettingKey[] = ['cfThreshold', 'urlTtlSeconds']): Promise<void> {
  for (const key of keys) {
    const value = await getSetting(key);
    if (value !== SSM_DEFAULTS[key]) {
      throw new Error(
        `SSM ${SSM_PARAMS[key]} = ${value}, expected default ${SSM_DEFAULTS[key]} (restore it: see test/integ/README.md)`,
      );
    }
  }
}
