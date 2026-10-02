import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { RESOURCE_PREFIX, STACK_IDS } from '../../../lib/constants';
import { buildTestApp } from './helpers';

describe('portal app wiring (bin/genome-portal.ts via lib/app.ts)', () => {
  it('builds the eight stacks with the documented dependency direction auth, waf -> cdn -> cdn-logs / data -> api -> web -> ops', () => {
    const { stacks } = buildTestApp();
    expect(
      Object.values(stacks)
        .map((s) => s.stackName)
        .sort(),
    ).toEqual(Object.values(STACK_IDS).sort());
    const deps = (s: { dependencies: Array<{ stackName: string }> }) =>
      s.dependencies.map((d) => d.stackName).sort();
    expect(deps(stacks.auth)).toEqual([]);
    expect(deps(stacks.waf)).toEqual([]);
    expect(deps(stacks.cdn)).toEqual([STACK_IDS.waf]);
    expect(deps(stacks.cdnLogs)).toEqual([STACK_IDS.cdn]);
    expect(stacks.cdnLogs.region).toBe('us-east-1');
    expect(deps(stacks.data)).toEqual([STACK_IDS.cdn]);
    expect(deps(stacks.api)).toEqual([STACK_IDS.auth, STACK_IDS.cdn, STACK_IDS.data].sort());
    expect(deps(stacks.web)).toEqual([STACK_IDS.api, STACK_IDS.auth, STACK_IDS.cdn].sort());
    expect(deps(stacks.ops)).toEqual([STACK_IDS.api, STACK_IDS.cdn, STACK_IDS.data].sort());
  });

  it('every explicit physical name starts with genome-portal and every taggable resource carries Project=genome-portal', () => {
    const { templates } = buildTestApp();
    const nameProps = [
      'BucketName',
      'TableName',
      'FunctionName',
      'RoleName',
      'UserPoolName',
      'TopicName',
      'LogGroupName',
      'SecretName',
      'DashboardName',
      'AlarmName',
    ];
    for (const t of Object.values(templates)) {
      for (const res of Object.values(
        t.toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, unknown> }>,
      )) {
        for (const p of nameProps) {
          const v = res.Properties?.[p];
          if (typeof v === 'string')
            expect(
              v.startsWith(RESOURCE_PREFIX) ||
                v.startsWith(`/${RESOURCE_PREFIX}/`) ||
                v.startsWith('/aws/lambda/genome-portal-'),
            ).toBe(true);
        }
        const isPortalFn =
          res.Type === 'AWS::Lambda::Function' &&
          String(res.Properties?.FunctionName ?? '').startsWith(RESOURCE_PREFIX);
        if (res.Type === 'AWS::S3::Bucket' || res.Type === 'AWS::DynamoDB::Table' || isPortalFn) {
          expect(JSON.stringify(res.Properties?.Tags ?? null)).toContain('"Value":"genome-portal"');
        }
      }
    }
  });

  it('cdk-nag AwsSolutions: zero unsuppressed errors in every stack (default config)', () => {
    const { stacks } = buildTestApp({}, { nag: true });
    for (const stack of Object.values(stacks)) {
      const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
      expect(errors, `${stack.stackName}: ${JSON.stringify(errors.map((e) => e.entry.data))}`).toHaveLength(
        0,
      );
    }
  });

  it('cdk-nag AwsSolutions: zero unsuppressed errors with a custom domain and optional MFA', () => {
    const { stacks } = buildTestApp(
      {
        portalDomain: 'portal.example.org',
        hostedZoneId: 'Z0123456789ABCDEFGHIJ',
        mfaMode: 'OPTIONAL',
        uploaderPrincipalArns: ['arn:aws:iam::111111111111:role/uploader'],
      },
      { nag: true },
    );
    for (const stack of Object.values(stacks)) {
      const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
      expect(errors, `${stack.stackName}: ${JSON.stringify(errors.map((e) => e.entry.data))}`).toHaveLength(
        0,
      );
    }
  });
});
