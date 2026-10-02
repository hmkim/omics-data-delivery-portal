import { randomUUID } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  AUDIT_TTL_DAYS,
  LAMBDA_ENV,
  METRICS_NAMESPACE,
  keys,
  type AuditEvent,
  type DownloadPath,
} from '@genome-portal/contract';
import { ddbClient } from './clients';
import { requireEnv } from './env';
import { describeError } from './errors';

/** Input for recordAudit: `at` defaults to now. */
export type AuditInput = Omit<AuditEvent, 'at'> & { at?: string };

/** The DynamoDB item shape (design §3): DAY#<date> / TS#<iso>#<uuid> + event fields + TTL. */
export interface AuditItem extends AuditEvent {
  pk: string;
  sk: string;
  /** epoch seconds; DynamoDB TTL attribute */
  expiresAt: number;
}

export function buildAuditItem(
  input: AuditInput,
  now: Date = new Date(),
  uuid: string = randomUUID(),
): AuditItem {
  const at = input.at ?? now.toISOString();
  const day = at.slice(0, 10);
  const expiresAt = Math.floor(new Date(at).getTime() / 1000) + AUDIT_TTL_DAYS * 24 * 60 * 60;
  return { ...input, at, pk: keys.day(day), sk: keys.ts(at, uuid), expiresAt };
}

/**
 * Persist an audit event (R7.1). Never logs file content (N9) - only the fields the caller passes.
 * A failure to write audit must not turn a successful download into an error, so this logs and swallows.
 */
export async function recordAudit(input: AuditInput): Promise<AuditItem> {
  const item = buildAuditItem(input);
  try {
    await ddbClient().send(new PutCommand({ TableName: requireEnv('AUDIT_TABLE'), Item: item }));
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'audit write failed',
        type: item.type,
        error: describeError(err),
      }),
    );
  }
  return item;
}

// ---------------------------------------------------------------------------
// CloudWatch Embedded Metric Format (design §7.1)
// ---------------------------------------------------------------------------

export type MetricUnit = 'Count' | 'Bytes';

export interface EmfEnvelope {
  _aws: {
    Timestamp: number;
    CloudWatchMetrics: Array<{
      Namespace: string;
      Dimensions: string[][];
      Metrics: Array<{ Name: string; Unit: MetricUnit }>;
    }>;
  };
  [key: string]: unknown;
}

export function buildEmf(
  name: string,
  value: number,
  unit: MetricUnit,
  dimensions: Record<string, string> = {},
  now: number = Date.now(),
): EmfEnvelope {
  const namespace = process.env[LAMBDA_ENV.METRICS_NAMESPACE] ?? METRICS_NAMESPACE;
  return {
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [
        {
          Namespace: namespace,
          Dimensions: [Object.keys(dimensions)],
          Metrics: [{ Name: name, Unit: unit }],
        },
      ],
    },
    ...dimensions,
    [name]: value,
  };
}

/** Write one EMF record to stdout; the Lambda log subscription turns it into a metric. */
export function emitMetric(
  name: string,
  value: number,
  unit: MetricUnit = 'Count',
  dimensions: Record<string, string> = {},
): void {
  console.log(JSON.stringify(buildEmf(name, value, unit, dimensions)));
}

export const metrics = {
  downloadIssued: (path: DownloadPath) => emitMetric('DownloadIssued', 1, 'Count', { path }),
  bytesIssued: (path: DownloadPath, bytes: number) => emitMetric('BytesIssued', bytes, 'Bytes', { path }),
  accessDenied: () => emitMetric('AccessDenied', 1),
  grantMissing: () => emitMetric('GrantMissing', 1),
  urlRenewed: () => emitMetric('UrlRenewed', 1),
} as const;
