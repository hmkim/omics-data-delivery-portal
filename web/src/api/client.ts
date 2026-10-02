import {
  API_BASE,
  ROUTES,
  type ApiError,
  type CredentialsRequest,
  type CredentialsResponse,
  type DownloadRequest,
  type DownloadResponse,
  type ListLocationsResponse,
  type ObjectStatusRequest,
  type ObjectStatusResponse,
  type RenewResponse,
} from '@genome-portal/contract';
import { fetchAuthSession } from 'aws-amplify/auth';
import { getConfig } from '../config';

/**
 * Thrown when no usable ID token can be obtained: no session, refresh token expired/revoked
 * (`NotAuthorizedException`), or the API keeps rejecting a freshly refreshed token.
 * `auth/session.ts` listens for it and pauses running downloads instead of failing them (R1.5).
 */
export class AuthExpiredError extends Error {
  readonly code = 'AUTH_EXPIRED' as const;
  constructor(message = 'Authentication session expired', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AuthExpiredError';
  }
}

/** Non-2xx response that is not an auth problem. `body` is the contract `ApiError` when the server sent one. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | undefined,
    readonly path: string,
  ) {
    super(body?.message ?? `${body?.error ?? 'HTTP_ERROR'} (${status}) on ${path}`);
    this.name = 'ApiRequestError';
  }
}

export type ApiEventType = 'activity' | 'auth-expired';

/**
 * Cross-module signals without import cycles: `activity` fires on every request (idle timer input),
 * `auth-expired` fires once per request that ended in `AuthExpiredError`.
 */
export const apiEvents = new EventTarget();

export interface ApiClientOptions {
  /** overridable for tests */
  fetchFn?: typeof fetch;
  /** overridable for tests; defaults to `fetchAuthSession` from aws-amplify */
  getSession?: (options?: {
    forceRefresh?: boolean;
  }) => Promise<{ tokens?: { idToken?: { toString(): string } } }>;
  sleep?: (ms: number) => Promise<void>;
  /** retries for 5xx / network errors (design §5: 2) */
  maxRetries?: number;
  /** base backoff in ms; attempt n waits base * 2^n */
  backoffBaseMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof Error && err.name === 'TypeError');
}

/** `/api/...` route → URL against `config.apiBase` (identical in production, different for local dev). */
export function resolveUrl(path: string): string {
  const base = getConfig().apiBase;
  if (base === API_BASE || !path.startsWith(API_BASE)) return path;
  return `${base.replace(/\/$/, '')}${path.slice(API_BASE.length)}`;
}

export function createApiClient(options: ApiClientOptions = {}) {
  const fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  const getSession = options.getSession ?? ((o) => fetchAuthSession(o));
  const sleep = options.sleep ?? defaultSleep;
  const maxRetries = options.maxRetries ?? 2;
  const backoffBaseMs = options.backoffBaseMs ?? 400;

  async function idToken(forceRefresh: boolean): Promise<string> {
    let session;
    try {
      session = await getSession(forceRefresh ? { forceRefresh: true } : undefined);
    } catch (cause) {
      throw new AuthExpiredError('Token refresh failed', { cause });
    }
    const token = session.tokens?.idToken?.toString();
    if (!token) throw new AuthExpiredError('No ID token in session');
    return token;
  }

  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    apiEvents.dispatchEvent(new Event('activity'));
    try {
      return await requestInner<T>(method, path, body);
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        apiEvents.dispatchEvent(new Event('auth-expired'));
      }
      throw err;
    }
  }

  async function requestInner<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = resolveUrl(path);
    let token = await idToken(false);
    let refreshed = false;
    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await fetchFn(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          credentials: 'omit',
        });
      } catch (err) {
        if (isNetworkError(err) && attempt < maxRetries) {
          await sleep(backoffBaseMs * 2 ** attempt);
          attempt += 1;
          continue;
        }
        throw err;
      }

      if (res.status === 401) {
        // The API rejected the token (expired between fetchAuthSession and the call, or revoked).
        // Force one refresh and retry once; a second 401 means the session is gone.
        if (refreshed) throw new AuthExpiredError('API rejected refreshed token');
        token = await idToken(true);
        refreshed = true;
        continue;
      }
      if (res.status >= 500 && attempt < maxRetries) {
        await sleep(backoffBaseMs * 2 ** attempt);
        attempt += 1;
        continue;
      }
      if (!res.ok) {
        let parsed: ApiError | undefined;
        try {
          parsed = (await res.json()) as ApiError;
        } catch {
          parsed = undefined;
        }
        throw new ApiRequestError(res.status, parsed, path);
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }
  }

  return {
    request,
    /** GET /api/locations */
    listLocations: () => request<ListLocationsResponse>('GET', ROUTES.locations),
    /** POST /api/credentials — `expiration` converted ISO → Date for the Storage Browser credentials store */
    getCredentials: async (req: CredentialsRequest) => {
      const res = await request<CredentialsResponse>('POST', ROUTES.credentials, req);
      return {
        credentials: {
          accessKeyId: res.credentials.accessKeyId,
          secretAccessKey: res.credentials.secretAccessKey,
          sessionToken: res.credentials.sessionToken,
          expiration: new Date(res.credentials.expiration),
        },
      };
    },
    /** POST /api/downloads */
    issueDownload: (req: DownloadRequest) => request<DownloadResponse>('POST', ROUTES.downloads, req),
    /** POST /api/downloads/{id}/renew */
    renewDownload: (downloadId: string) => request<RenewResponse>('POST', ROUTES.renew(downloadId)),
    /** POST /api/objects/status */
    objectStatus: (req: ObjectStatusRequest) =>
      request<ObjectStatusResponse>('POST', ROUTES.objectStatus, req),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** Default client used by the app. Tests construct their own via `createApiClient`. */
export const api: ApiClient = createApiClient();
