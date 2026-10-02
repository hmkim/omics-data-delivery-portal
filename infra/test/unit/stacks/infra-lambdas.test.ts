/**
 * Unit tests for the two Lambdas owned by the infra brief: the signing-key custom resource
 * (infra/lambda/custom-resources/signing-key.ts) and the opsDaily job (infra/lambda/ops/daily.ts).
 */
import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ListAccessGrantsCommand, S3ControlClient } from '@aws-sdk/client-s3-control';
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  ResourceExistsException,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { CdkCustomResourceEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  aggregateRows,
  archiveAuditDay,
  buildLogQuery,
  listGrantScopes,
  listLedgerScopes,
  logMetrics,
  partitionFor,
  publishMetrics,
  readConfig,
  runAthenaQuery,
  runDaily,
  symmetricDifferenceSize,
  usageAllowancePct,
  yesterdayUtc,
  type OpsClients,
  type OpsConfig,
} from '../../../lambda/ops/daily';
import {
  generateSigningKeyPair,
  handler as signingKeyHandler,
  publicKeyFromPrivatePem,
} from '../../../lambda/custom-resources/signing-key';

// ---------------------------------------------------------------------------------------------- signing key CR
const smMock = mockClient(SecretsManagerClient);
const SECRET_ARN =
  'arn:aws:secretsmanager:ap-northeast-2:111111111111:secret:genome-portal/cf-signing-key-AbCdEf';

function crEvent(type: 'Create' | 'Update' | 'Delete', physicalId?: string): CdkCustomResourceEvent {
  const base = {
    ServiceToken: 'token',
    ResponseURL: 'https://example.com',
    StackId: 'stack',
    RequestId: 'req',
    LogicalResourceId: 'SigningKey',
    ResourceType: 'Custom::GenomePortalSigningKey',
    ResourceProperties: { ServiceToken: 'token', SecretName: 'genome-portal/cf-signing-key' },
  };
  if (type === 'Create') return { ...base, RequestType: 'Create' } as CdkCustomResourceEvent;
  if (type === 'Update') {
    return {
      ...base,
      RequestType: 'Update',
      PhysicalResourceId: physicalId!,
      OldResourceProperties: { ServiceToken: 'token' },
    } as CdkCustomResourceEvent;
  }
  return { ...base, RequestType: 'Delete', PhysicalResourceId: physicalId! } as CdkCustomResourceEvent;
}

describe('signing-key custom resource', () => {
  beforeEach(() => smMock.reset());

  it('generates an RSA-2048 pair whose public key can be derived from the private key', () => {
    const pair = generateSigningKeyPair();
    expect(pair.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(pair.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(publicKeyFromPrivatePem(pair.privateKeyPem)).toBe(pair.publicKeyPem);
  });

  it('Create stores the private PEM as SecretString and returns the public PEM + secret ARN', async () => {
    smMock.on(CreateSecretCommand).resolves({ ARN: SECRET_ARN });
    const res = await signingKeyHandler(crEvent('Create'));
    expect(res.PhysicalResourceId).toBe(SECRET_ARN);
    expect(res.Data?.SecretArn).toBe(SECRET_ARN);
    expect(res.Data?.PublicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    const call = smMock.commandCalls(CreateSecretCommand)[0]!.args[0].input;
    expect(call.Name).toBe('genome-portal/cf-signing-key');
    expect(call.SecretString).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(publicKeyFromPrivatePem(call.SecretString!)).toBe(res.Data?.PublicKeyPem);
  });

  it('Create adopts an existing secret instead of failing', async () => {
    const pair = generateSigningKeyPair();
    smMock.on(CreateSecretCommand).rejects(new ResourceExistsException({ message: 'exists', $metadata: {} }));
    smMock.on(GetSecretValueCommand).resolves({ ARN: SECRET_ARN, SecretString: pair.privateKeyPem });
    const res = await signingKeyHandler(crEvent('Create'));
    expect(res.PhysicalResourceId).toBe(SECRET_ARN);
    expect(res.Data?.PublicKeyPem).toBe(pair.publicKeyPem);
  });

  it('Update never rotates: returns the public key of the stored private key', async () => {
    const pair = generateSigningKeyPair();
    smMock.on(GetSecretValueCommand).resolves({ ARN: SECRET_ARN, SecretString: pair.privateKeyPem });
    const res = await signingKeyHandler(crEvent('Update', SECRET_ARN));
    expect(res.PhysicalResourceId).toBe(SECRET_ARN);
    expect(res.Data?.PublicKeyPem).toBe(pair.publicKeyPem);
    expect(smMock.commandCalls(CreateSecretCommand)).toHaveLength(0);
  });

  it('Update re-creates the secret if it was deleted by hand', async () => {
    smMock
      .on(GetSecretValueCommand)
      .rejects(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
    smMock.on(CreateSecretCommand).resolves({ ARN: SECRET_ARN });
    const res = await signingKeyHandler(crEvent('Update', SECRET_ARN));
    expect(res.PhysicalResourceId).toBe(SECRET_ARN);
    expect(smMock.commandCalls(CreateSecretCommand)).toHaveLength(1);
  });

  it('Delete force-deletes the secret and tolerates a missing one', async () => {
    smMock.on(DeleteSecretCommand).resolves({});
    await signingKeyHandler(crEvent('Delete', SECRET_ARN));
    expect(smMock.commandCalls(DeleteSecretCommand)[0]!.args[0].input).toEqual({
      SecretId: SECRET_ARN,
      ForceDeleteWithoutRecovery: true,
    });
    smMock.reset();
    smMock.on(DeleteSecretCommand).rejects(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
    await expect(signingKeyHandler(crEvent('Delete', SECRET_ARN))).resolves.toEqual({
      PhysicalResourceId: SECRET_ARN,
    });
  });

  it('rejects events without SecretName', async () => {
    const ev = crEvent('Create');
    (ev.ResourceProperties as Record<string, unknown>).SecretName = undefined;
    await expect(signingKeyHandler(ev)).rejects.toThrow(/SecretName/);
  });
});

// ---------------------------------------------------------------------------------------------- opsDaily
const athenaMock = mockClient(AthenaClient);
const cwMock = mockClient(CloudWatchClient);
const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const s3cMock = mockClient(S3ControlClient);

const cfg: OpsConfig = {
  accountId: '111111111111',
  region: 'ap-northeast-2',
  athenaWorkGroup: 'genome-portal-ops',
  athenaDatabase: 'genome-portal-logs',
  athenaTable: 'genome-portal-cf-access-logs',
  distributionId: 'E123',
  metricsNamespace: 'GenomePortal',
  granteeRoleArn: 'arn:aws:iam::111111111111:role/genome-portal-grantee-role',
  orgsTable: 'genome-portal-orgs',
  auditTable: 'genome-portal-audit-events',
  auditArchiveBucket: 'genome-portal-audit-archive-111111111111',
  allowanceBytes: 50 * 1024 ** 4,
};

function clients(): OpsClients {
  const cw = new CloudWatchClient({ region: 'ap-northeast-2' });
  return {
    athena: new AthenaClient({ region: 'ap-northeast-2' }),
    cloudwatch: cw,
    cloudwatchUsEast1: new CloudWatchClient({ region: 'us-east-1' }),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' })),
    s3: new S3Client({ region: 'ap-northeast-2' }),
    s3control: new S3ControlClient({ region: 'ap-northeast-2' }),
  };
}

const row = (...cells: string[]) => ({ Data: cells.map((v) => ({ VarCharValue: v })) });
const NOW = new Date('2026-10-15T16:00:00Z');

describe('opsDaily pure helpers', () => {
  it('dates and partitions', () => {
    expect(yesterdayUtc(NOW)).toBe('2026-10-14');
    expect(yesterdayUtc(new Date('2026-03-01T00:30:00Z'))).toBe('2026-02-28');
    expect(partitionFor('2026-10-14')).toBe('2026/10/14');
    expect(buildLogQuery('db', 'tbl', '2026-10-14')).toContain(`WHERE dt = '2026/10/14'`);
    expect(buildLogQuery('db', 'tbl', '2026-10-14')).toContain('"db"."tbl"');
    expect(buildLogQuery('db', 'tbl', '2026-10-14')).toContain('sum(try_cast(sc_bytes AS bigint))');
  });

  it('aggregates hit ratios, origin bytes and domestic/overseas bytes', () => {
    const agg = aggregateRows([
      row('Hit', 'KR', '80', '8000'),
      row('Miss', 'KR', '10', '1000'),
      row('RefreshHit', 'XX', '5', '500'),
      row('Error', 'XX', '5', '500'),
    ]);
    expect(agg).toEqual({
      requests: 100,
      hitRequests: 85,
      bytes: 10000,
      hitBytes: 8500,
      originBytes: 1500,
      bytesDomestic: 9000,
      bytesOverseas: 1000,
    });
    expect(logMetrics(agg)).toEqual({
      CacheHitRatioRequests: 85,
      CacheHitRatioBytes: 85,
      OriginBytes: 1500,
      BytesDomestic: 9000,
      BytesOverseas: 1000,
    });
    expect(logMetrics(aggregateRows([]))).toEqual({
      CacheHitRatioRequests: 0,
      CacheHitRatioBytes: 0,
      OriginBytes: 0,
      BytesDomestic: 0,
      BytesOverseas: 0,
    });
  });

  it('symmetric difference counts both directions', () => {
    expect(symmetricDifferenceSize(new Set(['a', 'b']), new Set(['b', 'c']))).toBe(2);
    expect(symmetricDifferenceSize(new Set(['a']), new Set(['a']))).toBe(0);
  });

  it('readConfig requires every variable', () => {
    expect(() => readConfig({})).toThrow(/missing env ACCOUNT_ID/);
    const env: NodeJS.ProcessEnv = {
      ACCOUNT_ID: cfg.accountId,
      PORTAL_REGION: cfg.region,
      ATHENA_WORKGROUP: cfg.athenaWorkGroup,
      ATHENA_DATABASE: cfg.athenaDatabase,
      ATHENA_TABLE: cfg.athenaTable,
      DISTRIBUTION_ID: cfg.distributionId,
      METRICS_NAMESPACE: cfg.metricsNamespace,
      GRANTEE_ROLE_ARN: cfg.granteeRoleArn,
      ORGS_TABLE: cfg.orgsTable,
      AUDIT_TABLE: cfg.auditTable,
      AUDIT_ARCHIVE_BUCKET: cfg.auditArchiveBucket,
      ALLOWANCE_BYTES: String(cfg.allowanceBytes),
    };
    expect(readConfig(env)).toEqual(cfg);
  });
});

describe('opsDaily AWS steps', () => {
  beforeEach(() => {
    athenaMock.reset();
    cwMock.reset();
    ddbMock.reset();
    s3Mock.reset();
    s3cMock.reset();
  });

  it('runAthenaQuery polls to SUCCEEDED, skips the header row and follows NextToken', async () => {
    athenaMock.on(StartQueryExecutionCommand).resolves({ QueryExecutionId: 'q1' });
    athenaMock
      .on(GetQueryExecutionCommand)
      .resolvesOnce({ QueryExecution: { Status: { State: 'RUNNING' } } })
      .resolves({ QueryExecution: { Status: { State: 'SUCCEEDED' } } });
    athenaMock
      .on(GetQueryResultsCommand, { QueryExecutionId: 'q1', NextToken: undefined })
      .resolves({
        ResultSet: {
          Rows: [row('result_type', 'region_class', 'requests', 'bytes'), row('Hit', 'KR', '1', '10')],
        },
        NextToken: 'n',
      })
      .on(GetQueryResultsCommand, { QueryExecutionId: 'q1', NextToken: 'n' })
      .resolves({ ResultSet: { Rows: [row('Miss', 'XX', '2', '20')] } });
    const rows = await runAthenaQuery(clients(), cfg, 'SELECT 1', 0);
    expect(rows).toHaveLength(2);
    expect(athenaMock.commandCalls(StartQueryExecutionCommand)[0]!.args[0].input.WorkGroup).toBe(
      cfg.athenaWorkGroup,
    );
  });

  it('runAthenaQuery surfaces FAILED queries', async () => {
    athenaMock.on(StartQueryExecutionCommand).resolves({ QueryExecutionId: 'q2' });
    athenaMock
      .on(GetQueryExecutionCommand)
      .resolves({ QueryExecution: { Status: { State: 'FAILED', StateChangeReason: 'boom' } } });
    await expect(runAthenaQuery(clients(), cfg, 'SELECT 1', 0)).rejects.toThrow(/FAILED: boom/);
  });

  it('usageAllowancePct sums month-to-date BytesDownloaded from us-east-1 against 50 TiB', async () => {
    cwMock
      .on(GetMetricStatisticsCommand)
      .resolves({ Datapoints: [{ Sum: 25 * 1024 ** 4 }, { Sum: 5 * 1024 ** 4 }] });
    const pct = await usageAllowancePct(clients(), cfg, NOW);
    expect(pct).toBeCloseTo(60);
    const input = cwMock.commandCalls(GetMetricStatisticsCommand)[0]!.args[0].input;
    expect(input.StartTime).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(input.Dimensions).toEqual([
      { Name: 'Region', Value: 'Global' },
      { Name: 'DistributionId', Value: 'E123' },
    ]);
  });

  it('grant drift compares grantee grants with LOC#/META ledger entries', async () => {
    s3cMock
      .on(ListAccessGrantsCommand)
      .resolvesOnce({ AccessGrantsList: [{ GrantScope: 's3://b/p1/*' }], NextToken: 't' })
      .resolves({ AccessGrantsList: [{ GrantScope: 's3://b/p2/*' }] });
    ddbMock
      .on(ScanCommand)
      .resolves({ Items: [{ grantScope: 's3://b/p1/*' }, { grantScope: 's3://b/p3/*' }] });
    const grants = await listGrantScopes(clients(), cfg);
    const ledger = await listLedgerScopes(clients(), cfg);
    expect(symmetricDifferenceSize(grants, ledger)).toBe(2);
    const scan = ddbMock.commandCalls(ScanCommand)[0]!.args[0].input;
    expect(scan.FilterExpression).toContain('begins_with(pk, :loc)');
    expect(s3cMock.commandCalls(ListAccessGrantsCommand)[0]!.args[0].input.GranteeIdentifier).toBe(
      cfg.granteeRoleArn,
    );
  });

  it('archiveAuditDay writes one JSONL object per day to Glacier IR', async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [{ pk: 'DAY#2026-10-14', sk: 'TS#a', type: 'DOWNLOAD_ISSUED' }] });
    s3Mock.on(PutObjectCommand).resolves({});
    const n = await archiveAuditDay(clients(), cfg, '2026-10-14');
    expect(n).toBe(1);
    const put = s3Mock.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(put).toMatchObject({
      Bucket: cfg.auditArchiveBucket,
      Key: 'audit/2026/10/14.jsonl',
      StorageClass: 'GLACIER_IR',
    });
    expect(String(put.Body)).toContain('"type":"DOWNLOAD_ISSUED"');
    expect(ddbMock.commandCalls(QueryCommand)[0]!.args[0].input.ExpressionAttributeValues).toEqual({
      ':pk': 'DAY#2026-10-14',
    });
  });

  it('publishMetrics uses the namespace and units', async () => {
    cwMock.on(PutMetricDataCommand).resolves({});
    await publishMetrics(
      clients(),
      cfg,
      { CacheHitRatioRequests: 50, OriginBytes: 10, GrantDrift: 1, UsageAllowancePct: NaN },
      NOW,
    );
    const input = cwMock.commandCalls(PutMetricDataCommand)[0]!.args[0].input;
    expect(input.Namespace).toBe('GenomePortal');
    const units = Object.fromEntries(input.MetricData!.map((m) => [m.MetricName, [m.Unit, m.Value]]));
    expect(units).toEqual({
      CacheHitRatioRequests: ['Percent', 50],
      OriginBytes: ['Bytes', 10],
      GrantDrift: ['Count', 1],
      UsageAllowancePct: ['Percent', 0],
    });
  });

  it('runDaily publishes what it could compute and still throws when a step fails', async () => {
    athenaMock.on(StartQueryExecutionCommand).rejects(new Error('athena down'));
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [{ Sum: 5 * 1024 ** 4 }] });
    cwMock.on(PutMetricDataCommand).resolves({});
    s3cMock.on(ListAccessGrantsCommand).resolves({ AccessGrantsList: [] });
    ddbMock.on(ScanCommand).resolves({ Items: [] });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    s3Mock.on(PutObjectCommand).resolves({});
    await expect(runDaily(clients(), cfg, NOW)).rejects.toThrow(
      /1 failed step.*cloudfront-logs: athena down/,
    );
    const published = cwMock
      .commandCalls(PutMetricDataCommand)[0]!
      .args[0].input.MetricData!.map((m) => m.MetricName);
    expect(published.sort()).toEqual(['GrantDrift', 'UsageAllowancePct']);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
  });
});
