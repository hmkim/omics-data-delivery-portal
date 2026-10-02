import type { PortalConfig } from '@genome-portal/contract';

/**
 * Runtime configuration (`/config.json`, written by the web stack). Loaded once in `main.tsx`
 * before anything else renders; every other module reads it synchronously through `getConfig()`.
 */
let current: PortalConfig | undefined;

const REQUIRED_KEYS: Array<keyof PortalConfig> = [
  'region',
  'accountId',
  'userPoolId',
  'clientId',
  'apiBase',
  'dataBucket',
  'cfDomain',
  'splitThresholdBytes',
  'singleObjectLimitBytes',
  'mfaMode',
  'brand',
];

export function assertPortalConfig(value: unknown): PortalConfig {
  if (typeof value !== 'object' || value === null) {
    throw new Error('config.json is not an object');
  }
  const record = value as Record<string, unknown>;
  const missing = REQUIRED_KEYS.filter((k) => record[k] === undefined || record[k] === null);
  if (missing.length > 0) {
    throw new Error(`config.json is missing: ${missing.join(', ')}`);
  }
  const brand = record.brand as Record<string, unknown>;
  for (const k of ['name', 'logoUrl', 'primaryColor']) {
    if (typeof brand[k] !== 'string') throw new Error(`config.json brand.${k} must be a string`);
  }
  if (typeof record.splitThresholdBytes !== 'number' || typeof record.singleObjectLimitBytes !== 'number') {
    throw new Error('config.json thresholds must be numbers');
  }
  return value as PortalConfig;
}

export async function loadConfig(url = '/config.json'): Promise<PortalConfig> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to load ${url}: HTTP ${res.status}`);
  }
  current = assertPortalConfig(await res.json());
  return current;
}

export function getConfig(): PortalConfig {
  if (!current) {
    throw new Error('Portal config has not been loaded; call loadConfig() first');
  }
  return current;
}

/** Test/bootstrap hook. */
export function setConfig(config: PortalConfig): void {
  current = config;
}
