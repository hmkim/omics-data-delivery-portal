import { GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GSI_NAMES, METRICS_NAMESPACE, type AuditEvent, type AuditEventType } from '@genome-portal/contract';
import { aws } from './aws';
import { stackOutputs } from './outputs';
import { pollUntil } from './util';

/** Newest-first audit events of one user (byUser GSI: PK userSub, SK sk = TS#<iso>#<uuid>). */
export async function auditEventsForUser(userSub: string, limit = 200): Promise<AuditEvent[]> {
  const { AuditEventsTableName } = await stackOutputs();
  const items: AuditEvent[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const out = await aws.ddb().send(
      new QueryCommand({
        TableName: AuditEventsTableName,
        IndexName: GSI_NAMES.byUser,
        KeyConditionExpression: 'userSub = :u AND begins_with(sk, :ts)',
        ExpressionAttributeValues: { ':u': userSub, ':ts': 'TS#' },
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: startKey,
      }),
    );
    for (const raw of out.Items ?? []) items.push(raw as AuditEvent);
    startKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey && items.length < limit);
  return items;
}

export interface AuditMatch {
  type: AuditEventType;
  key?: string;
  downloadId?: string;
  reason?: string;
  /** only events at/after this ISO time */
  since?: string;
}

/** Poll the byUser GSI until an event matching `match` appears (default 30 s). */
export async function waitForAuditEvent(
  userSub: string,
  match: AuditMatch,
  timeoutMs = 30_000,
): Promise<AuditEvent> {
  return pollUntil(
    async () => {
      const events = await auditEventsForUser(userSub);
      return events.find(
        (e) =>
          e.type === match.type &&
          (match.key === undefined || e.key === match.key) &&
          (match.downloadId === undefined || e.downloadId === match.downloadId) &&
          (match.reason === undefined || e.reason === match.reason) &&
          (match.since === undefined || e.at >= match.since),
      );
    },
    { timeoutMs, intervalMs: 2_000, what: `audit ${match.type} for user ${userSub}` },
  );
}

/** Sum of a GenomePortal metric (no dimensions) from `since` (default: the last 10 min) until now. */
export async function metricSum(metricName: string, since?: Date): Promise<number> {
  const end = new Date();
  const start = since ?? new Date(end.getTime() - 10 * 60_000);
  const out = await aws.cloudwatch().send(
    new GetMetricStatisticsCommand({
      Namespace: METRICS_NAMESPACE,
      MetricName: metricName,
      StartTime: start,
      EndTime: end,
      Period: 60,
      Statistics: ['Sum'],
    }),
  );
  return (out.Datapoints ?? []).reduce((acc, d) => acc + (d.Sum ?? 0), 0);
}
