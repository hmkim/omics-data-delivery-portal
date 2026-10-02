/**
 * Date helpers for `audit export --from --to`. Audit events are partitioned by UTC day (DAY#yyyy-mm-dd),
 * so a range is expanded into one API call per day.
 */

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Returns true when `s` is a real calendar date written as YYYY-MM-DD (UTC). */
export function isIsoDay(s: string): boolean {
  const m = ISO_DAY.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function formatIsoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Inclusive list of days from `from` to `to`. Throws on malformed input or when `to` precedes `from`.
 * A range longer than `maxDays` is rejected so a typo (e.g. wrong year) does not fire thousands of requests.
 */
export function expandDays(from: string, to: string, maxDays = 400): string[] {
  if (!isIsoDay(from)) throw new Error(`--from must be YYYY-MM-DD, got "${from}"`);
  if (!isIsoDay(to)) throw new Error(`--to must be YYYY-MM-DD, got "${to}"`);
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (end < start) throw new Error(`--to (${to}) must not be before --from (${from})`);
  const days: string[] = [];
  for (let t = start; t <= end; t += 86_400_000) {
    days.push(formatIsoDay(new Date(t)));
    if (days.length > maxDays) {
      throw new Error(`range ${from}..${to} exceeds ${maxDays} days; split the export`);
    }
  }
  return days;
}
