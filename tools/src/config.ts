/**
 * CLI configuration: where the portal lives and which Cognito pool the admin signs in to.
 * Loaded from --config <path> or tools/admin.config.json (see admin.config.example.json).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AdminConfig {
  /** Cognito User Pool id (auth stack output UserPoolId) */
  userPoolId: string;
  /** Cognito App Client id (auth stack output ClientId) */
  clientId: string;
  /** Region of the user pool, e.g. ap-northeast-2 */
  region: string;
  /** Portal URL (web stack output PortalUrl), e.g. https://d123.cloudfront.net or https://portal.example.org */
  portalUrl: string;
}

const REQUIRED: Array<keyof AdminConfig> = ['userPoolId', 'clientId', 'region', 'portalUrl'];

export function defaultConfigPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'admin.config.json');
}

/** Validates the shape of a parsed config object. Exported for tests. */
export function parseAdminConfig(raw: unknown, source: string): AdminConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${source}: config must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  for (const key of REQUIRED) {
    const v = obj[key];
    if (typeof v !== 'string' || v.trim().length === 0) {
      throw new Error(`${source}: missing or empty "${key}"`);
    }
  }
  const portalUrl = (obj.portalUrl as string).replace(/\/+$/, '');
  if (!/^https:\/\//.test(portalUrl)) {
    throw new Error(`${source}: portalUrl must start with https://`);
  }
  return {
    userPoolId: obj.userPoolId as string,
    clientId: obj.clientId as string,
    region: obj.region as string,
    portalUrl,
  };
}

export function loadAdminConfig(configPath?: string): AdminConfig {
  const file = configPath ?? defaultConfigPath();
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `Cannot read admin config at ${file}. Copy tools/admin.config.example.json to tools/admin.config.json and fill in the auth/web stack outputs, or pass --config <path>.`,
    );
  }
  return parseAdminConfig(JSON.parse(text), file);
}
