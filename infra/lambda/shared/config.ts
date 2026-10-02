import { GetParametersCommand } from '@aws-sdk/client-ssm';
import {
  SSM_PARAMS,
  URL_TTL_MAX_SECONDS,
  URL_TTL_MIN_SECONDS,
  type RuntimeSettings,
} from '@genome-portal/contract';
import { ssmClient } from './clients';

/** Design §3: Lambdas cache the four SSM parameters for 60 seconds. */
export const SETTINGS_CACHE_MS = 60_000;

interface CacheEntry {
  settings: RuntimeSettings;
  loadedAt: number;
}

let cache: CacheEntry | undefined;
let inFlight: Promise<RuntimeSettings> | undefined;

/** Test hook: forget the cached settings. */
export function resetSettingsCache(): void {
  cache = undefined;
  inFlight = undefined;
}

function parseInteger(name: string, raw: string | undefined): number {
  if (raw === undefined) throw new Error(`SSM parameter ${name} is missing`);
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) throw new Error(`SSM parameter ${name} must be an integer, got "${raw}"`);
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) throw new Error(`SSM parameter ${name} is out of range: "${raw}"`);
  return value;
}

/** Validate the raw SSM strings into RuntimeSettings (exported for unit tests). */
export function parseSettings(raw: Partial<Record<keyof typeof SSM_PARAMS, string>>): RuntimeSettings {
  const cfThreshold = parseInteger(SSM_PARAMS.cfThreshold, raw.cfThreshold);
  if (cfThreshold < 0) throw new Error(`SSM parameter ${SSM_PARAMS.cfThreshold} must be >= 0`);

  const urlTtlSeconds = parseInteger(SSM_PARAMS.urlTtlSeconds, raw.urlTtlSeconds);
  if (urlTtlSeconds < URL_TTL_MIN_SECONDS || urlTtlSeconds > URL_TTL_MAX_SECONDS) {
    throw new Error(
      `SSM parameter ${SSM_PARAMS.urlTtlSeconds} must be within ${URL_TTL_MIN_SECONDS}..${URL_TTL_MAX_SECONDS}, got ${urlTtlSeconds}`,
    );
  }

  const splitThresholdBytes = parseInteger(SSM_PARAMS.splitThresholdBytes, raw.splitThresholdBytes);
  if (splitThresholdBytes <= 0)
    throw new Error(`SSM parameter ${SSM_PARAMS.splitThresholdBytes} must be > 0`);

  const singleObjectLimitBytes = parseInteger(SSM_PARAMS.singleObjectLimitBytes, raw.singleObjectLimitBytes);
  if (singleObjectLimitBytes <= 0)
    throw new Error(`SSM parameter ${SSM_PARAMS.singleObjectLimitBytes} must be > 0`);
  if (singleObjectLimitBytes < splitThresholdBytes) {
    throw new Error(
      `SSM parameter ${SSM_PARAMS.singleObjectLimitBytes} must be >= ${SSM_PARAMS.splitThresholdBytes}`,
    );
  }

  return { cfThreshold, urlTtlSeconds, splitThresholdBytes, singleObjectLimitBytes };
}

async function loadSettings(): Promise<RuntimeSettings> {
  const names = Object.values(SSM_PARAMS);
  const out = await ssmClient().send(new GetParametersCommand({ Names: names, WithDecryption: false }));
  if (out.InvalidParameters && out.InvalidParameters.length > 0) {
    throw new Error(`SSM parameters not found: ${out.InvalidParameters.join(', ')}`);
  }
  const byName = new Map<string, string>();
  for (const p of out.Parameters ?? []) if (p.Name && p.Value !== undefined) byName.set(p.Name, p.Value);
  return parseSettings({
    cfThreshold: byName.get(SSM_PARAMS.cfThreshold),
    urlTtlSeconds: byName.get(SSM_PARAMS.urlTtlSeconds),
    splitThresholdBytes: byName.get(SSM_PARAMS.splitThresholdBytes),
    singleObjectLimitBytes: byName.get(SSM_PARAMS.singleObjectLimitBytes),
  });
}

/** Current runtime settings, served from a 60 s cache. Concurrent cold-start calls share one SSM request. */
export async function getSettings(now: number = Date.now()): Promise<RuntimeSettings> {
  if (cache && now - cache.loadedAt < SETTINGS_CACHE_MS) return cache.settings;
  if (!inFlight) {
    inFlight = loadSettings()
      .then((settings) => {
        cache = { settings, loadedAt: now };
        return settings;
      })
      .finally(() => {
        inFlight = undefined;
      });
  }
  return inFlight;
}
