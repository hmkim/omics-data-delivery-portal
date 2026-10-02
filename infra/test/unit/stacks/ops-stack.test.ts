import { Match } from 'aws-cdk-lib/assertions';
import { METRICS_NAMESPACE } from '@genome-portal/contract';
import { describe, expect, it } from 'vitest';
import { CF_LOG_FIELDS, names } from '../../../lib/constants';
import { ALARM_NAMES, glueColumnName } from '../../../lib/ops-stack';
import { allowedIamActions, buildTestApp } from './helpers';

describe('ops stack (M5)', () => {
  const { templates } = buildTestApp();
  const t = templates.ops;

  it('exactly 10 alarms, all notBreaching, all wired to the SNS topic', () => {
    const alarms = Object.values(t.findResources('AWS::CloudWatch::Alarm'));
    expect(alarms).toHaveLength(10);
    expect(alarms.map((a) => a.Properties.AlarmName).sort()).toEqual(Object.values(ALARM_NAMES).sort());
    for (const a of alarms) {
      expect(a.Properties.TreatMissingData).toBe('notBreaching');
      expect(a.Properties.AlarmActions).toHaveLength(1);
    }
    const usage = alarms.filter((a) => (a.Properties.AlarmName as string).includes('usage-allowance'));
    expect(usage.map((a) => a.Properties.Threshold).sort((x, y) => x - y)).toEqual([50, 80, 100, 200]);
    for (const a of usage) expect(a.Properties.MetricName).toBe('UsageAllowancePct');
    const denied = alarms.find((a) => a.Properties.AlarmName === ALARM_NAMES.accessDenied)!;
    expect(denied.Properties).toMatchObject({
      MetricName: 'AccessDenied',
      Namespace: METRICS_NAMESPACE,
      Period: 300,
      Statistic: 'Sum',
      Threshold: 50,
    });
    const drift = alarms.find((a) => a.Properties.AlarmName === ALARM_NAMES.grantDrift)!;
    expect(drift.Properties).toMatchObject({
      MetricName: 'GrantDrift',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
    });
    const rate = alarms.find((a) => a.Properties.AlarmName === ALARM_NAMES.downloadsErrorRate)!;
    expect(rate.Properties.Threshold).toBe(5);
    expect(JSON.stringify(rate.Properties.Metrics)).toContain('errors / invocations * 100');
  });

  it('SNS topic with the alertEmail subscription', () => {
    t.hasResourceProperties('AWS::SNS::Topic', { TopicName: names.alertTopic });
    t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.com' });
  });

  it('alerts topic policy lets CloudWatch alarms publish (enforceSSL drops the default same-account statement)', () => {
    const policies = Object.values(t.findResources('AWS::SNS::TopicPolicy')) as Array<{
      Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } };
    }>;
    expect(policies).toHaveLength(1);
    const statements = policies[0]!.Properties.PolicyDocument.Statement;
    const grant = statements.find((s) => s['Sid'] === 'AllowCloudWatchAlarms');
    expect(grant).toBeDefined();
    expect(grant).toMatchObject({
      Effect: 'Allow',
      Action: 'sns:Publish',
      Principal: { Service: 'cloudwatch.amazonaws.com' },
    });
    const cond = grant!['Condition'] as {
      StringEquals: Record<string, unknown>;
      ArnLike: Record<string, unknown>;
    };
    expect(cond.StringEquals['aws:SourceAccount']).toBeDefined();
    expect(JSON.stringify(cond.ArnLike['aws:SourceArn'])).toContain(':alarm:genome-portal-*');
    // the SSL-only Deny from enforceSSL is still there
    expect(statements.some((s) => s['Effect'] === 'Deny' && s['Sid'] === 'AllowPublishThroughSSLOnly')).toBe(
      true,
    );
  });

  it('daily job at 16:00 UTC (01:00 KST) with least-privilege access (no S3 object writes outside the archive prefix)', () => {
    t.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'cron(0 16 * * ? *)' });
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: names.fn('ops-daily'),
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Timeout: 600,
      Environment: {
        Variables: Match.objectLike({
          DISTRIBUTION_ID: Match.anyValue(),
          AUDIT_ARCHIVE_BUCKET: Match.anyValue(),
        }),
      },
    });
    const actions = allowedIamActions(t);
    expect(actions).toContain('s3:ListAccessGrants');
    expect(actions).toContain('athena:StartQueryExecution');
    expect(actions).toContain('cloudwatch:PutMetricData');
    expect(actions).not.toContain('s3:GetDataAccess');
    expect(actions).not.toContain('s3:CreateAccessGrant');
    expect(actions).not.toContain('dynamodb:PutItem');
  });

  it('Glue table: parquet, positional column mapping in CF_LOG_FIELDS order, daily date projection; Athena workgroup', () => {
    const table = Object.values(t.findResources('AWS::Glue::Table'))[0]!.Properties.TableInput;
    expect(table.Name).toBe(names.glueTable);
    expect(table.PartitionKeys).toEqual([{ Name: 'dt', Type: 'string' }]);
    expect(table.Parameters['projection.dt.format']).toBe('yyyy/MM/dd');
    expect(table.StorageDescriptor.SerdeInfo.Parameters['parquet.column.index.access']).toBe('true');
    expect(table.StorageDescriptor.Columns.map((c: { Name: string }) => c.Name)).toEqual(
      CF_LOG_FIELDS.map(glueColumnName),
    );
    // CloudFront parquet logs store every field as a string; numeric work happens in the queries (T5.1 finding).
    expect(table.StorageDescriptor.Columns.every((c: { Type: string }) => c.Type === 'string')).toBe(true);
    t.hasResourceProperties('AWS::Athena::WorkGroup', {
      Name: names.athenaWorkGroup,
      WorkGroupConfiguration: Match.objectLike({
        EnforceWorkGroupConfiguration: true,
        ResultConfiguration: Match.objectLike({ EncryptionConfiguration: { EncryptionOption: 'SSE_S3' } }),
      }),
    });
    t.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: names.athenaBucket('111111111111'),
      LifecycleConfiguration: { Rules: [Match.objectLike({ ExpirationInDays: 30, Status: 'Enabled' })] },
    });
    t.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({ BucketName: names.auditArchiveBucket('111111111111') }),
    });
  });

  it('dashboard exists with the required widgets', () => {
    const body = Object.values(t.findResources('AWS::CloudWatch::Dashboard'))[0]!.Properties.DashboardBody;
    const s = JSON.stringify(body);
    for (const m of [
      'BytesDownloaded',
      'Requests',
      '4xxErrorRate',
      'BytesIssued',
      'AccessDenied',
      'GrantMissing',
      'UsageAllowancePct',
      'CacheHitRatioRequests',
      'CacheHitRatioBytes',
      'BytesDomestic',
      'BytesOverseas',
    ]) {
      expect(s).toContain(m);
    }
  });

  it('glueColumnName normalises CloudFront field names', () => {
    expect(glueColumnName('cs(Host)')).toBe('cs_host');
    expect(glueColumnName('x-edge-result-type')).toBe('x_edge_result_type');
    expect(glueColumnName('cs(User-Agent)')).toBe('cs_user_agent');
  });
});
