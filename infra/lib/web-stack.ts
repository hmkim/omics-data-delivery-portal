import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import type { PortalConfig } from '@genome-portal/contract';
import {
  API_BASE,
  ORIGIN_VERIFY_HEADER,
  SINGLE_OBJECT_LIMIT_BYTES,
  SPLIT_THRESHOLD_BYTES,
  names,
} from './constants';
import { PortalStack, type PortalStackProps } from './portal-stack';

export interface WebStackProps extends PortalStackProps {
  userPoolId: string;
  userPoolClientId: string;
  /** HTTP API id; the origin is <apiId>.execute-api.<region>.amazonaws.com ($default stage). */
  apiId: string;
  originVerifySecret: secretsmanager.ISecret;
  dataBucketName: string;
  /** Data distribution host name (design §1 config.json cfDomain). */
  cfDomainName: string;
  /** us-east-1 certificate for <portalDomain>; required when cfg.portalDomain is set. */
  certificate?: acm.ICertificate;
  /** Built SPA directory. Default: <repo>/web/dist. */
  webDistDir?: string;
}

export const WEB_DIST_DIR = resolve(__dirname, '..', '..', 'web', 'dist');
export const PLACEHOLDER_INDEX_HTML = '<!doctype html><title>genome-portal</title>';

/**
 * Stages `brand.logoFile` as `<dir>/<logoUrl path>` so `Source.asset(dir)` uploads it to exactly that key.
 * (`Source.data` is text-only and would corrupt png/webp.) The directory name is derived from the file's content
 * hash, so re-synthesising the same logo produces the same asset hash and no spurious redeploy.
 */
export function stageLogo(logoFile: string, logoUrl: string): string {
  const key = logoUrl.replace(/^\/+/, '');
  if (!key || key.endsWith('/'))
    throw new Error(`brand.logoUrl must name a file in the static bucket (got ${logoUrl})`);
  const content = readFileSync(logoFile);
  const digest = createHash('sha256').update(key).update(content).digest('hex').slice(0, 16);
  const dir = join(tmpdir(), `genome-portal-brand-${digest}`);
  const target = join(dir, key);
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

/**
 * T1.10 -- static asset bucket + pay-as-you-go distribution (design §1 web stack, N6).
 * Default behaviour -> S3 (OAC); `/api/*` -> HTTP API origin with viewer IP / country headers and the secret
 * `x-origin-verify` header; SPA routing (403/404 -> /index.html 200); runtime config.json for the SPA.
 */
export class WebStack extends PortalStack {
  public readonly webBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly portalUrl: string;
  public readonly portalConfig: PortalConfig;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props, 'SPA bucket, pay-as-you-go distribution with /api/* behaviour, config.json');

    this.webBucket = new s3.Bucket(this, 'WebBucket', {
      bucketName: names.webBucket(this.account, this.region),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const domainNames = this.cfg.portalDomain ? [this.cfg.portalDomain] : undefined;
    if (domainNames && !props.certificate) {
      throw new Error('web stack: certificate is required when portalDomain is configured');
    }

    const apiOrigin = new HttpOrigin(`${props.apiId}.execute-api.${this.region}.amazonaws.com`, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
      readTimeout: Duration.seconds(30),
      customHeaders: {
        // Secrets Manager dynamic reference: CloudFormation resolves it at deploy time, the value never enters
        // the template. Lambdas compare the header against the same secret (design §6).
        [ORIGIN_VERIFY_HEADER]: props.originVerifySecret.secretValue.unsafeUnwrap(),
      },
    });

    // API Gateway rejects requests whose Host header is the CloudFront domain (403 Forbidden), so the managed
    // "all viewer" policies (which forward Host) cannot be used. CloudFront forwards `Authorization` only as part
    // of the cache key, so it lives in a zero-TTL cache policy; the remaining headers (plus the CloudFront viewer
    // headers the Lambdas record for audit, design §6) go through the origin request policy.
    const apiCachePolicy = new cloudfront.CachePolicy(this, 'ApiCachePolicy', {
      cachePolicyName: 'genome-portal-api-cache',
      comment: 'genome-portal /api/*: no caching; Authorization forwarded via the cache key',
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization'),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: false,
      enableAcceptEncodingBrotli: false,
    });
    const apiOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'ApiOriginRequestPolicy', {
      originRequestPolicyName: 'genome-portal-api-origin-request',
      comment: 'genome-portal /api/*: request headers except Host + CloudFront viewer address/country',
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
        'Content-Type',
        'Accept',
        'Accept-Language',
        'Origin',
        'Referer',
        'User-Agent',
        'CloudFront-Viewer-Address',
        'CloudFront-Viewer-Country',
      ),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
    });

    // SPA routing without custom error pages: error pages apply to every behaviour, so a 403/404 JSON error
    // from /api/* would be rewritten into index.html with status 200 and the client could never see it.
    // Instead, rewrite extension-less viewer paths on the static behaviour to /index.html.
    const spaRewrite = new cloudfront.Function(this, 'SpaRewriteFn', {
      functionName: 'genome-portal-web-spa-rewrite',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'genome-portal: serve index.html for extension-less SPA paths',
      code: cloudfront.FunctionCode.fromInline(
        [
          'function handler(event) {',
          '  var request = event.request;',
          '  var uri = request.uri;',
          "  if (uri.indexOf('.') === -1) { request.uri = '/index.html'; }",
          '  return request;',
          '}',
        ].join('\n'),
      ),
    });

    this.distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      comment: 'genome-portal web (SPA + /api/* proxy)',
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.webBucket, {
          originAccessLevels: [cloudfront.AccessLevel.READ],
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        compress: true,
        functionAssociations: [
          { function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        [`${API_BASE}/*`]: {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: apiCachePolicy,
          originRequestPolicy: apiOriginRequestPolicy,
          compress: false,
        },
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      domainNames,
      certificate: domainNames ? props.certificate : undefined,
      minimumProtocolVersion: domainNames ? cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021 : undefined,
      sslSupportMethod: domainNames ? cloudfront.SSLMethod.SNI : undefined,
    });

    if (this.cfg.portalDomain && this.cfg.hostedZoneId) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: this.cfg.hostedZoneId,
        zoneName: this.cfg.portalDomain,
      });
      const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution));
      new route53.ARecord(this, 'PortalAliasA', { zone, target });
      new route53.AaaaRecord(this, 'PortalAliasAAAA', { zone, target });
    }

    this.portalUrl = `https://${domainNames?.[0] ?? this.distribution.distributionDomainName}`;

    // --- runtime config for the SPA (contract PortalConfig; thresholds from the contract, same as SSM)
    const { logoFile, ...brand } = this.cfg.brand; // logoFile is a deploy-time path, never published
    this.portalConfig = {
      region: this.region,
      accountId: this.account,
      userPoolId: props.userPoolId,
      clientId: props.userPoolClientId,
      apiBase: API_BASE,
      dataBucket: props.dataBucketName,
      cfDomain: props.cfDomainName,
      splitThresholdBytes: SPLIT_THRESHOLD_BYTES,
      singleObjectLimitBytes: SINGLE_OBJECT_LIMIT_BYTES,
      mfaMode: this.cfg.mfaMode,
      brand,
    };

    const distDir = props.webDistDir ?? WEB_DIST_DIR;
    const spaSource = existsSync(distDir)
      ? s3deploy.Source.asset(distDir)
      : s3deploy.Source.data('index.html', PLACEHOLDER_INDEX_HTML); // keeps synth/deploy working before T3.11
    const sources = [spaSource, s3deploy.Source.jsonData('config.json', this.portalConfig)];
    if (logoFile) sources.push(s3deploy.Source.asset(stageLogo(logoFile, brand.logoUrl)));

    new s3deploy.BucketDeployment(this, 'WebDeployment', {
      destinationBucket: this.webBucket,
      // later sources win on equal keys: a configured logo replaces the SPA's default at the same URL
      sources,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      prune: true,
      memoryLimit: 512,
    });

    new CfnOutput(this, 'PortalUrl', { value: this.portalUrl });
    new CfnOutput(this, 'WebDistributionId', { value: this.distribution.distributionId });
    new CfnOutput(this, 'WebBucketName', { value: this.webBucket.bucketName });
  }
}
