import { timingSafeEqual } from 'node:crypto';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { ORIGIN_VERIFY_HEADER, VIEWER_ADDRESS_HEADER, VIEWER_COUNTRY_HEADER } from '@genome-portal/contract';
import { secretsClient } from './clients';
import { requireEnv } from './env';
import { forbidden } from './errors';

export interface ViewerInfo {
  ip?: string;
  country?: string;
}

type HeaderBag = Record<string, string | undefined> | undefined;

let secretPromise: Promise<Buffer> | undefined;

/** Test hook: drop the cached secret so the next call reloads it. */
export function resetOriginVerifyCache(): void {
  secretPromise = undefined;
}

/** Secrets Manager may hold the value as a bare string or as JSON `{ "value": "..." }`; accept both. */
export function extractSecretString(secretString: string | undefined): string {
  if (!secretString) throw new Error('origin-verify secret has no SecretString');
  const trimmed = secretString.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const candidate = parsed['value'] ?? parsed['secret'] ?? parsed['token'] ?? Object.values(parsed)[0];
      if (typeof candidate === 'string' && candidate !== '') return candidate;
    } catch {
      // not JSON after all; use the raw string
    }
  }
  return trimmed;
}

async function loadSecret(): Promise<Buffer> {
  const arn = requireEnv('ORIGIN_VERIFY_SECRET_ARN');
  const out = await secretsClient().send(new GetSecretValueCommand({ SecretId: arn }));
  return Buffer.from(extractSecretString(out.SecretString), 'utf8');
}

function getSecret(): Promise<Buffer> {
  if (!secretPromise) {
    secretPromise = loadSecret().catch((err: unknown) => {
      secretPromise = undefined;
      throw err;
    });
  }
  return secretPromise;
}

function header(headers: HeaderBag, name: string): string | undefined {
  if (!headers) return undefined;
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/** Constant-time comparison; a length mismatch is simply "not equal". */
export function secretsEqual(candidate: string, expected: Buffer): boolean {
  const a = Buffer.from(candidate, 'utf8');
  if (a.length !== expected.length) return false;
  return timingSafeEqual(a, expected);
}

/**
 * CloudFront-Viewer-Address is `ip:port`; IPv6 appears as `2001:db8::1:443` or `[2001:db8::1]:443`.
 * Strip the port and brackets and return the bare address.
 */
export function viewerIpFromAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const value = address.trim();
  if (value === '') return undefined;
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    return close > 1 ? value.slice(1, close) : undefined;
  }
  const lastColon = value.lastIndexOf(':');
  if (lastColon === -1) return value; // no port at all
  const host = value.slice(0, lastColon);
  const port = value.slice(lastColon + 1);
  if (!/^\d+$/.test(port)) return value; // an IPv6 address without a port
  return host;
}

/** Viewer IP and country from the CloudFront headers the web distribution forwards (design §6). */
export function viewerInfo(headers: HeaderBag): ViewerInfo {
  const ip = viewerIpFromAddress(header(headers, VIEWER_ADDRESS_HEADER));
  const countryRaw = header(headers, VIEWER_COUNTRY_HEADER)?.trim().toUpperCase();
  const country = countryRaw && /^[A-Z]{2}$/.test(countryRaw) ? countryRaw : undefined;
  return { ip, country };
}

/**
 * Reject requests that did not come through the web distribution: the `x-origin-verify` header must
 * equal the shared secret. Missing or mismatching header is 403. Returns the viewer info on success.
 */
export async function verifyOrigin(event: { headers?: HeaderBag }): Promise<ViewerInfo> {
  const provided = header(event.headers, ORIGIN_VERIFY_HEADER);
  const expected = await getSecret();
  if (!provided || !secretsEqual(provided, expected)) {
    throw forbidden('ORIGIN_VERIFY_FAILED', 'Request did not arrive through the portal distribution');
  }
  return viewerInfo(event.headers);
}
