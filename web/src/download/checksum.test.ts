import { describe, expect, it } from 'vitest';
import {
  compareChecksum,
  crc32Base64FromBytes,
  crc32Base64FromStream,
  crc32ToBase64,
  verifyFile,
} from './checksum';

const enc = new TextEncoder();

/** CRC32("123456789") = 0xCBF43926 (the standard check value) → bytes CB F4 39 26 → base64 "y/Q5Jg==" */
const CHECK_VECTOR = enc.encode('123456789');
const CHECK_B64 = 'y/Q5Jg==';

describe('download/checksum (T3.9)', () => {
  it('CRC32 of the standard check vector matches the S3 base64 encoding', async () => {
    expect(await crc32Base64FromBytes(CHECK_VECTOR)).toBe(CHECK_B64);
  });

  it('CRC32 of empty input is 0 → "AAAAAA=="', async () => {
    expect(await crc32Base64FromBytes(new Uint8Array(0))).toBe('AAAAAA==');
  });

  it('streaming computation equals one-shot computation and reports progress', async () => {
    const chunks = [enc.encode('1234'), enc.encode('56'), enc.encode('789')];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    const seen: number[] = [];
    expect(await crc32Base64FromStream(stream, (n) => seen.push(n))).toBe(CHECK_B64);
    expect(seen).toEqual([4, 6, 9]);
  });

  it('crc32ToBase64 encodes big-endian 4 bytes and rejects other lengths', () => {
    expect(crc32ToBase64(new Uint8Array([0xcb, 0xf4, 0x39, 0x26]))).toBe(CHECK_B64);
    expect(() => crc32ToBase64(new Uint8Array(3))).toThrow();
  });

  it('compareChecksum: ok / mismatch / unverifiable', () => {
    expect(compareChecksum(CHECK_B64, CHECK_B64)).toEqual({ status: 'ok', actual: CHECK_B64 });
    expect(compareChecksum(CHECK_B64, 'AAAAAA==')).toEqual({
      status: 'mismatch',
      actual: CHECK_B64,
      expected: 'AAAAAA==',
    });
    expect(compareChecksum(CHECK_B64, undefined)).toEqual({ status: 'unverifiable', actual: CHECK_B64 });
  });

  it('verifyFile streams a Blob: match and mismatch', async () => {
    const blob = new Blob([CHECK_VECTOR]);
    expect((await verifyFile(blob, CHECK_B64)).status).toBe('ok');
    expect((await verifyFile(blob, 'AAAAAA==')).status).toBe('mismatch');
    expect((await verifyFile(blob, undefined)).status).toBe('unverifiable');
  });
});
