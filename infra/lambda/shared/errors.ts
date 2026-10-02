import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { AccessDeniedReason, ApiError } from '@genome-portal/contract';
import type { ZodType } from 'zod';

export const JSON_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
} as const;

/** An error that maps 1:1 to an HTTP response with an ApiError body (design §6). */
export class HttpError extends Error {
  readonly status: number;
  readonly body: ApiError;

  constructor(status: number, body: ApiError) {
    super(body.message ?? body.error);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export function jsonResponse(status: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return { statusCode: status, headers: { ...JSON_HEADERS }, body: JSON.stringify(body) };
}

export function badRequest(message: string, reason?: AccessDeniedReason | string): HttpError {
  return new HttpError(400, { error: 'BAD_REQUEST', message, ...(reason ? { reason } : {}) });
}

export function unauthorized(message = 'Missing or invalid JWT claims'): HttpError {
  return new HttpError(401, { error: 'UNAUTHORIZED', message });
}

export function forbidden(reason: AccessDeniedReason | string, message?: string): HttpError {
  return new HttpError(403, { error: 'FORBIDDEN', reason, message: message ?? `Forbidden: ${reason}` });
}

export function notFound(message = 'Not found'): HttpError {
  return new HttpError(404, { error: 'NOT_FOUND', message });
}

export function conflict(message: string): HttpError {
  return new HttpError(409, { error: 'CONFLICT', message });
}

export function unavailable(message = 'Service temporarily unavailable'): HttpError {
  return new HttpError(503, { error: 'UNAVAILABLE', message });
}

/** Convert any thrown value to a response. Unknown errors become 500 without leaking details. */
export function toResponse(err: unknown): APIGatewayProxyStructuredResultV2 {
  if (err instanceof HttpError) return jsonResponse(err.status, err.body);
  console.error(JSON.stringify({ level: 'error', message: 'unhandled', error: describeError(err) }));
  return jsonResponse(500, { error: 'INTERNAL', message: 'Internal error' } satisfies ApiError);
}

export function describeError(err: unknown): Record<string, string> {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: 'Unknown', message: String(err) };
}

/** Parse and validate the JSON request body; malformed or invalid input is a 400. */
export function parseBody<T>(
  event: Pick<APIGatewayProxyEventV2, 'body' | 'isBase64Encoded'>,
  schema: ZodType<T>,
): T {
  if (event.body === undefined || event.body === null || event.body === '')
    throw badRequest('Request body is required');
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest('Request body is not valid JSON');
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    throw badRequest(`Invalid request body: ${where}${issue?.message ?? 'validation failed'}`);
  }
  return result.data;
}

/**
 * Run a handler body and turn its result or any thrown error into an HTTP API v2 response.
 * Every response, success or failure, carries content-type: application/json and cache-control: no-store.
 */
export async function respond(
  fn: () => Promise<{ status?: number; body: unknown }>,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const out = await fn();
    return jsonResponse(out.status ?? 200, out.body);
  } catch (err) {
    return toResponse(err);
  }
}
