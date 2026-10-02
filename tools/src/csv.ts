/**
 * CSV assembly for `audit export` (R6.3). Column order is fixed so downstream spreadsheets stay stable.
 */
import type { AuditEvent } from '@genome-portal/contract';

export const AUDIT_CSV_COLUMNS = [
  'at',
  'type',
  'userSub',
  'orgId',
  'bucket',
  'key',
  'sizeBytes',
  'path',
  'mode',
  'ip',
  'country',
  'downloadId',
  'reason',
] as const satisfies ReadonlyArray<keyof AuditEvent>;

export type AuditCsvColumn = (typeof AUDIT_CSV_COLUMNS)[number];

/**
 * RFC 4180 escaping: a field containing a comma, a double quote, CR or LF is wrapped in double quotes
 * and embedded double quotes are doubled. Everything else is emitted verbatim.
 */
export function escapeCsvField(value: unknown): string {
  if (value === undefined || value === null) return '';
  const s = typeof value === 'string' ? value : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function auditEventToCsvRow(event: AuditEvent): string {
  return AUDIT_CSV_COLUMNS.map((col) => escapeCsvField(event[col])).join(',');
}

export function csvHeader(): string {
  return AUDIT_CSV_COLUMNS.join(',');
}

/** Full CSV document (header + rows), CRLF line endings, trailing newline. */
export function auditEventsToCsv(events: Iterable<AuditEvent>): string {
  const lines = [csvHeader()];
  for (const e of events) lines.push(auditEventToCsvRow(e));
  return lines.join('\r\n') + '\r\n';
}
