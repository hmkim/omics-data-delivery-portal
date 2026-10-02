/**
 * Upload one local file to S3 as a multipart upload with a FULL_OBJECT CRC32 checksum, then verify the
 * checksum S3 recorded against the locally computed CRC32.
 *
 * Why not `aws s3 cp --checksum-algorithm CRC32` or lib-storage's Upload: both record a COMPOSITE checksum
 * for multipart uploads (`ChecksumType=COMPOSITE`, value like `C4/oTw==-128`). The portal verifies downloads
 * against the full-object CRC32 (R5.3), so seed objects must carry `ChecksumType=FULL_OBJECT`, which requires
 * declaring it on CreateMultipartUpload and supplying the whole-object CRC32 on CompleteMultipartUpload.
 */
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3';

export interface UploadOptions {
  file: string;
  bucket: string;
  key: string;
  region: string;
  /** Multipart part size in bytes (default 64 MiB; S3 minimum 5 MiB, at most 10,000 parts). */
  partSize?: number;
  /** Parallel part uploads (default 4). */
  concurrency?: number;
  log?: (line: string) => void;
}

export interface UploadResult {
  bytes: number;
  parts: number;
  checksumType: string | undefined;
  checksumCrc32: string | undefined;
  localCrc32: string;
  verified: boolean;
}

function crc32ToBase64(value: number): string {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value >>> 0);
  return buf.toString('base64');
}

/** Streaming CRC32 of a local file, base64-encoded like S3's `ChecksumCRC32`. */
export async function localCrc32Base64(file: string): Promise<string> {
  let value = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 8 * 1024 * 1024 })) {
    value = crc32(chunk as Buffer, value);
  }
  return crc32ToBase64(value);
}

export function planPartCount(size: number, partSize: number): number {
  return Math.max(1, Math.ceil(size / partSize));
}

export async function uploadWithFullObjectCrc32(opts: UploadOptions): Promise<UploadResult> {
  const log = opts.log ?? (() => undefined);
  const partSize = opts.partSize ?? 64 * 1024 * 1024;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const { size } = await stat(opts.file);
  const partCount = planPartCount(size, partSize);
  if (partCount > 10_000)
    throw new Error(`file needs ${partCount} parts of ${partSize} bytes; S3 allows 10,000`);
  const client = new S3Client({ region: opts.region });

  log(`crc32 of ${opts.file} (${size} bytes)`);
  const localCrc = await localCrc32Base64(opts.file);

  log(
    `multipart upload -> s3://${opts.bucket}/${opts.key} (${partCount} parts x ${partSize} bytes, ${concurrency} parallel)`,
  );
  const created = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: opts.bucket,
      Key: opts.key,
      ChecksumAlgorithm: 'CRC32',
      ChecksumType: 'FULL_OBJECT',
    }),
  );
  const uploadId = created.UploadId;
  if (!uploadId) throw new Error('CreateMultipartUpload returned no UploadId');

  const completed: CompletedPart[] = new Array(partCount);
  const handle = await open(opts.file, 'r');
  let next = 0;
  let done = 0;
  let lastPct = -1;
  try {
    const worker = async () => {
      for (;;) {
        const idx = next++;
        if (idx >= partCount) return;
        const start = idx * partSize;
        const length = Math.min(partSize, size - start);
        const body = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(body, 0, length, start);
        if (bytesRead !== length) throw new Error(`short read at part ${idx + 1}: ${bytesRead}/${length}`);
        const res = await client.send(
          new UploadPartCommand({
            Bucket: opts.bucket,
            Key: opts.key,
            UploadId: uploadId,
            PartNumber: idx + 1,
            Body: body,
            ContentLength: length,
            ChecksumAlgorithm: 'CRC32',
          }),
        );
        completed[idx] = { PartNumber: idx + 1, ETag: res.ETag, ChecksumCRC32: res.ChecksumCRC32 };
        done += 1;
        const pct = Math.floor((done / partCount) * 100);
        if (pct >= lastPct + 10) {
          lastPct = pct;
          log(`  ${pct}%`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, partCount) }, () => worker()));
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: opts.bucket,
        Key: opts.key,
        UploadId: uploadId,
        MultipartUpload: { Parts: completed },
        ChecksumCRC32: localCrc,
        ChecksumType: 'FULL_OBJECT',
        MpuObjectSize: size,
      }),
    );
  } catch (err) {
    await client
      .send(new AbortMultipartUploadCommand({ Bucket: opts.bucket, Key: opts.key, UploadId: uploadId }))
      .catch(() => undefined);
    throw err;
  } finally {
    await handle.close();
  }

  const head = await client.send(
    new HeadObjectCommand({ Bucket: opts.bucket, Key: opts.key, ChecksumMode: 'ENABLED' }),
  );
  const verified = head.ChecksumType === 'FULL_OBJECT' && head.ChecksumCRC32 === localCrc;
  log(
    `s3 ChecksumType=${head.ChecksumType ?? 'none'} ChecksumCRC32=${head.ChecksumCRC32 ?? 'none'} local=${localCrc} -> ${verified ? 'OK' : 'MISMATCH'}`,
  );
  return {
    bytes: size,
    parts: partCount,
    checksumType: head.ChecksumType,
    checksumCrc32: head.ChecksumCRC32,
    localCrc32: localCrc,
    verified,
  };
}
