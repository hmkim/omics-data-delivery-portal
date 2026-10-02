import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@genome-portal/contract';
import {
  AUDIT_CSV_COLUMNS,
  auditEventToCsvRow,
  auditEventsToCsv,
  csvHeader,
  escapeCsvField,
} from '../src/csv.js';

describe('escapeCsvField', () => {
  it('leaves plain values untouched', () => {
    expect(escapeCsvField('abc')).toBe('abc');
    expect(escapeCsvField(42)).toBe('42');
    expect(escapeCsvField(true)).toBe('true');
  });
  it('emits an empty field for undefined/null', () => {
    expect(escapeCsvField(undefined)).toBe('');
    expect(escapeCsvField(null)).toBe('');
  });
  it('quotes commas', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
  });
  it('quotes and doubles double quotes', () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });
  it('quotes line breaks (LF and CRLF)', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvField('line1\r\nline2')).toBe('"line1\r\nline2"');
  });
  it('handles a field that is only a quote', () => {
    expect(escapeCsvField('"')).toBe('""""');
  });
});

describe('audit CSV', () => {
  const event: AuditEvent = {
    type: 'DOWNLOAD_ISSUED',
    at: '2026-10-01T02:03:04.000Z',
    userSub: 'sub-1',
    orgId: 'KU-lab',
    bucket: 'genome-portal-data-111111111111-ap-northeast-2',
    key: 'projects/P2026-0412/sample "A", part1.bam',
    sizeBytes: 161061273600,
    path: 'CF',
    mode: 'split',
    ip: '203.0.113.7',
    country: 'KR',
    downloadId: 'dl-1',
  };

  it('uses the fixed column order', () => {
    expect(csvHeader()).toBe(
      'at,type,userSub,orgId,bucket,key,sizeBytes,path,mode,ip,country,downloadId,reason',
    );
    expect(AUDIT_CSV_COLUMNS).toHaveLength(13);
  });

  it('renders one row with escaping and empty trailing fields', () => {
    const row = auditEventToCsvRow(event);
    expect(row).toBe(
      '2026-10-01T02:03:04.000Z,DOWNLOAD_ISSUED,sub-1,KU-lab,genome-portal-data-111111111111-ap-northeast-2,' +
        '"projects/P2026-0412/sample ""A"", part1.bam",161061273600,CF,split,203.0.113.7,KR,dl-1,',
    );
    expect(row.split(',').length).toBeGreaterThanOrEqual(13);
  });

  it('renders an ACCESS_DENIED row with reason and without download fields', () => {
    const denied: AuditEvent = {
      type: 'ACCESS_DENIED',
      at: '2026-10-01T00:00:00.000Z',
      userSub: 'sub-2',
      orgId: 'other',
      bucket: 'b',
      key: 'projects/P2026-0001/x.vcf',
      reason: 'NOT_ASSIGNED',
    };
    expect(auditEventToCsvRow(denied)).toBe(
      '2026-10-01T00:00:00.000Z,ACCESS_DENIED,sub-2,other,b,projects/P2026-0001/x.vcf,,,,,,,NOT_ASSIGNED',
    );
  });

  it('builds a full document with CRLF and header', () => {
    const doc = auditEventsToCsv([event]);
    const lines = doc.split('\r\n');
    expect(lines[0]).toBe(csvHeader());
    expect(lines[1]).toBe(auditEventToCsvRow(event));
    expect(doc.endsWith('\r\n')).toBe(true);
  });
});
