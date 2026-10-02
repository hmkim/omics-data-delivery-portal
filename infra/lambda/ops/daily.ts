/**
 * opsDaily -- runs once a day (EventBridge 16:00 UTC = 01:00 KST), design §7.1 / T5.2.
 *
 *  (a) Athena over yesterday's CloudFront standard logs (parquet) -> CacheHitRatioRequests, CacheHitRatioBytes,
 *      OriginBytes, BytesDomestic (c-country = KR), BytesOverseas
 *  (b) month-to-date CloudFront BytesDownloaded / 50 TiB * 100 -> UsageAllowancePct
 *  (c) ListAccessGrants(grantee role) vs orgs table LOC#.../META -> GrantDrift (size of the symmetric difference)
 *  (d) yesterday's DAY# audit events -> JSONL object in the audit archive bucket (Glacier Instant Retrieval)
 *
 * Every step runs independently; failures are collected and re-thrown at the end so the "opsDaily failed" alarm
 * fires while the other metrics are still published.
 */
import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
  type Row,
} from '@aws-sdk/client-athena';
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  PutMetricDataCommand,
  type MetricDatum,
} from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ListAccessGrantsCommand, S3ControlClient } from '@aws-sdk/client-s3-control';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { keys } from '@genome-portal/contract';

export const OPS_ENV = {
  ACCOUNT_ID: 'ACCOUNT_ID',
  REGION: 'PORTAL_REGION',
  ATHENA_WORKGROUP: 'ATHENA_WORKGROUP',
  ATHENA_DATABASE: 'ATHENA_DATABASE',
  ATHENA_TABLE: 'ATHENA_TABLE',
  DISTRIBUTION_ID: 'DISTRIBUTION_ID',
  METRICS_NAMESPACE: 'METRICS_NAMESPACE',
  GRANTEE_ROLE_ARN: 'GRANTEE_ROLE_ARN',
  ORGS_TABLE: 'ORGS_TABLE',
  AUDIT_TABLE: 'AUDIT_TABLE',
  AUDIT_ARCHIVE_BUCKET: 'AUDIT_ARCHIVE_BUCKET',
  ALLOWANCE_BYTES: 'ALLOWANCE_BYTES',
} as const;

export interface OpsConfig {
  accountId: string;
  region: string;
  athenaWorkGroup: string;
  athenaDatabase: string;
  athenaTable: string;
  distributionId: string;
  metricsNamespace: string;
  granteeRoleArn: string;
  orgsTable: string;
  auditTable: string;
  auditArchiveBucket: string;
  allowanceBytes: number;
}

export interface OpsClients {
  athena: AthenaClient;
  cloudwatch: CloudWatchClient;
  /** AWS/CloudFront metrics live in us-east-1 regardless of the stack region. */
  cloudwatchUsEast1: CloudWatchClient;
  ddb: DynamoDBDocumentClient;
  s3: S3Client;
  s3control: S3ControlClient;
}

export interface OpsResult {
  day: string;
  metrics: Record<string, number>;
  archivedEvents: number;
  errors: string[];
}

const HIT_RESULT_TYPES = new Set(['Hit', 'RefreshHit', 'OriginShieldHit']);

export function readConfig(env: NodeJS.ProcessEnv = process.env): OpsConfig {
  const need = (k: keyof typeof OPS_ENV): string => {
    const v = env[OPS_ENV[k]];
    if (!v) throw new Error(`missing env ${OPS_ENV[k]}`);
    return v;
  };
  return {
    accountId: need('ACCOUNT_ID'),
    region: need('REGION'),
    athenaWorkGroup: need('ATHENA_WORKGROUP'),
    athenaDatabase: need('ATHENA_DATABASE'),
    athenaTable: need('ATHENA_TABLE'),
    distributionId: need('DISTRIBUTION_ID'),
    metricsNamespace: need('METRICS_NAMESPACE'),
    granteeRoleArn: need('GRANTEE_ROLE_ARN'),
    orgsTable: need('ORGS_TABLE'),
    auditTable: need('AUDIT_TABLE'),
    auditArchiveBucket: need('AUDIT_ARCHIVE_BUCKET'),
    allowanceBytes: Number(need('ALLOWANCE_BYTES')),
  };
}

export function defaultClients(region: string): OpsClients {
  return {
    athena: new AthenaClient({ region }),
    cloudwatch: new CloudWatchClient({ region }),
    cloudwatchUsEast1: new CloudWatchClient({ region: 'us-east-1' }),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    s3: new S3Client({ region }),
    s3control: new S3ControlClient({ region }),
  };
}

/** UTC calendar day (YYYY-MM-DD) before `now`. */
export function yesterdayUtc(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return d.toISOString().slice(0, 10);
}

/** Partition value used by the Glue table's date projection (yyyy/MM/dd). */
export function partitionFor(isoDay: string): string {
  return isoDay.replaceAll('-', '/');
}

export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function buildLogQuery(database: string, table: string, isoDay: string): string {
  const dt = partitionFor(isoDay);
  return [
    'SELECT x_edge_result_type AS result_type,',
    "       CASE WHEN c_country = 'KR' THEN 'KR' ELSE 'XX' END AS region_class,",
    '       count(*) AS requests,',
    '       coalesce(sum(try_cast(sc_bytes AS bigint)), 0) AS bytes',
    `FROM "${database}"."${table}"`,
    `WHERE dt = '${dt}'`,
    'GROUP BY 1, 2',
  ].join('\n');
}

export interface LogAggregate {
  requests: number;
  hitRequests: number;
  bytes: number;
  hitBytes: number;
  originBytes: number;
  bytesDomestic: number;
  bytesOverseas: number;
}

export function aggregateRows(rows: Row[]): LogAggregate {
  const agg: LogAggregate = {
    requests: 0,
    hitRequests: 0,
    bytes: 0,
    hitBytes: 0,
    originBytes: 0,
    bytesDomestic: 0,
    bytesOverseas: 0,
  };
  for (const row of rows) {
    const cells = row.Data ?? [];
    const resultType = cells[0]?.VarCharValue ?? '';
    const regionClass = cells[1]?.VarCharValue ?? 'XX';
    const requests = Number(cells[2]?.VarCharValue ?? 0);
    const bytes = Number(cells[3]?.VarCharValue ?? 0);
    agg.requests += requests;
    agg.bytes += bytes;
    if (HIT_RESULT_TYPES.has(resultType)) {
      agg.hitRequests += requests;
      agg.hitBytes += bytes;
    } else {
      agg.originBytes += bytes;
    }
    if (regionClass === 'KR') agg.bytesDomestic += bytes;
    else agg.bytesOverseas += bytes;
  }
  return agg;
}

export function logMetrics(agg: LogAggregate): Record<string, number> {
  const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
  return {
    CacheHitRatioRequests: pct(agg.hitRequests, agg.requests),
    CacheHitRatioBytes: pct(agg.hitBytes, agg.bytes),
    OriginBytes: agg.originBytes,
    BytesDomestic: agg.bytesDomestic,
    BytesOverseas: agg.bytesOverseas,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function runAthenaQuery(
  clients: Pick<OpsClients, 'athena'>,
  cfg: OpsConfig,
  sql: string,
  pollMs = 2000,
  maxPolls = 120,
): Promise<Row[]> {
  const start = await clients.athena.send(
    new StartQueryExecutionCommand({
      QueryString: sql,
      WorkGroup: cfg.athenaWorkGroup,
      QueryExecutionContext: { Database: cfg.athenaDatabase },
    }),
  );
  const id = start.QueryExecutionId;
  if (!id) throw new Error('Athena returned no QueryExecutionId');
  for (let i = 0; i < maxPolls; i += 1) {
    const exec = await clients.athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const state = exec.QueryExecution?.Status?.State;
    if (state === 'SUCCEEDED') break;
    if (state === 'FAILED' || state === 'CANCELLED') {
      throw new Error(`Athena query ${id} ${state}: ${exec.QueryExecution?.Status?.StateChangeReason ?? ''}`);
    }
    await sleep(pollMs);
    if (i === maxPolls - 1) throw new Error(`Athena query ${id} did not finish in time`);
  }
  const rows: Row[] = [];
  let token: string | undefined;
  let first = true;
  do {
    const page = await clients.athena.send(
      new GetQueryResultsCommand({ QueryExecutionId: id, NextToken: token }),
    );
    const data = page.ResultSet?.Rows ?? [];
    rows.push(...(first ? data.slice(1) : data)); // first row of the first page is the header
    first = false;
    token = page.NextToken;
  } while (token);
  return rows;
}

export async function usageAllowancePct(
  clients: Pick<OpsClients, 'cloudwatchUsEast1'>,
  cfg: OpsConfig,
  now: Date,
): Promise<number> {
  const out = await clients.cloudwatchUsEast1.send(
    new GetMetricStatisticsCommand({
      Namespace: 'AWS/CloudFront',
      MetricName: 'BytesDownloaded',
      Dimensions: [
        { Name: 'Region', Value: 'Global' },
        { Name: 'DistributionId', Value: cfg.distributionId },
      ],
      StartTime: monthStartUtc(now),
      EndTime: now,
      Period: 86400,
      Statistics: ['Sum'],
    }),
  );
  const total = (out.Datapoints ?? []).reduce((acc, d) => acc + (d.Sum ?? 0), 0);
  return (total / cfg.allowanceBytes) * 100;
}

export async function listGrantScopes(
  clients: Pick<OpsClients, 's3control'>,
  cfg: OpsConfig,
): Promise<Set<string>> {
  const scopes = new Set<string>();
  let token: string | undefined;
  do {
    const page = await clients.s3control.send(
      new ListAccessGrantsCommand({
        AccountId: cfg.accountId,
        GranteeType: 'IAM',
        GranteeIdentifier: cfg.granteeRoleArn,
        NextToken: token,
        MaxResults: 1000,
      }),
    );
    for (const g of page.AccessGrantsList ?? []) if (g.GrantScope) scopes.add(g.GrantScope);
    token = page.NextToken;
  } while (token);
  return scopes;
}

export async function listLedgerScopes(
  clients: Pick<OpsClients, 'ddb'>,
  cfg: OpsConfig,
): Promise<Set<string>> {
  const scopes = new Set<string>();
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await clients.ddb.send(
      new ScanCommand({
        TableName: cfg.orgsTable,
        FilterExpression: 'begins_with(pk, :loc) AND sk = :meta',
        ExpressionAttributeValues: { ':loc': 'LOC#', ':meta': keys.orgMeta },
        ProjectionExpression: 'grantScope',
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const scope = (item as { grantScope?: string }).grantScope;
      if (scope) scopes.add(scope);
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return scopes;
}

export function symmetricDifferenceSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (!b.has(x)) n += 1;
  for (const x of b) if (!a.has(x)) n += 1;
  return n;
}

export async function archiveAuditDay(
  clients: Pick<OpsClients, 'ddb' | 's3'>,
  cfg: OpsConfig,
  isoDay: string,
): Promise<number> {
  const lines: string[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await clients.ddb.send(
      new QueryCommand({
        TableName: cfg.auditTable,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': keys.day(isoDay) },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of page.Items ?? []) lines.push(JSON.stringify(item));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  const [y, m, d] = isoDay.split('-');
  await clients.s3.send(
    new PutObjectCommand({
      Bucket: cfg.auditArchiveBucket,
      Key: `audit/${y}/${m}/${d}.jsonl`,
      Body: lines.length > 0 ? `${lines.join('\n')}\n` : '',
      ContentType: 'application/x-ndjson',
      StorageClass: 'GLACIER_IR',
    }),
  );
  return lines.length;
}

export async function publishMetrics(
  clients: Pick<OpsClients, 'cloudwatch'>,
  cfg: OpsConfig,
  metrics: Record<string, number>,
  at: Date,
): Promise<void> {
  const data: MetricDatum[] = Object.entries(metrics).map(([name, value]) => ({
    MetricName: name,
    Value: Number.isFinite(value) ? value : 0,
    Unit:
      name.startsWith('CacheHitRatio') || name === 'UsageAllowancePct'
        ? 'Percent'
        : name.endsWith('Bytes')
          ? 'Bytes'
          : 'Count',
    Timestamp: at,
  }));
  for (let i = 0; i < data.length; i += 20) {
    await clients.cloudwatch.send(
      new PutMetricDataCommand({ Namespace: cfg.metricsNamespace, MetricData: data.slice(i, i + 20) }),
    );
  }
}

export async function runDaily(
  clients: OpsClients,
  cfg: OpsConfig,
  now: Date = new Date(),
): Promise<OpsResult> {
  const day = yesterdayUtc(now);
  const metrics: Record<string, number> = {};
  const errors: string[] = [];
  let archivedEvents = 0;

  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      const msg = `${name}: ${(err as Error).message}`;
      console.error(msg);
      errors.push(msg);
    }
  };

  await step('cloudfront-logs', async () => {
    const rows = await runAthenaQuery(clients, cfg, buildLogQuery(cfg.athenaDatabase, cfg.athenaTable, day));
    Object.assign(metrics, logMetrics(aggregateRows(rows)));
  });
  await step('usage-allowance', async () => {
    metrics.UsageAllowancePct = await usageAllowancePct(clients, cfg, now);
  });
  await step('grant-drift', async () => {
    const [grants, ledger] = await Promise.all([
      listGrantScopes(clients, cfg),
      listLedgerScopes(clients, cfg),
    ]);
    metrics.GrantDrift = symmetricDifferenceSize(grants, ledger);
  });
  await step('audit-archive', async () => {
    archivedEvents = await archiveAuditDay(clients, cfg, day);
  });
  await step('publish-metrics', async () => {
    if (Object.keys(metrics).length > 0) await publishMetrics(clients, cfg, metrics, now);
  });

  const result: OpsResult = { day, metrics, archivedEvents, errors };
  console.log(JSON.stringify(result));
  if (errors.length > 0)
    throw new Error(`opsDaily finished with ${errors.length} failed step(s): ${errors.join(' | ')}`);
  return result;
}

let cachedClients: OpsClients | undefined;

export async function handler(): Promise<OpsResult> {
  const cfg = readConfig();
  cachedClients ??= defaultClients(cfg.region);
  return runDaily(cachedClients, cfg);
}
