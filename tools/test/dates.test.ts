import { describe, expect, it } from 'vitest';
import { expandDays, formatIsoDay, isIsoDay } from '../src/dates.js';

describe('isIsoDay', () => {
  it('accepts real dates', () => {
    expect(isIsoDay('2026-10-01')).toBe(true);
    expect(isIsoDay('2024-02-29')).toBe(true);
  });
  it('rejects malformed or impossible dates', () => {
    expect(isIsoDay('2026-1-1')).toBe(false);
    expect(isIsoDay('20261001')).toBe(false);
    expect(isIsoDay('2026-13-01')).toBe(false);
    expect(isIsoDay('2026-02-30')).toBe(false);
    expect(isIsoDay('2023-02-29')).toBe(false);
    expect(isIsoDay('2026-10-01T00:00:00Z')).toBe(false);
  });
});

describe('expandDays', () => {
  it('returns a single day for from == to', () => {
    expect(expandDays('2026-10-01', '2026-10-01')).toEqual(['2026-10-01']);
  });
  it('expands an inclusive range across a month boundary', () => {
    expect(expandDays('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
  });
  it('expands a whole month', () => {
    const days = expandDays('2026-10-01', '2026-10-31');
    expect(days).toHaveLength(31);
    expect(days[0]).toBe('2026-10-01');
    expect(days[30]).toBe('2026-10-31');
  });
  it('crosses a leap day and a year boundary', () => {
    expect(expandDays('2028-02-28', '2028-03-01')).toEqual(['2028-02-28', '2028-02-29', '2028-03-01']);
    expect(expandDays('2026-12-31', '2027-01-01')).toEqual(['2026-12-31', '2027-01-01']);
  });
  it('rejects reversed ranges and bad input', () => {
    expect(() => expandDays('2026-10-02', '2026-10-01')).toThrow(/must not be before/);
    expect(() => expandDays('2026/10/01', '2026-10-01')).toThrow(/--from/);
    expect(() => expandDays('2026-10-01', 'tomorrow')).toThrow(/--to/);
  });
  it('rejects ranges longer than maxDays', () => {
    expect(() => expandDays('2026-01-01', '2026-01-05', 3)).toThrow(/exceeds 3 days/);
  });
  it('formatIsoDay is UTC based', () => {
    expect(formatIsoDay(new Date(Date.UTC(2026, 9, 1, 23, 59))).toString()).toBe('2026-10-01');
  });
});
