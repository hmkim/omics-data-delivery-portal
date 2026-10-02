import { describe, expect, it } from 'vitest';
import {
  PART_SIZE_BYTES,
  SINGLE_OBJECT_LIMIT_BYTES,
  SPLIT_THRESHOLD_BYTES,
  grantScopeFor,
  modeHintForSize,
  nextPathForCount,
  parseScope,
  planClientMode,
  planParts,
} from '../src/index';

const settings = {
  splitThresholdBytes: SPLIT_THRESHOLD_BYTES,
  singleObjectLimitBytes: SINGLE_OBJECT_LIMIT_BYTES,
};
const GiB = 1024 ** 3;

describe('constants', () => {
  it('split threshold is 1 GiB and single-object limit is decimal 50 GB', () => {
    expect(SPLIT_THRESHOLD_BYTES).toBe(1_073_741_824);
    expect(SINGLE_OBJECT_LIMIT_BYTES).toBe(50_000_000_000);
    expect(SINGLE_OBJECT_LIMIT_BYTES).toBeLessThan(50 * GiB);
  });
});

describe('nextPathForCount (D4)', () => {
  it('threshold 1: first download S3, then CF', () => {
    expect(nextPathForCount(0, 1)).toBe('S3');
    expect(nextPathForCount(1, 1)).toBe('CF');
    expect(nextPathForCount(7, 1)).toBe('CF');
  });
  it('threshold 0: everything CF', () => {
    expect(nextPathForCount(0, 0)).toBe('CF');
  });
});

describe('planClientMode (design §5.4 matrix)', () => {
  it.each([
    [SPLIT_THRESHOLD_BYTES, true, 'single'],
    [SPLIT_THRESHOLD_BYTES, false, 'single'],
    [SPLIT_THRESHOLD_BYTES + 1, true, 'split'],
    [SPLIT_THRESHOLD_BYTES + 1, false, 'single'],
    [SINGLE_OBJECT_LIMIT_BYTES, true, 'split'],
    [SINGLE_OBJECT_LIMIT_BYTES, false, 'single'],
    [SINGLE_OBJECT_LIMIT_BYTES + 1, true, 'split'],
    [SINGLE_OBJECT_LIMIT_BYTES + 1, false, 'command'],
    [12 * GiB, true, 'split'],
    [12 * GiB, false, 'single'],
    [150 * GiB, true, 'split'],
    [150 * GiB, false, 'command'],
  ] as const)('size=%d fsAccess=%s -> %s', (size, fs, expected) => {
    expect(planClientMode(size, fs, settings)).toBe(expected);
  });

  it('server hint matches the split threshold', () => {
    expect(modeHintForSize(SPLIT_THRESHOLD_BYTES, SPLIT_THRESHOLD_BYTES)).toBe('single');
    expect(modeHintForSize(SPLIT_THRESHOLD_BYTES + 1, SPLIT_THRESHOLD_BYTES)).toBe('split');
  });
});

describe('planParts (R5.2)', () => {
  it('a file just over 1 GiB is one part with concurrency 1', () => {
    const plan = planParts(SPLIT_THRESHOLD_BYTES + 1);
    expect(plan.parts).toHaveLength(1);
    expect(plan.concurrency).toBe(1);
    expect(plan.parts[0]).toEqual({ idx: 0, start: 0, end: SPLIT_THRESHOLD_BYTES });
  });
  it('12 GiB is two parts (8 GiB + 4 GiB), concurrency 2', () => {
    const plan = planParts(12 * GiB);
    expect(plan.parts.map((p) => p.end - p.start + 1)).toEqual([PART_SIZE_BYTES, 4 * GiB]);
    expect(plan.concurrency).toBe(2);
  });
  it('150 GB is 18 parts with concurrency 4 and covers every byte exactly once', () => {
    const size = 150 * 1_000_000_000;
    const plan = planParts(size);
    expect(plan.parts).toHaveLength(Math.ceil(size / PART_SIZE_BYTES));
    expect(plan.concurrency).toBe(4);
    let expectedStart = 0;
    for (const p of plan.parts) {
      expect(p.start).toBe(expectedStart);
      expectedStart = p.end + 1;
    }
    expect(expectedStart).toBe(size);
  });
});

describe('parseScope (design §2.4)', () => {
  const bucket = 'genome-portal-data-123456789012-ap-northeast-2';
  it('accepts a well-formed prefix scope with or without the trailing *', () => {
    expect(parseScope(`s3://${bucket}/projects/P2026-0412/*`, bucket)).toEqual({
      bucket,
      prefix: 'projects/P2026-0412/',
    });
    expect(parseScope(`s3://${bucket}/projects/P2026-0412/`, bucket)).toEqual({
      bucket,
      prefix: 'projects/P2026-0412/',
    });
  });
  it.each([
    ['http://x/y/', 'not s3'],
    [`s3://other-bucket/projects/`, 'different bucket'],
    [`s3://${bucket}/`, 'bucket root'],
    [`s3://${bucket}/*`, 'bucket root with star'],
    [`s3://${bucket}/projects/P1`, 'no trailing slash'],
    [`s3://${bucket}/projects/../P1/`, 'dot-dot segment'],
    [`s3://${bucket}/projects//P1/`, 'empty segment'],
    [`s3://${bucket}/pro*jects/P1/`, 'inner wildcard'],
  ])('rejects %s (%s)', (scope) => {
    expect(parseScope(scope, bucket)).toBeNull();
  });
  it('grantScopeFor round-trips through parseScope', () => {
    const scope = grantScopeFor(bucket, 'projects/DEMO-0001/');
    expect(scope).toBe(`s3://${bucket}/projects/DEMO-0001/*`);
    expect(parseScope(scope, bucket)?.prefix).toBe('projects/DEMO-0001/');
  });
});
