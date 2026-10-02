import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl as presignS3 } from '@aws-sdk/s3-request-presigner';
import { getSignedUrl as signCloudFront } from '@aws-sdk/cloudfront-signer';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { secretsClient } from './clients';
import { regionOrUndefined, requireEnv } from './env';
import type { GrantCredentials } from './accessGrants';

/** S3 client bound to the Access Grants credentials of one download (design §4 step 3 and 5). */
export function s3ClientFor(credentials: GrantCredentials): S3Client {
  return new S3Client({
    region: regionOrUndefined(),
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      expiration: credentials.expiration,
    },
  });
}

/** `attachment; filename*=UTF-8''<percent-encoded>` (RFC 6266 / RFC 8187) plus an ASCII fallback. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Object key -> URL path: every segment percent-encoded, slashes kept. */
export function encodeKeyPath(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function filenameFromKey(key: string): string {
  const last = key
    .split('/')
    .filter((s) => s !== '')
    .pop();
  return last ?? key;
}

export interface HeadResult {
  sizeBytes: number;
  checksumCrc32?: string;
  etag?: string;
}

/** HeadObject with ChecksumMode ENABLED. Returns undefined on 404 (design §4 step 3). */
export async function headObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<HeadResult | undefined> {
  try {
    const out = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }),
    );
    const sizeBytes = out.ContentLength ?? 0;
    // Only a full-object CRC32 can be compared with the client's whole-file checksum (R5.3).
    const checksumCrc32 = out.ChecksumType === 'COMPOSITE' ? undefined : out.ChecksumCRC32;
    return { sizeBytes, checksumCrc32, etag: out.ETag };
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404)
      return undefined;
    throw err;
  }
}

export interface PresignS3Options {
  client: S3Client;
  bucket: string;
  key: string;
  filename: string;
  expiresInSeconds: number;
}

/** S3 path: SigV4 presigned GetObject signed with the Access Grants object credentials. */
export async function presignS3GetObject(opts: PresignS3Options): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: opts.bucket,
    Key: opts.key,
    ResponseContentDisposition: contentDisposition(opts.filename),
  });
  return presignS3(opts.client, command, { expiresIn: opts.expiresInSeconds });
}

// ---------------------------------------------------------------------------
// CloudFront canned-policy signing (design §4 step 5, §4.1)
// ---------------------------------------------------------------------------

let privateKeyPromise: Promise<string> | undefined;

/** Test hook. */
export function resetSigningKeyCache(): void {
  privateKeyPromise = undefined;
}

/** The secret is either the PEM itself or JSON with a `privateKey` (or `privateKeyPem`) member. */
export function extractPrivateKeyPem(secretString: string | undefined): string {
  if (!secretString) throw new Error('CloudFront signing key secret has no SecretString');
  const trimmed = secretString.trim();
  if (trimmed.startsWith('-----BEGIN')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const candidate = parsed['privateKey'] ?? parsed['privateKeyPem'] ?? parsed['pem'];
    if (typeof candidate === 'string' && candidate.trim().startsWith('-----BEGIN')) return candidate.trim();
  } catch {
    // not JSON
  }
  throw new Error('CloudFront signing key secret does not contain a PEM private key');
}

async function loadPrivateKey(): Promise<string> {
  const arn = requireEnv('CF_SIGNING_KEY_SECRET_ARN');
  const out = await secretsClient().send(new GetSecretValueCommand({ SecretId: arn }));
  return extractPrivateKeyPem(out.SecretString);
}

function getPrivateKey(): Promise<string> {
  if (!privateKeyPromise) {
    privateKeyPromise = loadPrivateKey().catch((err: unknown) => {
      privateKeyPromise = undefined;
      throw err;
    });
  }
  return privateKeyPromise;
}

export interface SignCloudFrontOptions {
  key: string;
  /** Absolute expiry of the URL. */
  expiresAt: Date;
}

/** CloudFront path: canned policy signed with the Key Group private key; key encoded per segment. */
export async function signCloudFrontUrl(opts: SignCloudFrontOptions): Promise<string> {
  const domain = requireEnv('CF_DOMAIN');
  const keyPairId = requireEnv('CF_KEY_PAIR_ID');
  const privateKey = await getPrivateKey();
  const url = `https://${domain}/${encodeKeyPath(opts.key)}`;
  return signCloudFront({ url, keyPairId, privateKey, dateLessThan: opts.expiresAt });
}
