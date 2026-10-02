import { Match } from 'aws-cdk-lib/assertions';
import { GSI_NAMES, SSM_DEFAULTS, SSM_PARAMS, TABLE_NAMES } from '@genome-portal/contract';
import { describe, expect, it } from 'vitest';
import { names } from '../../../lib/constants';
import { allowedIamActions, buildTestApp } from './helpers';

describe('data stack (T1.2~T1.4, T1.7)', () => {
  const { templates } = buildTestApp();
  const t = templates.data;
  const json = JSON.stringify(t.toJSON());

  it('SSM parameters carry exactly the contract defaults', () => {
    t.resourceCountIs('AWS::SSM::Parameter', 4);
    for (const k of Object.keys(SSM_PARAMS) as Array<keyof typeof SSM_PARAMS>) {
      t.hasResourceProperties('AWS::SSM::Parameter', {
        Name: SSM_PARAMS[k],
        Value: SSM_DEFAULTS[k],
        Type: 'String',
      });
    }
  });

  it('data bucket: RETAIN, KMS, versioned, public access blocked, CORS exposes Range headers, access logs', () => {
    t.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        BucketName: names.dataBucket('111111111111', 'ap-northeast-2'),
        VersioningConfiguration: { Status: 'Enabled' },
        PublicAccessBlockConfiguration: Match.objectLike({
          BlockPublicAcls: true,
          RestrictPublicBuckets: true,
        }),
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            Match.objectLike({
              ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }),
            }),
          ],
        },
        CorsConfiguration: {
          CorsRules: [
            Match.objectLike({
              // uniform answer for every viewer origin: CloudFront caches it without `Origin` in the key (N4, Pro
              // tier = managed response headers policies only, no origin override)
              AllowedOrigins: ['*'],
              AllowedMethods: ['GET', 'HEAD'],
              AllowedHeaders: ['*'],
              ExposedHeaders: [
                'Content-Length',
                'Content-Range',
                'ETag',
                'x-amz-checksum-crc32',
                'Accept-Ranges',
              ],
            }),
          ],
        },
        LoggingConfiguration: Match.objectLike({ LogFilePrefix: 'data-bucket/' }),
      }),
    });
    t.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  });

  it('bucket policy: CloudFront OAC allow scoped to the cdn distribution ARN, non-TLS deny, everyone-else deny', () => {
    const policies = Object.values(t.findResources('AWS::S3::BucketPolicy')).filter((r) =>
      JSON.stringify(r).includes('DenyDataAccessOutsidePortal'),
    );
    expect(policies).toHaveLength(1);
    const statements = policies[0]!.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>;
    const sids = statements.map((s) => s.Sid);
    expect(sids).toContain('AllowCloudFrontOac');
    expect(sids).toContain('AllowAccessGrantsLocationRole');
    expect(sids).toContain('DenyDataAccessOutsidePortal');

    const tlsDeny = statements.find(
      (s) => s.Effect === 'Deny' && JSON.stringify(s).includes('aws:SecureTransport'),
    );
    expect(tlsDeny).toBeDefined();

    const oac = statements.find((s) => s.Sid === 'AllowCloudFrontOac')!;
    expect(oac.Principal).toEqual({ Service: 'cloudfront.amazonaws.com' });
    expect(JSON.stringify(oac.Condition)).toContain('genome-portal-cdn:ExportsOutput'); // cdn -> data direction (T1.7)

    const outside = statements.find((s) => s.Sid === 'DenyDataAccessOutsidePortal')!;
    expect(outside.Effect).toBe('Deny');
    expect(JSON.stringify(outside.Condition)).toContain('aws:PrincipalArn');
    expect(JSON.stringify(outside.Condition)).toContain('aws:PrincipalIsAWSService');
    expect(outside.Action).toEqual(
      expect.arrayContaining(['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket']),
    );
  });

  it('-c skipCdnPolicy=true drops only the CloudFront statements (first-deployment fallback)', () => {
    const fallback = buildTestApp({}, { skipCdnPolicy: true }).templates.data;
    const s = JSON.stringify(fallback.toJSON());
    expect(s).not.toContain('AllowCloudFrontOac');
    expect(s).not.toContain('AllowCloudFrontDecrypt');
    expect(s).toContain('DenyDataAccessOutsidePortal');
    expect(s).not.toContain('genome-portal-cdn:ExportsOutput');
  });

  it('KMS key policy: location role Decrypt via S3, CloudFront Decrypt scoped to the distribution', () => {
    t.hasResourceProperties('AWS::KMS::Key', {
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({ Sid: 'AllowLocationRoleDecryptViaS3', Action: 'kms:Decrypt' }),
          Match.objectLike({
            Sid: 'AllowCloudFrontDecrypt',
            Principal: { Service: 'cloudfront.amazonaws.com' },
          }),
        ]),
      },
    });
  });

  it('Access Grants: instance, location s3://<bucket>/, location role trusts access-grants.s3 with SourceArn/SourceAccount', () => {
    t.resourceCountIs('AWS::S3::AccessGrantsInstance', 1);
    t.hasResourceProperties('AWS::S3::AccessGrantsLocation', {
      LocationScope: `s3://${names.dataBucket('111111111111', 'ap-northeast-2')}/`,
    });
    t.hasResourceProperties('AWS::IAM::Role', {
      RoleName: names.locationRole,
      MaxSessionDuration: 43200,
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRole',
            Principal: { Service: 'access-grants.s3.amazonaws.com' },
            Condition: Match.objectLike({ StringEquals: { 'aws:SourceAccount': '111111111111' } }),
          }),
          Match.objectLike({ Action: 'sts:SetSourceIdentity' }),
        ]),
      },
    });
  });

  it('location role: read-only S3 actions gated by s3:AccessGrantsInstanceArn, no write actions anywhere in the stack', () => {
    const actions = allowedIamActions(t);
    for (const a of ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket', 'kms:Decrypt'])
      expect(actions).toContain(a);
    for (const a of actions) {
      expect(a).not.toMatch(/^s3:(Put|Delete|Abort|Restore|Replicate)/);
    }
    expect(json).toContain('s3:AccessGrantsInstanceArn');
  });

  it('DynamoDB: three tables (on-demand, PITR, KMS), GSIs, TTL on audit events, RETAIN', () => {
    t.resourceCountIs('AWS::DynamoDB::Table', 3);
    for (const name of Object.values(TABLE_NAMES)) {
      t.hasResource('AWS::DynamoDB::Table', {
        DeletionPolicy: 'Retain',
        Properties: Match.objectLike({
          TableName: name,
          BillingMode: 'PAY_PER_REQUEST',
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
          SSESpecification: Match.objectLike({ SSEEnabled: true, SSEType: 'KMS' }),
          DeletionProtectionEnabled: true,
        }),
      });
    }
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: TABLE_NAMES.auditEvents,
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      GlobalSecondaryIndexes: [Match.objectLike({ IndexName: GSI_NAMES.byUser })],
    });
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: TABLE_NAMES.orgs,
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: GSI_NAMES.inverted,
          KeySchema: [
            { AttributeName: 'sk', KeyType: 'HASH' },
            { AttributeName: 'pk', KeyType: 'RANGE' },
          ],
        }),
      ],
    });
  });

  it('imports an existing bucket and Access Grants instance when configured', () => {
    const imported = buildTestApp({
      dataBucketName: 'genome-portal-existing',
      accessGrantsInstanceArn: 'arn:aws:s3:ap-northeast-2:111111111111:access-grants/default',
    }).templates.data;
    imported.resourceCountIs('AWS::S3::AccessGrantsInstance', 0);
    expect(
      Object.values(imported.findResources('AWS::S3::Bucket')).map((b) => b.Properties?.BucketName),
    ).not.toContain('genome-portal-existing');
    imported.hasResourceProperties('AWS::S3::BucketPolicy', { Bucket: 'genome-portal-existing' });
    imported.hasResourceProperties('AWS::S3::AccessGrantsLocation', {
      LocationScope: 's3://genome-portal-existing/',
    });
  });
});
