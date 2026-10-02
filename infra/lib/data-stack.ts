import { CfnOutput, Duration, RemovalPolicy, type Stack } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { GSI_NAMES, SSM_DEFAULTS, SSM_PARAMS, TABLE_NAMES, names } from './constants';
import { PortalStack, type PortalStackProps } from './portal-stack';

export interface DataStackProps extends PortalStackProps {
  /** cdn stack output. Used in the bucket / KMS policies unless skipCdnPolicy is set. */
  distributionArn: string;
  /**
   * `-c skipCdnPolicy=true`: omit the CloudFront statements. Needed only for the very first deployment if
   * CloudFront rejects an origin bucket that does not exist yet (README, T1.7).
   */
  skipCdnPolicy: boolean;
}

/** Access Grants location role permissions, design §2.3 JSON (read-only, D2-A). */
export const LOCATION_ROLE_OBJECT_ACTIONS = [
  's3:GetObject',
  's3:GetObjectVersion',
  's3:GetObjectAcl',
  's3:GetObjectVersionAcl',
  's3:ListMultipartUploadParts',
] as const;

/** Object-level actions the "everyone else" Deny covers (bucket management stays with the account, design §2.5). */
const DENIED_DATA_ACTIONS = [
  's3:GetObject',
  's3:GetObjectVersion',
  's3:GetObjectAcl',
  's3:GetObjectVersionAcl',
  's3:GetObjectAttributes',
  's3:GetObjectTagging',
  's3:PutObject',
  's3:PutObjectAcl',
  's3:PutObjectTagging',
  's3:DeleteObject',
  's3:DeleteObjectVersion',
  's3:AbortMultipartUpload',
  's3:ListMultipartUploadParts',
  's3:ListBucket',
  's3:ListBucketVersions',
  's3:ListBucketMultipartUploads',
  's3:RestoreObject',
] as const;

/**
 * T1.2~T1.4, T1.7 -- data bucket, KMS key, S3 Access Grants instance + location + location role, DynamoDB tables,
 * SSM settings, and the bucket / KMS policies that need the cdn distribution ARN (design §2.3, §2.5, §3).
 */
export class DataStack extends PortalStack {
  public readonly key: kms.Key;
  public readonly dataBucket: s3.IBucket;
  public readonly dataBucketName: string;
  public readonly accessLogsBucket?: s3.Bucket;
  public readonly locationRole: iam.Role;
  public readonly accessGrantsInstanceArn: string;
  public readonly accessGrantsLocationId: string;
  public readonly orgsTable: dynamodb.Table;
  public readonly objectDownloadsTable: dynamodb.Table;
  public readonly auditEventsTable: dynamodb.Table;
  public readonly ssmParameters: Record<keyof typeof SSM_PARAMS, ssm.StringParameter>;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props, 'data bucket, KMS, S3 Access Grants instance/location, DynamoDB, SSM settings');

    // --- KMS (T1.2)
    this.key = new kms.Key(this, 'DataKey', {
      alias: names.kmsAlias,
      description: 'genome-portal: data bucket and DynamoDB encryption key',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // --- bucket (T1.2): new (RETAIN) or imported by name
    if (this.cfg.dataBucketName) {
      this.dataBucketName = this.cfg.dataBucketName;
      this.dataBucket = s3.Bucket.fromBucketAttributes(this, 'DataBucket', {
        bucketName: this.cfg.dataBucketName,
        region: this.region,
      });
    } else {
      this.dataBucketName = names.dataBucket(this.account, this.region);
      this.accessLogsBucket = new s3.Bucket(this, 'S3AccessLogsBucket', {
        bucketName: names.s3AccessLogsBucket(this.account, this.region),
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
        lifecycleRules: [{ id: 'expire-access-logs', expiration: Duration.days(400) }],
        removalPolicy: RemovalPolicy.RETAIN,
      });
      this.dataBucket = new s3.Bucket(this, 'DataBucket', {
        bucketName: this.dataBucketName,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.KMS,
        encryptionKey: this.key,
        bucketKeyEnabled: true,
        enforceSSL: true,
        versioned: true,
        objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
        serverAccessLogsBucket: this.accessLogsBucket,
        serverAccessLogsPrefix: 'data-bucket/',
        removalPolicy: RemovalPolicy.RETAIN,
        cors: [
          {
            // `*`, not the portal origin: S3 echoes a specific matching origin (plus Allow-Credentials) and CloudFront
            // caches that answer with `Origin` outside the CachingOptimized key, so it would be served to every other
            // viewer origin (acceptance §3-6). The Pro flat-rate plan only allows managed response headers policies,
            // which do not override origin headers, so uniformity has to come from S3. CORS is not the access control
            // here — presigned / signed URLs are — so `*` gives nothing away.
            allowedOrigins: ['*'],
            allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
            allowedHeaders: ['*'],
            exposedHeaders: [
              'Content-Length',
              'Content-Range',
              'ETag',
              'x-amz-checksum-crc32',
              'Accept-Ranges',
            ],
            maxAge: 3600,
          },
        ],
      });
    }

    // --- Access Grants (T1.3)
    if (this.cfg.accessGrantsInstanceArn) {
      this.accessGrantsInstanceArn = this.cfg.accessGrantsInstanceArn;
    } else {
      const instance = new s3.CfnAccessGrantsInstance(this, 'AccessGrantsInstance', {});
      this.accessGrantsInstanceArn = instance.attrAccessGrantsInstanceArn;
    }

    this.locationRole = new iam.Role(this, 'LocationRole', {
      roleName: names.locationRole,
      description:
        'genome-portal: S3 Access Grants location role (read-only, sessions only via Access Grants)',
      maxSessionDuration: Duration.hours(12),
      assumedBy: new iam.ServicePrincipal('access-grants.s3.amazonaws.com').withConditions({
        StringEquals: { 'aws:SourceAccount': this.account },
        ArnEquals: { 'aws:SourceArn': this.accessGrantsInstanceArn },
      }),
    });
    // The service principal needs both actions; ServicePrincipal.withConditions only renders sts:AssumeRole.
    this.locationRole.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        sid: 'SetSourceIdentity',
        actions: ['sts:SetSourceIdentity'],
        principals: [new iam.ServicePrincipal('access-grants.s3.amazonaws.com')],
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnEquals: { 'aws:SourceArn': this.accessGrantsInstanceArn },
        },
      }),
    );
    const viaAccessGrants = { ArnEquals: { 's3:AccessGrantsInstanceArn': this.accessGrantsInstanceArn } };
    this.locationRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ObjectRead',
        actions: [...LOCATION_ROLE_OBJECT_ACTIONS],
        resources: [this.dataBucket.arnForObjects('*')],
        conditions: viaAccessGrants,
      }),
    );
    this.locationRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BucketList',
        actions: ['s3:ListBucket'],
        resources: [this.dataBucket.bucketArn],
        conditions: viaAccessGrants,
      }),
    );
    this.locationRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Kms',
        actions: ['kms:Decrypt'],
        resources: [this.key.keyArn],
        conditions: { StringEquals: { 'kms:ViaService': `s3.${this.region}.amazonaws.com` } },
      }),
    );

    const location = new s3.CfnAccessGrantsLocation(this, 'DataLocation', {
      iamRoleArn: this.locationRole.roleArn,
      locationScope: `s3://${this.dataBucketName}/`,
    });
    // The role's policies must exist before Access Grants validates the location, and the instance must exist first.
    location.node.addDependency(this.locationRole);
    this.accessGrantsLocationId = location.attrAccessGrantsLocationId;

    // --- DynamoDB (T1.4, design §3)
    const tableDefaults = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.key,
      removalPolicy: RemovalPolicy.RETAIN,
      deletionProtection: true,
    } as const;

    this.orgsTable = new dynamodb.Table(this, 'OrgsTable', {
      ...tableDefaults,
      tableName: TABLE_NAMES.orgs,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    });
    this.orgsTable.addGlobalSecondaryIndex({
      indexName: GSI_NAMES.inverted,
      partitionKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.objectDownloadsTable = new dynamodb.Table(this, 'ObjectDownloadsTable', {
      ...tableDefaults,
      tableName: TABLE_NAMES.objectDownloads,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    });

    this.auditEventsTable = new dynamodb.Table(this, 'AuditEventsTable', {
      ...tableDefaults,
      tableName: TABLE_NAMES.auditEvents,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
    });
    this.auditEventsTable.addGlobalSecondaryIndex({
      indexName: GSI_NAMES.byUser,
      partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- SSM settings (T1.4, design §3): values come from the contract, never typed here
    const params = {} as Record<keyof typeof SSM_PARAMS, ssm.StringParameter>;
    for (const k of Object.keys(SSM_PARAMS) as Array<keyof typeof SSM_PARAMS>) {
      params[k] = new ssm.StringParameter(this, `Param${k[0]!.toUpperCase()}${k.slice(1)}`, {
        parameterName: SSM_PARAMS[k],
        stringValue: SSM_DEFAULTS[k],
        description: `genome-portal runtime setting ${k}`,
        tier: ssm.ParameterTier.STANDARD,
      });
    }
    this.ssmParameters = params;

    // --- bucket + KMS policies (T1.7)
    this.applyBucketPolicy(props);
    this.applyKeyPolicy(props);

    new CfnOutput(this, 'AccessGrantsInstanceArn', { value: this.accessGrantsInstanceArn });
    new CfnOutput(this, 'LocationId', { value: this.accessGrantsLocationId });
    new CfnOutput(this, 'LocationRoleArn', { value: this.locationRole.roleArn });
    new CfnOutput(this, 'DataBucketName', { value: this.dataBucketName });
    new CfnOutput(this, 'KmsKeyArn', { value: this.key.keyArn });
    new CfnOutput(this, 'OrgsTableName', { value: this.orgsTable.tableName });
    new CfnOutput(this, 'ObjectDownloadsTableName', { value: this.objectDownloadsTable.tableName });
    new CfnOutput(this, 'AuditEventsTableName', { value: this.auditEventsTable.tableName });
  }

  /** Principals that may touch objects directly (outside Access Grants): location role, uploaders, operators, root. */
  private allowedPrincipalArns(): string[] {
    return [
      this.locationRole.roleArn,
      `arn:aws:iam::${this.account}:root`,
      ...this.cfg.uploaderPrincipalArns,
      ...this.cfg.adminPrincipalArns,
    ];
  }

  private applyBucketPolicy(props: DataStackProps): void {
    const statements: iam.PolicyStatement[] = [];

    if (!props.skipCdnPolicy) {
      statements.push(
        new iam.PolicyStatement({
          sid: 'AllowCloudFrontOac',
          principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
          actions: ['s3:GetObject'],
          resources: [this.dataBucket.arnForObjects('*')],
          conditions: { StringEquals: { 'AWS:SourceArn': props.distributionArn } },
        }),
      );
    }
    statements.push(
      new iam.PolicyStatement({
        sid: 'AllowAccessGrantsLocationRole',
        principals: [new iam.ArnPrincipal(this.locationRole.roleArn)],
        actions: [...LOCATION_ROLE_OBJECT_ACTIONS, 's3:ListBucket'],
        resources: [this.dataBucket.bucketArn, this.dataBucket.arnForObjects('*')],
      }),
      new iam.PolicyStatement({
        sid: 'DenyDataAccessOutsidePortal',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: [...DENIED_DATA_ACTIONS],
        resources: [this.dataBucket.bucketArn, this.dataBucket.arnForObjects('*')],
        conditions: {
          // IAM principals not in the allow-list are denied; AWS service principals (CloudFront OAC) are exempt
          // because they carry no aws:PrincipalArn and are covered by their own scoped Allow statement.
          ArnNotLike: { 'aws:PrincipalArn': this.allowedPrincipalArns() },
          BoolIfExists: { 'aws:PrincipalIsAWSService': 'false' },
        },
      }),
    );

    const denyInsecureTransport = new iam.PolicyStatement({
      sid: 'DenyInsecureTransport',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:*'],
      resources: [this.dataBucket.bucketArn, this.dataBucket.arnForObjects('*')],
      conditions: { Bool: { 'aws:SecureTransport': 'false' } },
    });

    if (this.dataBucket instanceof s3.Bucket) {
      // enforceSSL: true already added the non-TLS Deny statement on a new bucket.
      for (const st of statements) this.dataBucket.addToResourcePolicy(st);
    } else {
      // Imported bucket: an explicit policy resource (replaces any policy already on the bucket).
      const policy = new s3.BucketPolicy(this, 'DataBucketPolicy', { bucket: this.dataBucket });
      policy.document.addStatements(...statements, denyInsecureTransport);
    }
  }

  private applyKeyPolicy(props: DataStackProps): void {
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowLocationRoleDecryptViaS3',
        principals: [new iam.ArnPrincipal(this.locationRole.roleArn)],
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'kms:ViaService': `s3.${this.region}.amazonaws.com` } },
      }),
    );
    if (!props.skipCdnPolicy) {
      this.key.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowCloudFrontDecrypt',
          principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
          actions: ['kms:Decrypt'],
          resources: ['*'],
          conditions: { StringEquals: { 'AWS:SourceArn': props.distributionArn } },
        }),
      );
    }
    if (this.cfg.uploaderPrincipalArns.length > 0) {
      this.key.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowUploaderEncrypt',
          principals: this.cfg.uploaderPrincipalArns.map((arn) => new iam.ArnPrincipal(arn)),
          actions: [
            'kms:GenerateDataKey',
            'kms:GenerateDataKeyWithoutPlaintext',
            'kms:Encrypt',
            'kms:DescribeKey',
          ],
          resources: ['*'],
          conditions: { StringEquals: { 'kms:ViaService': `s3.${this.region}.amazonaws.com` } },
        }),
      );
    }
  }
}

/** Convenience for tests: the ARN of a table by its contract name in a given stack. */
export function tableArn(stack: Stack, tableName: string): string {
  return stack.formatArn({ service: 'dynamodb', resource: 'table', resourceName: tableName });
}
