import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { OUTPUT_DIR } from '../../playwright.config';

/** Facts about the dev deployment the suite runs against. Edit for your account, or override with env vars. */
export const DEV = {
  region: 'ap-northeast-2',
  accountId: '123456789012',
  dataBucket: 'genome-portal-data-123456789012-ap-northeast-2',
  userPoolId: 'ap-northeast-2_EXAMPLE',
  athena: {
    database: 'genome-portal-logs',
    table: 'genome-portal-cf-access-logs',
    workGroup: 'genome-portal-ops',
  },
  /** org `demo` locations as they appear in the LocationsView name column */
  locations: {
    demo: 'projects/DEMO-0001/',
    perf: 'projects/PERF-1000/',
  },
} as const;

export const GiB = 1024 ** 3;

export interface SampleObject {
  name: string;
  key: string;
  sizeBytes: number;
  /** S3 full-object CRC32, base64 (`x-amz-checksum-crc32`) */
  crc32: string;
}

export const OBJECTS = {
  gib1: {
    name: 'sample-1gib.bin',
    key: 'projects/DEMO-0001/sample-1gib.bin',
    sizeBytes: GiB,
    crc32: '44SoTA==',
  },
  /**
   * Smallest split object above the 1 GiB threshold that still takes long enough to pause/reload mid-transfer
   * (single part, PART_SIZE_BYTES = 8 GiB). Used by the Firefox export e2e: Playwright's Firefox (Juggler
   * NetworkObserver) keeps every in-flight response body in the browser parent process until the request ends,
   * so a 12 GiB run holds >10 GB and stalls the host; 2 GiB exercises the same code path at a fraction of that.
   */
  gib2: {
    name: 'sample-2gib.bin',
    key: 'projects/DEMO-0001/sample-2gib.bin',
    sizeBytes: 2 * GiB,
    crc32: '9SRMCg==',
  },
  gib12: {
    name: 'sample-12gib.bin',
    key: 'projects/DEMO-0001/sample-12gib.bin',
    sizeBytes: 12 * GiB,
    crc32: '/sXQ3A==',
  },
  gib53: {
    name: 'sample-53gib.bin',
    key: 'projects/DEMO-0001/sample-53gib.bin',
    sizeBytes: 53 * GiB,
    crc32: '/yAtGQ==',
  },
  /** second 1 GiB object for the zip test; does not exist until the parent copies it (see README) */
  gib1Copy: {
    name: 'sample-1gib-copy.bin',
    key: 'projects/DEMO-0001/sample-1gib-copy.bin',
    sizeBytes: GiB,
    crc32: '44SoTA==',
  },
} satisfies Record<string, SampleObject>;

/** Object used by the CloudFront cache test (T7.6): 12 GiB by default, 53 GiB only when the parent sets it. */
export function bigFile(): SampleObject {
  const name = process.env.E2E_BIG_FILE ?? OBJECTS.gib12.name;
  const found = Object.values(OBJECTS).find((o) => o.name === name);
  if (!found)
    throw new Error(
      `E2E_BIG_FILE=${name} is not one of ${Object.values(OBJECTS)
        .map((o) => o.name)
        .join(', ')}`,
    );
  return found;
}

/** Directory for downloaded files / measurements of one run (under `E2E_OUTPUT_DIR`). */
export function outputPath(...parts: string[]): string {
  const p = resolve(OUTPUT_DIR, ...parts);
  mkdirSync(resolve(p, '..'), { recursive: true });
  return p;
}

/** Test files and the metric log print through this so the numbers stand out in the reporter output. */
export function metric(name: string, value: string | number, unit = ''): void {
  console.log(`[e2e-metric] ${name} = ${value}${unit ? ` ${unit}` : ''}`);
}

export function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
