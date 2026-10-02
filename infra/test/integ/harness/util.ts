export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `fn` until it returns a non-undefined value or `timeoutMs` elapses. */
export async function pollUntil<T>(
  fn: () => Promise<T | undefined>,
  opts: { timeoutMs: number; intervalMs: number; what: string },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() >= deadline)
      throw new Error(`${opts.what}: not observed within ${opts.timeoutMs} ms (${attempt} polls)`);
    await sleep(Math.min(opts.intervalMs, Math.max(0, deadline - Date.now())));
  }
}

/** Nearest-rank percentile of a sorted-or-not sample (p in 0..100). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? Number.NaN;
}

export function summarize(values: readonly number[]) {
  return {
    n: values.length,
    p50: Math.round(percentile(values, 50)),
    p95: Math.round(percentile(values, 95)),
    max: Math.round(Math.max(...values)),
    min: Math.round(Math.min(...values)),
    mean: Math.round(values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)),
  };
}

/** `20260928T062801Z` -> Date */
export function parseAmzDate(value: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) throw new Error(`not an X-Amz-Date: ${value}`);
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

/** Query parameters of an S3 SigV4 presigned URL that matter for the lifetime checks. */
export function s3UrlInfo(url: string) {
  const u = new URL(url);
  const expires = u.searchParams.get('X-Amz-Expires');
  const date = u.searchParams.get('X-Amz-Date');
  if (!expires || !date) throw new Error('URL is not a SigV4 presigned S3 URL');
  const signedAt = parseAmzDate(date);
  return {
    host: u.host,
    expiresSeconds: Number(expires),
    signedAt,
    expiresAt: new Date(signedAt.getTime() + Number(expires) * 1000),
  };
}

/** `Expires` / `Key-Pair-Id` of a CloudFront canned-policy URL. */
export function cfUrlInfo(url: string) {
  const u = new URL(url);
  const expires = u.searchParams.get('Expires');
  const keyPairId = u.searchParams.get('Key-Pair-Id');
  if (!expires || !keyPairId || !u.searchParams.get('Signature'))
    throw new Error('URL is not a signed CloudFront URL');
  return { host: u.host, expiresEpoch: Number(expires), keyPairId };
}

export interface RangeResult {
  status: number;
  contentRange: string | null;
  contentLength: number;
  bodyText?: string;
}

/** `GET url` with `Range: bytes=0-1048575`; the body is drained (not kept) unless the status is an error. */
export async function getRange(url: string, range = 'bytes=0-1048575'): Promise<RangeResult> {
  const res = await fetch(url, { headers: { range } });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    contentRange: res.headers.get('content-range'),
    contentLength: buf.length,
    bodyText: res.status >= 400 ? buf.toString('utf8').slice(0, 400) : undefined,
  };
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
