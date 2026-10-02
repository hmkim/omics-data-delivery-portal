import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';

export interface ZipEntry {
  name: string;
  /** CRC32 as stored in the central directory, base64 big-endian (same encoding as S3 `x-amz-checksum-crc32`) */
  crc32Base64: string;
  crc32: number;
  uncompressedSize: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;

function crc32ToBase64(crc: number): string {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(crc >>> 0);
  return b.toString('base64');
}

/**
 * Lists the entries of a zip (including zip64 archives written by client-zip) from its central directory. Only the
 * tail of the file and the central directory are read, so this works for multi-GiB archives.
 */
export async function listZipEntries(path: string): Promise<ZipEntry[]> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65_557 + 20); // max EOCD (comment ≤ 65535) + zip64 locator
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error(`${path}: end-of-central-directory record not found`);
    let cdOffset: number = tail.readUInt32LE(eocd + 16);
    let cdSize: number = tail.readUInt32LE(eocd + 12);
    let entries: number = tail.readUInt16LE(eocd + 10);
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || entries === 0xffff) {
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== SIG_ZIP64_LOCATOR)
        throw new Error(`${path}: zip64 locator missing`);
      const zip64Offset = Number(tail.readBigUInt64LE(loc + 8));
      const rec = Buffer.alloc(56);
      await fh.read(rec, 0, 56, zip64Offset);
      if (rec.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw new Error(`${path}: zip64 EOCD signature mismatch`);
      entries = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const out: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < entries && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== SIG_CENTRAL)
        throw new Error(`${path}: central directory entry ${i} corrupt`);
      const crc32 = cd.readUInt32LE(p + 16);
      let uncompressedSize: number = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      if (uncompressedSize === 0xffffffff) {
        // zip64 extended information extra field: first 8 bytes are the uncompressed size
        let q = p + 46 + nameLen;
        const end = q + extraLen;
        while (q + 4 <= end) {
          const id = cd.readUInt16LE(q);
          const len = cd.readUInt16LE(q + 2);
          if (id === 0x0001 && len >= 8) {
            uncompressedSize = Number(cd.readBigUInt64LE(q + 4));
            break;
          }
          q += 4 + len;
        }
      }
      out.push({ name, crc32, crc32Base64: crc32ToBase64(crc32), uncompressedSize });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** CRC32 of a whole local file (streamed), base64 big-endian. */
export async function fileCrc32Base64(path: string): Promise<string> {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  let crc = 0xffffffff;
  for await (const chunk of createReadStream(path, { highWaterMark: 8 * 1024 * 1024 })) {
    const buf = chunk as Buffer;
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return crc32ToBase64((crc ^ 0xffffffff) >>> 0);
}
