import { LAMBDA_ENV } from '@genome-portal/contract';

export type EnvKey = keyof typeof LAMBDA_ENV;

/**
 * Read one Lambda environment variable by its contract key (LAMBDA_ENV) and fail loudly when it is
 * missing. Handlers call this at module scope so a misconfigured function fails at cold start, not
 * on the first request.
 */
export function requireEnv(key: EnvKey): string {
  const name = LAMBDA_ENV[key];
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name} (LAMBDA_ENV.${key})`);
  }
  return value;
}

/** Read several variables at once; the result is keyed by contract key, not by variable name. */
export function readEnv<K extends EnvKey>(keys: readonly K[]): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const key of keys) out[key] = requireEnv(key);
  return out;
}

/** Region for SDK clients. Optional: the SDK falls back to its own resolution when unset. */
export function regionOrUndefined(): string | undefined {
  const value = process.env[LAMBDA_ENV.REGION];
  return value && value.trim() !== '' ? value : undefined;
}
