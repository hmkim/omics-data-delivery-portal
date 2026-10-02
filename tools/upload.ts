#!/usr/bin/env -S npx tsx
/**
 * tools/upload.ts --file <path> --bucket <name> --key <key> [--region ap-northeast-2]
 * Multipart upload with a FULL_OBJECT CRC32 checksum, verified against the local file (see src/upload.ts).
 * Exit codes: 0 verified, 2 checksum mismatch or not FULL_OBJECT, 1 other error.
 */
import { uploadWithFullObjectCrc32 } from './src/upload';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined || v.startsWith('--')) {
    if (fallback !== undefined) return fallback;
    console.error(`missing --${name}`);
    process.exit(1);
  }
  return v;
}

uploadWithFullObjectCrc32({
  file: arg('file'),
  bucket: arg('bucket'),
  key: arg('key'),
  region: arg('region', 'ap-northeast-2'),
  log: (l) => console.error(`[upload] ${l}`),
})
  .then((r) => {
    console.log(JSON.stringify(r));
    process.exit(r.verified ? 0 : 2);
  })
  .catch((err: unknown) => {
    console.error(`[upload] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
