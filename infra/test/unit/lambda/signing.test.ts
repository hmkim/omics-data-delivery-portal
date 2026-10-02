import { TEST } from './helpers/fixtures';
import { TEST_PRIVATE_KEY_PEM, awsError, resetAllMocks, s3Mock, secretsMock } from './helpers/mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPublicKey, createVerify } from 'node:crypto';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  contentDisposition,
  encodeKeyPath,
  extractPrivateKeyPem,
  filenameFromKey,
  headObject,
  presignS3GetObject,
  resetSigningKeyCache,
  s3ClientFor,
  signCloudFrontUrl,
} from '../../../lambda/shared/signing';

const creds = {
  accessKeyId: 'ASIATEST',
  secretAccessKey: 'secret',
  sessionToken: 'token',
  expiration: new Date(Date.now() + 3600_000),
};

beforeEach(() => {
  resetAllMocks();
  resetSigningKeyCache();
});

describe('helpers', () => {
  it('encodes keys per segment and keeps slashes', () => {
    expect(encodeKeyPath('projects/P 1/sample #1.bam')).toBe('projects/P%201/sample%20%231.bam');
    expect(encodeKeyPath('a/b/c')).toBe('a/b/c');
  });

  it('filenameFromKey', () => {
    expect(filenameFromKey('projects/P1/sample02.bam')).toBe('sample02.bam');
    expect(filenameFromKey('flat.vcf')).toBe('flat.vcf');
  });

  it('content-disposition carries an RFC 8187 UTF-8 filename', () => {
    expect(contentDisposition('sample02.bam')).toBe(
      `attachment; filename="sample02.bam"; filename*=UTF-8''sample02.bam`,
    );
    const kr = contentDisposition('결과 (1).vcf');
    expect(kr).toContain(`filename*=UTF-8''%EA%B2%B0%EA%B3%BC%20%281%29.vcf`);
    expect(kr).toMatch(/filename="__ \(1\)\.vcf"/);
  });
});

describe('headObject', () => {
  it('returns size + full-object CRC32', async () => {
    s3Mock
      .on(HeadObjectCommand)
      .resolves({ ContentLength: 42, ChecksumCRC32: 'AbCd==', ChecksumType: 'FULL_OBJECT', ETag: '"e"' });
    const out = await headObject(s3ClientFor(creds), TEST.bucket, 'k');
    expect(out).toEqual({ sizeBytes: 42, checksumCrc32: 'AbCd==', etag: '"e"' });
    expect(s3Mock.commandCalls(HeadObjectCommand)[0]?.args[0].input).toEqual({
      Bucket: TEST.bucket,
      Key: 'k',
      ChecksumMode: 'ENABLED',
    });
  });

  it('drops composite checksums (not comparable with a whole-file CRC32)', async () => {
    s3Mock
      .on(HeadObjectCommand)
      .resolves({ ContentLength: 1, ChecksumCRC32: 'x', ChecksumType: 'COMPOSITE' });
    expect((await headObject(s3ClientFor(creds), 'b', 'k'))?.checksumCrc32).toBeUndefined();
  });

  it('404 -> undefined, other errors propagate', async () => {
    s3Mock
      .on(HeadObjectCommand)
      .rejectsOnce(awsError('NotFound', 404))
      .rejectsOnce(awsError('AccessDenied', 403));
    expect(await headObject(s3ClientFor(creds), 'b', 'k')).toBeUndefined();
    await expect(headObject(s3ClientFor(creds), 'b', 'k')).rejects.toThrow('AccessDenied');
  });
});

describe('S3 presign', () => {
  it('signs with the supplied credentials, expiry and attachment disposition', async () => {
    const url = new URL(
      await presignS3GetObject({
        client: s3ClientFor(creds),
        bucket: TEST.bucket,
        key: 'projects/P1/s.bam',
        filename: 's.bam',
        expiresInSeconds: 3600,
      }),
    );
    expect(url.hostname).toBe(`${TEST.bucket}.s3.${TEST.region}.amazonaws.com`);
    expect(url.pathname).toBe('/projects/P1/s.bam');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('token');
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^ASIATEST\//);
    expect(url.searchParams.get('response-content-disposition')).toContain('attachment');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('CloudFront canned-policy signing', () => {
  it('produces Expires/Signature/Key-Pair-Id and encodes the key', async () => {
    const expiresAt = new Date('2026-10-05T13:00:00Z');
    const signed = new URL(await signCloudFrontUrl({ key: 'projects/P 1/sample.bam', expiresAt }));
    expect(signed.origin).toBe(`https://${TEST.cfDomain}`);
    expect(signed.pathname).toBe('/projects/P%201/sample.bam');
    expect(signed.searchParams.get('Expires')).toBe(String(Math.floor(expiresAt.getTime() / 1000)));
    expect(signed.searchParams.get('Key-Pair-Id')).toBe(TEST.keyPairId);
    const sig = signed.searchParams.get('Signature') ?? '';
    expect(sig.length).toBeGreaterThan(100);

    // Verify the signature against the canned policy with the matching public key.
    const policy = JSON.stringify({
      Statement: [
        {
          Resource: `https://${TEST.cfDomain}/projects/P%201/sample.bam`,
          Condition: { DateLessThan: { 'AWS:EpochTime': Math.floor(expiresAt.getTime() / 1000) } },
        },
      ],
    });
    const normalised = sig.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/');
    const verifier = createVerify('RSA-SHA1');
    verifier.update(policy);
    expect(verifier.verify(createPublicKey(TEST_PRIVATE_KEY_PEM), Buffer.from(normalised, 'base64'))).toBe(
      true,
    );
  });

  it('loads the private key once', async () => {
    await signCloudFrontUrl({ key: 'a', expiresAt: new Date(Date.now() + 1000) });
    await signCloudFrontUrl({ key: 'b', expiresAt: new Date(Date.now() + 1000) });
    const keyLoads = secretsMock
      .commandCalls(GetSecretValueCommand)
      .filter((c) => c.args[0].input.SecretId?.includes('cf-signing-key'));
    expect(keyLoads).toHaveLength(1);
  });

  it('retries the key load after a failure', async () => {
    secretsMock
      .on(GetSecretValueCommand)
      .rejectsOnce(new Error('sm down'))
      .resolves({ SecretString: TEST_PRIVATE_KEY_PEM });
    await expect(signCloudFrontUrl({ key: 'a', expiresAt: new Date() })).rejects.toThrow('sm down');
    await expect(signCloudFrontUrl({ key: 'a', expiresAt: new Date() })).resolves.toContain('Signature=');
  });

  it('extractPrivateKeyPem accepts PEM or JSON and rejects garbage', () => {
    expect(extractPrivateKeyPem(TEST_PRIVATE_KEY_PEM)).toBe(TEST_PRIVATE_KEY_PEM.trim());
    expect(extractPrivateKeyPem(JSON.stringify({ privateKeyPem: TEST_PRIVATE_KEY_PEM }))).toBe(
      TEST_PRIVATE_KEY_PEM.trim(),
    );
    expect(() => extractPrivateKeyPem('{"privateKey":"nope"}')).toThrow(/PEM/);
    expect(() => extractPrivateKeyPem('random')).toThrow(/PEM/);
    expect(() => extractPrivateKeyPem(undefined)).toThrow(/SecretString/);
  });
});
