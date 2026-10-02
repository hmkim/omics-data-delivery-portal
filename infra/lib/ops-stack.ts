import { resolve } from 'node:path';
import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import { OPS_ENV } from '../lambda/ops/daily';
import {
  CF_LOG_FIELDS,
  CF_MONTHLY_ALLOWANCE_BYTES,
  METRICS_NAMESPACE,
  RESOURCE_PREFIX,
  names,
} from './constants';
import { portalNodejsFunction } from './lambda-defaults';
import { PortalStack, type PortalStackProps } from './portal-stack';

export interface OpsStackProps extends PortalStackProps {
  /** Data distribution id (cdn stack). */
  distributionId: string;
  /** Bucket receiving CloudFront standard logs v2 (cdn stack). */
  cfLogsBucket: s3.IBucket;
  /** Prefix inside cfLogsBucket for this distribution: AWSLogs/<account>/CloudFront/<DistributionId>/ */
  cfLogPrefix: string;
  orgsTable: dynamodb.ITable;
  auditEventsTable: dynamodb.ITable;
  accessGrantsInstanceArn: string;
  granteeRoleArn: string;
  /** downloads handler (error-rate alarm). */
  downloadsFunction: lambda.IFunction;
  /** HTTP API id (5xx alarm + dashboard). */
  apiId: string;
}

/** Glue column name for a CloudFront log field: cs(Host) -> cs_host, x-edge-result-type -> x_edge_result_type. */
export function glueColumnName(field: string): string {
  return field.replace(/\(/g, '_').replace(/\)/g, '').replace(/-/g, '_').toLowerCase();
}

/**
 * CloudFront standard logging v2 writes every Parquet field as a UTF-8 string (verified on the first delivered
 * file of the dev deployment: Athena rejected a `bigint` column with "Field sc_bytes's type BINARY ... is
 * incompatible with type bigint"). Every Glue column is therefore `string`; queries cast what they aggregate
 * (see `buildLogQuery` in lambda/ops/daily.ts). Kept as a map so a future CloudFront change can restore types.
 */
const FIELD_TYPES: Record<string, string> = {};

/** Alarm names (10, T5.4). Kept here so the test can assert the exact set. */
export const ALARM_NAMES = {
  usage50: 'genome-portal-usage-allowance-50pct',
  usage80: 'genome-portal-usage-allowance-80pct',
  usage100: 'genome-portal-usage-allowance-100pct',
  usage200: 'genome-portal-usage-allowance-200pct',
  accessDenied: 'genome-portal-access-denied-5min',
  downloadsErrorRate: 'genome-portal-downloads-error-rate',
  grantMissing: 'genome-portal-grant-missing',
  grantDrift: 'genome-portal-grant-drift',
  opsDailyFailed: 'genome-portal-ops-daily-failed',
  api5xx: 'genome-portal-api-5xx',
} as const;

/**
 * M5 -- T5.1 log analytics base (Glue + Athena), T5.2 daily job, T5.3 dashboard, T5.4 alarms -> SNS (design §7.1).
 */
export class OpsStack extends PortalStack {
  public readonly alertTopic: sns.Topic;
  public readonly athenaBucket: s3.Bucket;
  public readonly auditArchiveBucket: s3.Bucket;
  public readonly opsDailyFunction: lambda.Function;
  public readonly alarms: Record<keyof typeof ALARM_NAMES, cloudwatch.Alarm>;
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: OpsStackProps) {
    super(scope, id, props, 'dashboard, alarms, daily metrics/grant-drift/audit-archive Lambda (R7)');

    // --- T5.1 Athena results + audit archive buckets
    this.athenaBucket = new s3.Bucket(this, 'AthenaBucket', {
      bucketName: names.athenaBucket(this.account),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ id: 'expire-results', expiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    this.auditArchiveBucket = new s3.Bucket(this, 'AuditArchiveBucket', {
      bucketName: names.auditArchiveBucket(this.account),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const database = new glue.CfnDatabase(this, 'LogsDatabase', {
      catalogId: this.account,
      databaseInput: {
        name: names.glueDatabase,
        description: 'genome-portal: CloudFront standard logs (v2, parquet)',
      },
    });
    const logLocation = `s3://${props.cfLogsBucket.bucketName}/${props.cfLogPrefix}`;
    const table = new glue.CfnTable(this, 'CfLogsTable', {
      catalogId: this.account,
      databaseName: names.glueDatabase,
      tableInput: {
        name: names.glueTable,
        description: 'genome-portal data distribution access logs (parquet, daily date projection)',
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          EXTERNAL: 'TRUE',
          classification: 'parquet',
          'projection.enabled': 'true',
          'projection.dt.type': 'date',
          'projection.dt.range': '2026/01/01,NOW',
          'projection.dt.format': 'yyyy/MM/dd',
          'projection.dt.interval': '1',
          'projection.dt.interval.unit': 'DAYS',
          'storage.location.template': `${logLocation}\${dt}/`,
        },
        partitionKeys: [{ name: 'dt', type: 'string' }],
        storageDescriptor: {
          location: logLocation,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          compressed: false,
          columns: CF_LOG_FIELDS.map((f) => ({
            name: glueColumnName(f),
            type: FIELD_TYPES[f] ?? 'string',
            comment: f,
          })),
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
            // Columns are mapped by position (= CF_LOG_FIELDS order = the delivery's recordFields order), so the
            // hyphenated / parenthesised CloudFront field names never have to match Glue column names.
            parameters: { 'serialization.format': '1', 'parquet.column.index.access': 'true' },
          },
        },
      },
    });
    table.node.addDependency(database);

    const workGroup = new athena.CfnWorkGroup(this, 'WorkGroup', {
      name: names.athenaWorkGroup,
      description: 'genome-portal ops queries (daily metrics job, operators)',
      recursiveDeleteOption: true,
      state: 'ENABLED',
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        resultConfiguration: {
          outputLocation: `s3://${this.athenaBucket.bucketName}/results/`,
          encryptionConfiguration: { encryptionOption: 'SSE_S3' },
        },
        engineVersion: { selectedEngineVersion: 'AUTO' },
      },
    });

    // --- SNS alerts (T5.4)
    this.alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: names.alertTopic,
      displayName: 'genome-portal alerts',
      enforceSSL: true,
    });
    // `enforceSSL` installs a topic policy, which REPLACES SNS's default "same-account principals may publish"
    // statement — without the grant below every alarm action fails with "CloudWatch Alarms is not authorized to
    // perform: SNS:Publish" (found in T8.1 scenario 8 on dev, 2026-09-28).
    this.alertTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchAlarms',
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.alertTopic.topicArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: {
            'aws:SourceArn': `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:${RESOURCE_PREFIX}-*`,
          },
        },
      }),
    );
    this.alertTopic.addSubscription(new subscriptions.EmailSubscription(this.cfg.alertEmail));
    const alarmAction = new cwActions.SnsAction(this.alertTopic);

    // --- T5.2 daily job
    this.opsDailyFunction = portalNodejsFunction(this, 'OpsDailyFn', {
      functionName: names.fn('ops-daily'),
      entry: resolve(__dirname, '..', 'lambda', 'ops', 'daily.ts'),
      description: 'genome-portal: daily cache-hit/usage/grant-drift metrics and audit archive',
      timeout: Duration.minutes(10),
      memorySize: 512,
      environment: {
        [OPS_ENV.ACCOUNT_ID]: this.account,
        [OPS_ENV.REGION]: this.region,
        [OPS_ENV.ATHENA_WORKGROUP]: names.athenaWorkGroup,
        [OPS_ENV.ATHENA_DATABASE]: names.glueDatabase,
        [OPS_ENV.ATHENA_TABLE]: names.glueTable,
        [OPS_ENV.DISTRIBUTION_ID]: props.distributionId,
        [OPS_ENV.METRICS_NAMESPACE]: METRICS_NAMESPACE,
        [OPS_ENV.GRANTEE_ROLE_ARN]: props.granteeRoleArn,
        [OPS_ENV.ORGS_TABLE]: props.orgsTable.tableName,
        [OPS_ENV.AUDIT_TABLE]: props.auditEventsTable.tableName,
        [OPS_ENV.AUDIT_ARCHIVE_BUCKET]: this.auditArchiveBucket.bucketName,
        [OPS_ENV.ALLOWANCE_BYTES]: String(CF_MONTHLY_ALLOWANCE_BYTES),
      },
    });
    const fn = this.opsDailyFunction;
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'Athena',
        actions: ['athena:StartQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults'],
        resources: [
          this.formatArn({ service: 'athena', resource: 'workgroup', resourceName: names.athenaWorkGroup }),
        ],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'GlueCatalog',
        actions: ['glue:GetDatabase', 'glue:GetTable', 'glue:GetPartitions', 'glue:GetPartition'],
        resources: [
          this.formatArn({ service: 'glue', resource: 'catalog' }),
          this.formatArn({ service: 'glue', resource: 'database', resourceName: names.glueDatabase }),
          this.formatArn({
            service: 'glue',
            resource: 'table',
            resourceName: `${names.glueDatabase}/${names.glueTable}`,
          }),
        ],
      }),
    );
    props.cfLogsBucket.grantRead(fn, `${props.cfLogPrefix}*`);
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'CfLogsBucketList',
        actions: ['s3:ListBucket', 's3:GetBucketLocation'],
        resources: [props.cfLogsBucket.bucketArn],
      }),
    );
    this.athenaBucket.grantReadWrite(fn, 'results/*');
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AthenaResultsBucket',
        actions: ['s3:ListBucket', 's3:GetBucketLocation', 's3:ListBucketMultipartUploads'],
        resources: [this.athenaBucket.bucketArn],
      }),
    );
    this.auditArchiveBucket.grantPut(fn, 'audit/*');
    props.orgsTable.grantReadData(fn);
    props.auditEventsTable.grantReadData(fn);
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ListAccessGrants',
        actions: ['s3:ListAccessGrants'],
        resources: [props.accessGrantsInstanceArn],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchRead',
        actions: ['cloudwatch:GetMetricStatistics', 'cloudwatch:GetMetricData'],
        resources: ['*'], // CloudWatch read APIs do not support resource-level permissions
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchPut',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': METRICS_NAMESPACE } },
      }),
    );
    fn.node.addDependency(workGroup);
    fn.node.addDependency(table);

    new events.Rule(this, 'DailySchedule', {
      ruleName: 'genome-portal-ops-daily',
      description: 'genome-portal opsDaily: 16:00 UTC (01:00 KST) every day',
      schedule: events.Schedule.cron({ minute: '0', hour: '16' }),
      targets: [new eventsTargets.LambdaFunction(fn, { retryAttempts: 2 })],
    });

    // --- metrics (design §7.1)
    const portalMetric = (metricName: string, statistic: string, period = Duration.minutes(5)) =>
      new cloudwatch.Metric({ namespace: METRICS_NAMESPACE, metricName, statistic, period });
    const cfMetric = (metricName: string, statistic: string) =>
      new cloudwatch.Metric({
        namespace: 'AWS/CloudFront',
        metricName,
        statistic,
        period: Duration.hours(1),
        region: 'us-east-1',
        dimensionsMap: { Region: 'Global', DistributionId: props.distributionId },
      });
    const apiMetric = (metricName: string, statistic: string) =>
      new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName,
        statistic,
        period: Duration.minutes(5),
        dimensionsMap: { ApiId: props.apiId },
      });

    const usage = portalMetric('UsageAllowancePct', 'Maximum', Duration.days(1));
    const accessDenied = portalMetric('AccessDenied', 'Sum');
    const grantMissing = portalMetric('GrantMissing', 'Sum');
    const grantDrift = portalMetric('GrantDrift', 'Maximum', Duration.days(1));
    const downloadsErrorRate = new cloudwatch.MathExpression({
      expression: 'IF(invocations > 0, errors / invocations * 100, 0)',
      label: 'downloads error rate (%)',
      period: Duration.minutes(5),
      usingMetrics: {
        errors: props.downloadsFunction.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
        invocations: props.downloadsFunction.metricInvocations({
          period: Duration.minutes(5),
          statistic: 'Sum',
        }),
      },
    });

    // --- T5.4 alarms (10)
    const usageAlarm = (key: 'usage50' | 'usage80' | 'usage100' | 'usage200', threshold: number) =>
      new cloudwatch.Alarm(this, `Alarm-${key}`, {
        alarmName: ALARM_NAMES[key],
        alarmDescription: `CloudFront month-to-date transfer reached ${threshold}% of the Pro plan allowance (R7.3)`,
        metric: usage,
        threshold,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

    this.alarms = {
      usage50: usageAlarm('usage50', 50),
      usage80: usageAlarm('usage80', 80),
      usage100: usageAlarm('usage100', 100),
      usage200: usageAlarm('usage200', 200),
      accessDenied: new cloudwatch.Alarm(this, 'Alarm-accessDenied', {
        alarmName: ALARM_NAMES.accessDenied,
        alarmDescription: '50 or more ACCESS_DENIED (403) events within 5 minutes (R7.5)',
        metric: accessDenied,
        threshold: 50,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      downloadsErrorRate: new cloudwatch.Alarm(this, 'Alarm-downloadsErrorRate', {
        alarmName: ALARM_NAMES.downloadsErrorRate,
        alarmDescription: 'downloads Lambda error rate above 5% over 5 minutes (R7.5)',
        metric: downloadsErrorRate,
        threshold: 5,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      grantMissing: new cloudwatch.Alarm(this, 'Alarm-grantMissing', {
        alarmName: ALARM_NAMES.grantMissing,
        alarmDescription:
          'GetDataAccess denied for an assigned location: DynamoDB / Access Grants drift (design §7.1)',
        metric: grantMissing,
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      grantDrift: new cloudwatch.Alarm(this, 'Alarm-grantDrift', {
        alarmName: ALARM_NAMES.grantDrift,
        alarmDescription: 'Daily grant reconciliation found grants without ledger entries or vice versa',
        metric: grantDrift,
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      opsDailyFailed: new cloudwatch.Alarm(this, 'Alarm-opsDailyFailed', {
        alarmName: ALARM_NAMES.opsDailyFailed,
        alarmDescription: 'opsDaily Lambda reported an error (metrics / archive may be incomplete)',
        metric: fn.metricErrors({ period: Duration.hours(1), statistic: 'Sum' }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      api5xx: new cloudwatch.Alarm(this, 'Alarm-api5xx', {
        alarmName: ALARM_NAMES.api5xx,
        alarmDescription: 'HTTP API returned 5 or more 5xx responses within 5 minutes',
        metric: apiMetric('5xx', 'Sum'),
        threshold: 5,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    };
    for (const alarm of Object.values(this.alarms)) {
      alarm.addAlarmAction(alarmAction);
      alarm.addOkAction(alarmAction);
    }

    // --- T5.3 dashboard
    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: names.dashboard,
      defaultInterval: Duration.days(7),
    });
    const graph = (
      title: string,
      left: cloudwatch.IMetric[],
      opts: Partial<cloudwatch.GraphWidgetProps> = {},
    ) => new cloudwatch.GraphWidget({ title, left, width: 8, height: 6, ...opts });
    this.dashboard.addWidgets(
      graph('CloudFront BytesDownloaded (data)', [cfMetric('BytesDownloaded', 'Sum')]),
      graph('CloudFront Requests (data)', [cfMetric('Requests', 'Sum')]),
      graph('CloudFront 4xx / 5xx error rate (data)', [
        cfMetric('4xxErrorRate', 'Average'),
        cfMetric('5xxErrorRate', 'Average'),
      ]),
    );
    this.dashboard.addWidgets(
      graph('Bytes issued by path (DOWNLOAD_ISSUED sizeBytes)', [
        new cloudwatch.Metric({
          namespace: METRICS_NAMESPACE,
          metricName: 'BytesIssued',
          statistic: 'Sum',
          period: Duration.days(1),
          dimensionsMap: { path: 'S3' },
          label: 'S3 direct',
        }),
        new cloudwatch.Metric({
          namespace: METRICS_NAMESPACE,
          metricName: 'BytesIssued',
          statistic: 'Sum',
          period: Duration.days(1),
          dimensionsMap: { path: 'CF' },
          label: 'CloudFront',
        }),
      ]),
      graph('Downloads issued by path', [
        new cloudwatch.Metric({
          namespace: METRICS_NAMESPACE,
          metricName: 'DownloadIssued',
          statistic: 'Sum',
          period: Duration.days(1),
          dimensionsMap: { path: 'S3' },
          label: 'S3 direct',
        }),
        new cloudwatch.Metric({
          namespace: METRICS_NAMESPACE,
          metricName: 'DownloadIssued',
          statistic: 'Sum',
          period: Duration.days(1),
          dimensionsMap: { path: 'CF' },
          label: 'CloudFront',
        }),
      ]),
      graph('Domestic / overseas bytes (daily, CloudFront logs)', [
        portalMetric('BytesDomestic', 'Sum', Duration.days(1)),
        portalMetric('BytesOverseas', 'Sum', Duration.days(1)),
      ]),
    );
    this.dashboard.addWidgets(
      graph(
        'Cache hit ratio (%)',
        [
          portalMetric('CacheHitRatioRequests', 'Average', Duration.days(1)),
          portalMetric('CacheHitRatioBytes', 'Average', Duration.days(1)),
        ],
        { leftYAxis: { min: 0, max: 100 } },
      ),
      graph('Origin (S3) bytes via CloudFront (daily)', [
        portalMetric('OriginBytes', 'Sum', Duration.days(1)),
      ]),
      graph('Usage allowance (% of 50 TiB, month to date)', [usage], { leftYAxis: { min: 0 } }),
    );
    this.dashboard.addWidgets(
      graph('AccessDenied / GrantMissing', [accessDenied, grantMissing]),
      graph('Lambda errors', [
        props.downloadsFunction.metricErrors({
          period: Duration.minutes(5),
          statistic: 'Sum',
          label: 'downloads',
        }),
        fn.metricErrors({ period: Duration.hours(1), statistic: 'Sum', label: 'opsDaily' }),
        downloadsErrorRate,
      ]),
      graph('API 4xx / 5xx', [apiMetric('4xx', 'Sum'), apiMetric('5xx', 'Sum')]),
    );
    this.dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({
        title: 'Alarms',
        alarms: Object.values(this.alarms),
        width: 24,
        height: 4,
      }),
    );

    new CfnOutput(this, 'AlertTopicArn', { value: this.alertTopic.topicArn });
    new CfnOutput(this, 'DashboardName', { value: this.dashboard.dashboardName });
    new CfnOutput(this, 'AthenaWorkGroup', { value: names.athenaWorkGroup });
    new CfnOutput(this, 'AuditArchiveBucketName', { value: this.auditArchiveBucket.bucketName });
    new CfnOutput(this, 'OpsDailyFunctionName', { value: fn.functionName });
  }
}
