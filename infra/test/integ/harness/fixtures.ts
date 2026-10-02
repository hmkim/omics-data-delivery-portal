import { randomBytes } from 'node:crypto';
import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { ROUTES, type AdminLocationListResponse } from '@genome-portal/contract';
import { api, expectOk, type Api } from './api';
import { aws } from './aws';
import { signInAll, type SignedIn } from './auth';
import { stackOutputs, type StackOutputs } from './outputs';
import { evidence, runId } from './state';
import { ensureAllUsers, type TestUser, type TestUserKey } from './users';

export const PREFIXES = {
  a: 'projects/INTEG-A/',
  b: 'projects/INTEG-B/',
  perf: 'projects/PERF-1000/',
  noGrant: 'projects/INTEG-NOGRANT/',
  shared: 'projects/INTEG-SHARED/',
  demo: 'projects/DEMO-0001/',
} as const;

export const ORGS = {
  a: { orgId: 'integ-a', name: 'Integration org A' },
  b: { orgId: 'integ-b', name: 'Integration org B' },
} as const;

export const MiB = 1024 * 1024;
export const PERF_OBJECT_COUNT = 1000;
export const PERF_OBJECT_BYTES = 1024;
export const SEED_OBJECT_KEY = `${PREFIXES.demo}sample-1gib.bin`;

export interface Harness {
  outputs: StackOutputs;
  bucket: string;
  users: Record<TestUserKey, TestUser>;
  tokens: Record<TestUserKey, SignedIn>;
  api: Record<TestUserKey, Api>;
  runPrefix: string;
  /** Delete every per-run object (best effort). */
  cleanup: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Admin API driven org / assignment fixtures (persistent across runs)
// ---------------------------------------------------------------------------

export async function ensureOrg(admin: Api, org: { orgId: string; name: string }): Promise<void> {
  const res = await admin.post(ROUTES.adminOrgs, { action: 'create', orgId: org.orgId, name: org.name });
  if (res.status === 201) {
    evidence(`org ${org.orgId} created`);
    return;
  }
  if (res.status === 409) return; // already exists
  throw new Error(`create org ${org.orgId}: HTTP ${res.status} ${JSON.stringify(res.json)}`);
}

export async function assign(admin: Api, orgId: string, bucket: string, prefix: string) {
  const res = await admin.post<{ accessGrantId?: string; grantCreated: boolean }>(ROUTES.adminLocations, {
    action: 'assign',
    orgId,
    bucket,
    prefix,
  });
  const body = expectOk(res, `assign ${prefix} -> ${orgId}`);
  if (body.grantCreated) evidence(`grant created for ${prefix}: ${body.accessGrantId ?? '?'}`);
  return body;
}

export async function unassign(admin: Api, orgId: string, bucket: string, prefix: string) {
  const res = await admin.post<{ grantDeleted: boolean; remainingOrgs: string[] }>(ROUTES.adminLocations, {
    action: 'unassign',
    orgId,
    bucket,
    prefix,
  });
  return expectOk(res, `unassign ${prefix} from ${orgId}`);
}

export async function listLocations(admin: Api, orgId?: string): Promise<AdminLocationListResponse> {
  const res = await admin.post<AdminLocationListResponse>(ROUTES.adminLocations, { action: 'list', orgId });
  return expectOk(res, 'list locations');
}

/** Orgs integ-a / integ-b and their persistent prefixes (INTEG-A, INTEG-B, PERF-1000 -> integ-a). */
export async function ensureOrgFixtures(admin: Api, bucket: string): Promise<void> {
  await ensureOrg(admin, ORGS.a);
  await ensureOrg(admin, ORGS.b);
  const current = await listLocations(admin);
  const has = (orgId: string, prefix: string) =>
    current.items.some((it) => it.prefix === prefix && it.orgIds.includes(orgId) && it.accessGrantId);
  if (!has(ORGS.a.orgId, PREFIXES.a)) await assign(admin, ORGS.a.orgId, bucket, PREFIXES.a);
  if (!has(ORGS.b.orgId, PREFIXES.b)) await assign(admin, ORGS.b.orgId, bucket, PREFIXES.b);
  if (!has(ORGS.a.orgId, PREFIXES.perf)) await assign(admin, ORGS.a.orgId, bucket, PREFIXES.perf);
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

/** Single-part PutObject with CRC32 -> S3 records a FULL_OBJECT checksum (unlike multipart `aws s3 cp`). */
export async function putObject(bucket: string, key: string, bytes: number): Promise<void> {
  await aws.s3().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: randomBytes(bytes),
      ChecksumAlgorithm: 'CRC32',
    }),
  );
}

export async function headChecksum(bucket: string, key: string) {
  const out = await aws
    .s3()
    .send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }));
  return { size: out.ContentLength ?? 0, checksumType: out.ChecksumType, crc32: out.ChecksumCRC32 };
}

export async function countObjects(bucket: string, prefix: string): Promise<number> {
  let count = 0;
  let token: string | undefined;
  do {
    const out = await aws
      .s3()
      .send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    count += out.KeyCount ?? 0;
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return count;
}

export async function deletePrefix(bucket: string, prefix: string): Promise<number> {
  if (!prefix.startsWith('projects/INTEG-A/run-'))
    throw new Error(`refusing to delete outside per-run prefix: ${prefix}`);
  let deleted = 0;
  let token: string | undefined;
  do {
    const out = await aws
      .s3()
      .send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    const keys = (out.Contents ?? []).map((o) => ({ Key: o.Key ?? '' })).filter((k) => k.Key !== '');
    if (keys.length > 0) {
      await aws
        .s3()
        .send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }));
      deleted += keys.length;
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}

/** The one object under INTEG-B used for isolation checks (persistent, tiny). */
export const INTEG_B_OBJECT_KEY = `${PREFIXES.b}isolation-probe.bin`;

export async function ensureIntegBObject(bucket: string): Promise<void> {
  try {
    await aws.s3().send(new HeadObjectCommand({ Bucket: bucket, Key: INTEG_B_OBJECT_KEY }));
  } catch {
    await putObject(bucket, INTEG_B_OBJECT_KEY, 4096);
    evidence(`created ${INTEG_B_OBJECT_KEY}`);
  }
}

/** projects/PERF-1000/: 1,000 x 1 KiB objects, created idempotently with concurrency 16 (M7 uses it). */
export async function ensurePerfFixture(bucket: string): Promise<{ created: number; total: number }> {
  const existing = await countObjects(bucket, PREFIXES.perf);
  if (existing >= PERF_OBJECT_COUNT) return { created: 0, total: existing };
  const keys = Array.from(
    { length: PERF_OBJECT_COUNT },
    (_, i) => `${PREFIXES.perf}obj-${String(i + 1).padStart(4, '0')}.bin`,
  );
  let next = 0;
  let created = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= keys.length) return;
      const key = keys[i] ?? '';
      await putObject(bucket, key, PERF_OBJECT_BYTES);
      created += 1;
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  const total = await countObjects(bucket, PREFIXES.perf);
  evidence(`PERF-1000 fixture: created ${created}, total ${total}`);
  return { created, total };
}

// ---------------------------------------------------------------------------
// Per-run object factory
// ---------------------------------------------------------------------------

export function runPrefix(): string {
  return `${PREFIXES.a}run-${runId()}/`;
}

let objectSeq = 0;

/** Upload a fresh object under the run prefix and return its key; `label` keeps the run log readable. */
export async function freshObject(bucket: string, label: string, bytes = MiB): Promise<string> {
  objectSeq += 1;
  const key = `${runPrefix()}${label}-${String(objectSeq).padStart(2, '0')}-${randomBytes(3).toString('hex')}.bin`;
  await putObject(bucket, key, bytes);
  return key;
}

// ---------------------------------------------------------------------------
// One-call setup used by every test file's beforeAll
// ---------------------------------------------------------------------------

export async function setupHarness(opts: { ensureFixtures?: boolean } = {}): Promise<Harness> {
  const outputs = await stackOutputs();
  const bucket = outputs.DataBucketName;
  const users = await ensureAllUsers();
  const tokens = await signInAll(users);
  const clients: Record<TestUserKey, Api> = {
    a: api(tokens.a.idToken),
    b: api(tokens.b.idToken),
    admin: api(tokens.admin.idToken),
  };
  if (opts.ensureFixtures !== false) {
    await ensureOrgFixtures(clients.admin, bucket);
    await ensureIntegBObject(bucket);
  }
  const prefix = runPrefix();
  return {
    outputs,
    bucket,
    users,
    tokens,
    api: clients,
    runPrefix: prefix,
    cleanup: async () => {
      try {
        const n = await deletePrefix(bucket, prefix);
        if (n > 0) console.info(`[fixtures] deleted ${n} per-run object(s) under ${prefix}`);
      } catch (err) {
        console.warn(`[fixtures] cleanup of ${prefix} failed: ${(err as Error).message}`);
      }
    },
  };
}
