/**
 * Thin client for the portal's admin API (design §7.3). Every call goes through the web distribution
 * (`<portalUrl>/api/admin/*`), so CloudFront adds the x-origin-verify header and the Lambda sees the
 * viewer headers it expects. The ID token of an `admins` group member is sent as a Bearer token.
 */
import type {
  AdminAuditExportRequest,
  AdminAuditExportResponse,
  AdminLocationListResponse,
  AdminLocationRequest,
  AdminOrgRequest,
  AdminResetCountRequest,
  AdminUserRequest,
  ApiError,
  AuditEvent,
} from '@genome-portal/contract';
import { ROUTES } from '@genome-portal/contract';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface AdminApiOptions {
  portalUrl: string;
  /** Returns a valid ID token, signing in (or refreshing the cache) when needed. */
  getIdToken: () => Promise<string>;
  fetchImpl?: FetchLike;
  /** Retries on 5xx / network failure (default 2). Exponential backoff starting at `retryBaseMs`. */
  retries?: number;
  retryBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Raised for every non-2xx response; `status` and the parsed ApiError body are kept for the caller. */
export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | undefined,
    readonly route: string,
  ) {
    super(formatApiError(status, body, route));
    this.name = 'AdminApiError';
  }
}

/** Human-readable message for an ApiError body (contract). Exported for tests. */
export function formatApiError(status: number, body: ApiError | undefined, route: string): string {
  const hint = httpHint(status);
  if (!body) return `HTTP ${status} from ${route}${hint ? ` (${hint})` : ''}`;
  const parts = [`HTTP ${status} ${body.error}`];
  if (body.reason) parts.push(`reason=${body.reason}`);
  if (body.message) parts.push(`- ${body.message}`);
  if (hint) parts.push(`(${hint})`);
  return `${parts.join(' ')} [${route}]`;
}

function httpHint(status: number): string | undefined {
  switch (status) {
    case 401:
      return 'token rejected: sign in again';
    case 403:
      return 'forbidden: the account must be in the Cognito "admins" group';
    case 404:
      return 'not found';
    case 429:
      return 'throttled, retry later';
    default:
      return status >= 500 ? 'server error' : undefined;
  }
}

async function parseErrorBody(res: Response): Promise<ApiError | undefined> {
  try {
    const text = await res.text();
    if (!text) return undefined;
    const json = JSON.parse(text) as Partial<ApiError>;
    if (typeof json.error === 'string') return json as ApiError;
    return { error: 'UNKNOWN', message: text.slice(0, 500) };
  } catch {
    return undefined;
  }
}

export class AdminApiClient {
  private readonly fetchImpl: FetchLike;
  private readonly retries: number;
  private readonly retryBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: AdminApiOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.retries = opts.retries ?? 2;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private url(route: string): string {
    return `${this.opts.portalUrl.replace(/\/+$/, '')}${route}`;
  }

  async post<TReq, TRes>(route: string, body: TReq): Promise<TRes> {
    const token = await this.opts.getIdToken();
    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await this.fetchImpl(this.url(route), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        if (attempt < this.retries) {
          await this.sleep(this.retryBaseMs * 2 ** attempt);
          attempt += 1;
          continue;
        }
        throw new Error(`network error calling ${route}: ${(err as Error).message}`);
      }
      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : {}) as TRes;
      }
      if (res.status >= 500 && attempt < this.retries) {
        await this.sleep(this.retryBaseMs * 2 ** attempt);
        attempt += 1;
        continue;
      }
      throw new AdminApiError(res.status, await parseErrorBody(res), route);
    }
  }

  org(req: AdminOrgRequest) {
    return this.post<AdminOrgRequest, Record<string, unknown>>(ROUTES.adminOrgs, req);
  }

  location(req: AdminLocationRequest) {
    return this.post<AdminLocationRequest, Record<string, unknown>>(ROUTES.adminLocations, req);
  }

  locationList(orgId?: string) {
    const req: AdminLocationRequest = orgId ? { action: 'list', orgId } : { action: 'list' };
    return this.post<AdminLocationRequest, AdminLocationListResponse>(ROUTES.adminLocations, req);
  }

  user(req: AdminUserRequest) {
    return this.post<AdminUserRequest, Record<string, unknown>>(ROUTES.adminUsers, req);
  }

  resetCount(req: AdminResetCountRequest) {
    return this.post<AdminResetCountRequest, Record<string, unknown>>(ROUTES.adminResetCount, req);
  }

  auditExportPage(req: AdminAuditExportRequest) {
    return this.post<AdminAuditExportRequest, AdminAuditExportResponse>(ROUTES.adminAuditExport, req);
  }

  /**
   * All audit events of one UTC day, following nextToken until the server stops returning one.
   * `maxPages` guards against a server that keeps echoing the same token.
   */
  async *auditEventsForDay(day: string, maxPages = 10_000): AsyncGenerator<AuditEvent> {
    let nextToken: string | undefined;
    let pages = 0;
    do {
      const req: AdminAuditExportRequest = nextToken ? { day, nextToken } : { day };
      const page = await this.auditExportPage(req);
      for (const item of page.items ?? []) yield item;
      pages += 1;
      if (page.nextToken && page.nextToken === nextToken) {
        throw new Error(`audit export for ${day}: server returned the same nextToken twice`);
      }
      nextToken = page.nextToken;
      if (pages >= maxPages && nextToken) {
        throw new Error(`audit export for ${day}: more than ${maxPages} pages, aborting`);
      }
    } while (nextToken);
  }
}
