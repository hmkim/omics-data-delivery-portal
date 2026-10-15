import { createCRC32 } from 'hash-wasm';

/**
 * R5.3: after a split download completes, the saved file is streamed back through hash-wasm CRC32
 * and the 4-byte big-endian digest is compared (base64) with S3's full-object `ChecksumCRC32`.
 */
export type ChecksumOutcome =
  | { status: 'ok'; actual: string }
  | { status: 'mismatch'; actual: string; expected: string }
  | { status: 'unverifiable'; actual: string };

/** base64 of the 4-byte big-endian CRC32, the same encoding S3 uses for `x-amz-checksum-crc32`. */
export function crc32ToBase64(digest: Uint8Array): string {
  if (digest.length !== 4) throw new Error(`CRC32 digest must be 4 bytes, got ${digest.length}`);
  let binary = '';
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary);
}

export async function crc32Base64FromStream(
  stream: ReadableStream<Uint8Array>,
  onProgress?: (bytesRead: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const hasher = await createCRC32();
  hasher.init();
  const reader = stream.getReader();
  let read = 0;
  for (;;) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => undefined);
      throw new DOMException('checksum aborted', 'AbortError');
    }
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
    read += value.byteLength;
    onProgress?.(read);
  }
  return crc32ToBase64(hasher.digest('binary'));
}

export async function crc32Base64FromBytes(bytes: Uint8Array): Promise<string> {
  const hasher = await createCRC32();
  hasher.init();
  hasher.update(bytes);
  return crc32ToBase64(hasher.digest('binary'));
}

export function compareChecksum(actual: string, expected: string | undefined): ChecksumOutcome {
  if (!expected) return { status: 'unverifiable', actual };
  return actual === expected ? { status: 'ok', actual } : { status: 'mismatch', actual, expected };
}

/** Streams a File (from `FileSystemFileHandle.getFile()`) and compares against the S3 value. */
export async function verifyFile(
  file: Blob,
  expectedCrc32Base64: string | undefined,
  onProgress?: (bytesRead: number) => void,
): Promise<ChecksumOutcome> {
  // `Blob.stream()` is the normal path (browsers); fall back to `arrayBuffer()` where it is missing (jsdom).
  const actual =
    typeof file.stream === 'function'
      ? await crc32Base64FromStream(file.stream() as ReadableStream<Uint8Array>, onProgress)
      : await crc32Base64FromBytes(new Uint8Array(await file.arrayBuffer()));
  if (typeof file.stream !== 'function') onProgress?.(file.size);
  return compareChecksum(actual, expectedCrc32Base64);
}
