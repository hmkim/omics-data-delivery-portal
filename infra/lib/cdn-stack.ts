import { resolve } from 'node:path';
import {
  Annotations,
  ArnFormat,
  CfnOutput,
  CustomResource,
  Duration,
  RemovalPolicy,
  Stack,
} from 'aws-cdk-lib';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as pricingplanmanager from 'aws-cdk-lib/aws-pricingplanmanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Provider } from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import { SECRET_NAMES, names } from './constants';
import { portalNodejsFunction } from './lambda-defaults';
import { PortalStack, type PortalStackProps } from './portal-stack';

export interface CdnStackProps extends PortalStackProps {
  /** WAF Web ACL ARN from the waf stack (us-east-1, cross-region reference). */
  webAclArn: string;
  /** us-east-1 certificate for data.<portalDomain>; required when cfg.portalDomain is set. */
  certificate?: acm.ICertificate;
}

/**
 * T1.6 -- data distribution (design §4.1). The origin bucket is imported BY NAME: this stack must not reference
 * any data-stack construct, because the data stack's bucket and KMS policies need this distribution's ARN
 * (T1.7). One-directional dependency data -> cdn is what avoids the circular reference.
 *
 * T1.6b -- when `cfg.flatRatePlan` is set, the stack also subscribes the distribution (+ its WAF Web ACL) to the
 * CloudFront flat-rate plan through `AWS::PricingPlanManager::Subscription`. Everything on the distribution must stay
 * within the plan tier's feature set (N4): managed cache / response headers policies only for PRO, OAC, no real-time
 * logs.
 */
export class CdnStack extends PortalStack {
  public readonly distribution: cloudfront.Distribution;
  public readonly keyGroup: cloudfront.KeyGroup;
  public readonly publicKey: cloudfront.PublicKey;
  public readonly logsBucket: s3.Bucket;
  /** Flat-rate plan subscription (undefined when `cfg.flatRatePlan` is not set = pay-as-you-go). */
  public readonly flatRatePlan?: pricingplanmanager.CfnSubscription;
  /** ARN of the Secrets Manager secret holding the private key (PKCS#8 PEM). */
  public readonly signingKeySecretArn: string;
  /** Host name clients use for signed URLs: data.<portalDomain> or the default *.cloudfront.net name. */
  public readonly dataDomainName: string;
  public readonly dataBucketName: string;

  constructor(scope: Construct, id: string, props: CdnStackProps) {
    super(scope, id, props, 'data distribution (OAC, key group, CachingOptimized, standard logs)');

    this.dataBucketName = this.cfg.dataBucketName ?? names.dataBucket(this.account, this.region);

    // --- URL signing key pair: custom resource -> Secrets Manager (private) + CfnPublicKey (public) -> KeyGroup
    const signingKeyFn = portalNodejsFunction(this, 'SigningKeyFn', {
      functionName: names.fn('cf-signing-key-cr'),
      entry: resolve(__dirname, '..', 'lambda', 'custom-resources', 'signing-key.ts'),
      description: 'genome-portal: custom resource that generates the CloudFront signing key pair',
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {},
    });
    signingKeyFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'SigningKeySecret',
        actions: [
          'secretsmanager:CreateSecret',
          'secretsmanager:GetSecretValue',
          'secretsmanager:DescribeSecret',
          'secretsmanager:DeleteSecret',
          'secretsmanager:TagResource',
        ],
        resources: [
          Stack.of(this).formatArn({
            service: 'secretsmanager',
            resource: 'secret',
            resourceName: `${SECRET_NAMES.cfSigningKey}-*`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );
    const provider = new Provider(this, 'SigningKeyProvider', {
      onEventHandler: signingKeyFn,
      logGroup: new logs.LogGroup(this, 'SigningKeyProviderLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    const signingKey = new CustomResource(this, 'SigningKey', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::GenomePortalSigningKey',
      properties: { SecretName: SECRET_NAMES.cfSigningKey },
    });
    this.signingKeySecretArn = signingKey.getAttString('SecretArn');

    this.publicKey = new cloudfront.PublicKey(this, 'SigningPublicKey', {
      publicKeyName: names.signingPublicKey,
      encodedKey: signingKey.getAttString('PublicKeyPem'),
      comment: 'genome-portal: CloudFront signed URL public key',
    });
    this.keyGroup = new cloudfront.KeyGroup(this, 'SigningKeyGroup', {
      keyGroupName: names.signingKeyGroup,
      items: [this.publicKey],
      comment: 'genome-portal: trusted key group for the data distribution',
    });

    // --- standard logging v2 destination bucket
    this.logsBucket = new s3.Bucket(this, 'CfLogsBucket', {
      bucketName: names.cfLogsBucket(this.account),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ id: 'expire-logs', expiration: Duration.days(400) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // --- origin: imported by name only (see class doc)
    const originBucket = s3.Bucket.fromBucketAttributes(this, 'DataBucketByName', {
      bucketName: this.dataBucketName,
      region: this.region,
    });
    Annotations.of(this).acknowledgeWarning(
      '@aws-cdk/aws-cloudfront-origins:updateImportedBucketPolicyOac',
      'Intentional: the data stack writes the bucket policy with this distribution ARN (T1.7).',
    );
    const origin = S3BucketOrigin.withOriginAccessControl(originBucket, {
      originAccessLevels: [cloudfront.AccessLevel.READ],
      originAccessControl: new cloudfront.S3OriginAccessControl(this, 'DataOac', {
        originAccessControlName: 'genome-portal-data-oac',
        description: 'genome-portal data bucket origin access control',
        signing: cloudfront.Signing.SIGV4_ALWAYS,
      }),
    });

    const domainNames = this.cfg.portalDomain ? [`data.${this.cfg.portalDomain}`] : undefined;
    if (domainNames && !props.certificate) {
      throw new Error('cdn stack: certificate is required when portalDomain is configured');
    }

    // CORS for the split-download workers (design §5.4). The Pro flat-rate plan allows MANAGED response headers
    // policies only (custom policies are a Business+ feature, N4), and the managed CORS-With-Preflight policy does
    // NOT override origin headers: whatever S3 answers is cached under CachingOptimized with `Origin` outside the
    // cache key and served to every viewer origin. So the data bucket's CORS rule answers `*` for every origin
    // (data-stack.ts) — the cached header is origin-independent — and this policy only fills in `*` when a cached
    // response was fetched without an Origin header (curl / aria2c). Content is protected by the signed URL, not by
    // CORS. (Dev, 2026-09-29: S3's origin-specific answer for localhost:5173 had been cached and every Range fetch
    // from the deployed portal failed with `Failed to fetch`; acceptance §3-6.)
    const corsPolicy = cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS_WITH_PREFLIGHT;

    this.distribution = new cloudfront.Distribution(this, 'DataDistribution', {
      comment: 'genome-portal data distribution (signed URLs, OAC)',
      defaultBehavior: {
        origin,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        compress: false,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: corsPolicy,
        trustedKeyGroups: [this.keyGroup],
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      webAclId: props.webAclArn,
      domainNames,
      certificate: domainNames ? props.certificate : undefined,
      minimumProtocolVersion: domainNames ? cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021 : undefined,
      sslSupportMethod: domainNames ? cloudfront.SSLMethod.SNI : undefined,
    });
    this.dataDomainName = domainNames?.[0] ?? this.distribution.distributionDomainName;

    if (this.cfg.portalDomain && this.cfg.hostedZoneId) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: this.cfg.hostedZoneId,
        zoneName: this.cfg.portalDomain,
      });
      const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution));
      new route53.ARecord(this, 'DataAliasA', { zone, recordName: 'data', target });
      new route53.AaaaRecord(this, 'DataAliasAAAA', { zone, recordName: 'data', target });
    }

    // --- standard logging v2 (parquet) via CloudWatch Logs vended-log delivery (design §4.1, §7.1)
    this.configureStandardLoggingV2();

    // --- flat-rate plan subscription (T1.6b, N4). Paid tiers are created PENDING_APPROVAL: CloudFormation never
    // approves, so nothing is billed until an operator calls ApprovePaidSubscription (runbook §1). The subscription
    // references the distribution ARN, so it is created last and deleted first; deleting a pending one is immediate,
    // deleting an ACTIVE one only schedules cancellation for the end of the billing month and the distribution
    // cannot be deleted before that (teardown §9).
    if (this.cfg.flatRatePlan) {
      this.flatRatePlan = new pricingplanmanager.CfnSubscription(this, 'FlatRatePlan', {
        planFamily: 'CloudFront',
        planTier: this.cfg.flatRatePlan.tier,
        usageLevel: this.cfg.flatRatePlan.usageLevel ?? 'DEFAULT',
        resourceArns: [this.distribution.distributionArn, props.webAclArn],
      });
      new CfnOutput(this, 'FlatRatePlanSubscriptionArn', { value: this.flatRatePlan.ref });
      // Attribute read at deploy time: PENDING_APPROVAL right after a deployment, ACTIVE only on a later update.
      new CfnOutput(this, 'FlatRatePlanStatusAtDeploy', {
        value: this.flatRatePlan.getAtt('Status').toString(),
      });
    }

    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new CfnOutput(this, 'DistributionArn', { value: this.distribution.distributionArn });
    new CfnOutput(this, 'DomainName', { value: this.dataDomainName });
    new CfnOutput(this, 'KeyPairId', { value: this.publicKey.publicKeyId });
    new CfnOutput(this, 'SigningKeySecretArn', { value: this.signingKeySecretArn });
    new CfnOutput(this, 'CfLogsBucketName', { value: this.logsBucket.bucketName });
  }

  /**
   * S3 prefix (inside the logs bucket) under which the vended-log delivery writes:
   * AWSLogs/<account>/CloudFront/<DistributionId>/<yyyy>/<MM>/<dd>/<HH>/...
   */
  public get logPrefixForDistribution(): string {
    return `AWSLogs/${this.account}/CloudFront/${this.distribution.distributionId}/`;
  }

  /**
   * Bucket policy for the vended-log delivery. The delivery source is created in us-east-1 (CdnLogsStack),
   * so the SourceArn condition names that region rather than this stack's.
   */
  private configureStandardLoggingV2(): void {
    this.logsBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AWSLogDeliveryWrite',
        principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [this.logsBucket.arnForObjects(`AWSLogs/${this.account}/*`)],
        conditions: {
          StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control', 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:logs:us-east-1:${this.account}:delivery-source:*` },
        },
      }),
    );
  }
}
