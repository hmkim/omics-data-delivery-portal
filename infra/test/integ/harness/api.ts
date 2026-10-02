import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { ORIGIN_VERIFY_HEADER, ROUTES, type DownloadResponse } from '@genome-portal/contract';
import { aws } from './aws';
import { apiBase, portalBase, stackOutputs } from './outputs';
import { recordFirstDownload } from './state';

export interface ApiResponse<T = unknown> {
  status: number;
  json: T;
  headers: Headers;
  /** wall time of the round trip in ms */
  ms: number;
}

export type ApiMode = 'portal' | 'direct';

let originVerify: Promise<string> | undefined;

/** Value of Secrets Manager `genome-portal/origin-verify` (plain text or `{ value }`); never logged. */
async function originVerifyValue(): Promise<string> {
  originVerify ??= (async () => {
    const { OriginVerifySecretArn } = await stackOutputs();
    const out = await aws.secrets().send(new GetSecretValueCommand({ SecretId: OriginVerifySecretArn }));
    const raw = out.SecretString?.trim();
    if (!raw) throw new Error('origin-verify secret is empty');
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const candidate = parsed['value'] ?? parsed['secret'] ?? parsed['token'] ?? Object.values(parsed)[0];
      if (typeof candidate === 'string' && candidate !== '') return candidate;
    }
    return raw;
  })();
  return originVerify;
}

async function baseFor(mode: ApiMode): Promise<string> {
  return mode === 'portal' ? portalBase() : apiBase();
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * `api(token).get/post(route, body)` -> `{ status, json, headers, ms }` through the portal domain
 * (`${PortalUrl}/api/...`, CloudFront adds x-origin-verify). `api(token, 'direct')` calls API Gateway directly
 * and adds the header itself (latency measurements). Tokens never appear in logs or errors.
 */
export function api(token: string | undefined, mode: ApiMode = 'portal') {
  async function call<T = unknown>(
    method: 'GET' | 'POST',
    route: string,
    body?: unknown,
  ): Promise<ApiResponse<T>> {
    const base = await baseFor(mode);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers['authorization'] = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (mode === 'direct') headers[ORIGIN_VERIFY_HEADER] = await originVerifyValue();
    const started = performance.now();
    const res = await fetch(`${base}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await parse(res)) as T;
    const ms = performance.now() - started;
    return { status: res.status, json, headers: res.headers, ms };
  }
  return {
    get: <T = unknown>(route: string) => call<T>('GET', route),
    post: <T = unknown>(route: string, body: unknown) => call<T>('POST', route, body),
    /** `POST /api/downloads` that also records the run's first successful download for T6.7. */
    download: async (
      bucket: string,
      key: string,
      userSub: string,
    ): Promise<ApiResponse<DownloadResponse>> => {
      const res = await call<DownloadResponse>('POST', ROUTES.downloads, { bucket, key });
      if (res.status === 200 && res.json && typeof res.json.downloadId === 'string') {
        recordFirstDownload({
          downloadId: res.json.downloadId,
          bucket,
          key,
          userSub,
          issuedAt: new Date().toISOString(),
        });
      }
      return res;
    },
  };
}

export type Api = ReturnType<typeof api>;

/** Assert helper: a 200 with a typed body, otherwise throw with the API error body (no headers/tokens). */
export function expectOk<T>(res: ApiResponse<T>, what: string): T {
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`${what}: HTTP ${res.status} ${JSON.stringify(res.json)}`);
  }
  return res.json;
}
