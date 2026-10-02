import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Match } from 'aws-cdk-lib/assertions';
import {
  API_BASE,
  ORIGIN_VERIFY_HEADER,
  SINGLE_OBJECT_LIMIT_BYTES,
  SPLIT_THRESHOLD_BYTES,
} from '@genome-portal/contract';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOGO_URL } from '../../../lib/config';
import { CF_LOG_FIELDS, names } from '../../../lib/constants';
import { stageLogo } from '../../../lib/web-stack';
import { buildTestApp } from './helpers';

const CACHING_DISABLED_ID = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const ALL_VIEWER_AND_CLOUDFRONT_2022_ID = '33f36d7e-f396-46d9-90e0-52428a34d9dc';
const CACHING_OPTIMIZED_ID = '658327ea-f89d-4fab-a63d-7e88639e58f6';
const CORS_WITH_PREFLIGHT_ID = '5cc3b908-e619-4b99-88e5-2cf7f45965bd';

describe('cdn stack (T1.5, T1.6)', () => {
  const { stacks, templates } = buildTestApp();
  const t = templates.cdn;
  const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0]!.Properties
    .DistributionConfig;

  it('does not depend on the data stack (T1.7 direction: data -> cdn), only on waf', () => {
    const deps = stacks.cdn.dependencies.map((s) => s.stackName);
    expect(deps).not.toContain(stacks.data.stackName);
    expect(deps).toContain(stacks.waf.stackName);
    expect(stacks.data.dependencies.map((s) => s.stackName)).toContain(stacks.cdn.stackName);
    expect(JSON.stringify(t.toJSON())).not.toContain('genome-portal-data:ExportsOutput');
  });

  it('origin is the data bucket imported by name with OAC (SigV4 always), no OAI', () => {
    expect(dist.Origins).toHaveLength(1);
    expect(dist.Origins[0].DomainName).toBe(
      `${names.dataBucket('111111111111', 'ap-northeast-2')}.s3.ap-northeast-2.amazonaws.com`,
    );
    expect(dist.Origins[0].OriginAccessControlId).toBeDefined();
    expect(dist.Origins[0].S3OriginConfig.OriginAccessIdentity).toBe('');
    t.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({ SigningBehavior: 'always', SigningProtocol: 'sigv4' }),
    });
  });

  it('default behaviour: GET/HEAD/OPTIONS, HTTPS only, no compression, CachingOptimized + managed CORS policy, key group', () => {
    const b = dist.DefaultCacheBehavior;
    expect(b.AllowedMethods).toEqual(['GET', 'HEAD', 'OPTIONS']);
    expect(b.ViewerProtocolPolicy).toBe('https-only');
    expect(b.Compress).toBe(false);
    expect(b.CachePolicyId).toBe(CACHING_OPTIMIZED_ID);
    // Pro flat-rate plan: managed policies only (N4). Uniform CORS comes from the data bucket's `*` rule.
    expect(b.ResponseHeadersPolicyId).toBe(CORS_WITH_PREFLIGHT_ID);
    expect(b.OriginRequestPolicyId).toBeUndefined();
    expect(b.TrustedKeyGroups).toHaveLength(1);
    expect(dist.PriceClass).toBe('PriceClass_All');
    expect(dist.HttpVersion).toBe('http2and3');
    expect(dist.IPV6Enabled).toBe(true);
    expect(dist.WebACLId).toBeDefined(); // cross-region reference to the waf stack
  });

  it('no custom cache / origin-request / response-headers policy on the data distribution (Pro tier allows managed only, N4)', () => {
    t.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 0);
    t.resourceCountIs('AWS::CloudFront::CachePolicy', 0);
    t.resourceCountIs('AWS::CloudFront::OriginRequestPolicy', 0);
    t.resourceCountIs('AWS::CloudFront::RealtimeLogConfig', 0);
  });

  describe('flat-rate plan subscription (T1.6b)', () => {
    it('is absent without cfg.flatRatePlan (pay-as-you-go)', () => {
      t.resourceCountIs('AWS::PricingPlanManager::Subscription', 0);
      expect(stacks.cdn.flatRatePlan).toBeUndefined();
    });

    it('PRO: one subscription for the distribution + WAF Web ACL, DEFAULT usage level, ARN/status outputs', () => {
      const { stacks: s, templates: tt } = buildTestApp({ flatRatePlan: { tier: 'PRO' } });
      const c = tt.cdn;
      c.resourceCountIs('AWS::PricingPlanManager::Subscription', 1);
      const sub = Object.values(c.findResources('AWS::PricingPlanManager::Subscription'))[0]!;
      expect(sub.Properties.PlanFamily).toBe('CloudFront');
      expect(sub.Properties.PlanTier).toBe('PRO');
      expect(sub.Properties.UsageLevel).toBe('DEFAULT');
      expect(sub.Properties.ResourceArns).toHaveLength(2);
      // distribution ARN built from the distribution's Ref -> created after the distribution, deleted before it
      expect(JSON.stringify(sub.Properties.ResourceArns[0])).toMatch(/distribution\//);
      expect(JSON.stringify(sub.Properties.ResourceArns[0])).toMatch(/"Ref":"DataDistribution/);
      // WAF Web ACL ARN = the same cross-region value the distribution uses
      expect(sub.Properties.ResourceArns[1]).toEqual(
        Object.values(c.findResources('AWS::CloudFront::Distribution'))[0]!.Properties.DistributionConfig
          .WebACLId,
      );
      expect(sub.DeletionPolicy).toBeUndefined(); // deleted with the stack: pending -> immediate, active -> end of month
      c.hasOutput('FlatRatePlanSubscriptionArn', { Value: { Ref: Match.stringLikeRegexp('^FlatRatePlan') } });
      c.hasOutput('FlatRatePlanStatusAtDeploy', {
        Value: { 'Fn::GetAtt': [Match.stringLikeRegexp('^FlatRatePlan'), 'Status'] },
      });
      expect(s.cdn.flatRatePlan).toBeDefined();
      // the plan-bound web ACL / distribution still live in the same stacks (no new stack, no data-stack reference)
      expect(JSON.stringify(c.toJSON())).not.toContain('genome-portal-data:ExportsOutput');
    });

    it('PREMIUM with a usage level passes it through', () => {
      const { templates: tt } = buildTestApp({
        flatRatePlan: { tier: 'PREMIUM', usageLevel: 'CF_PREMIUM_L3' },
      });
      tt.cdn.hasResourceProperties('AWS::PricingPlanManager::Subscription', {
        PlanTier: 'PREMIUM',
        UsageLevel: 'CF_PREMIUM_L3',
      });
    });
  });

  it('signing key: custom resource -> PublicKey (EncodedKey from the CR) -> KeyGroup; secret ARN exported', () => {
    t.resourceCountIs('Custom::GenomePortalSigningKey', 1);
    t.hasResourceProperties('AWS::CloudFront::PublicKey', {
      PublicKeyConfig: Match.objectLike({
        Name: names.signingPublicKey,
        EncodedKey: { 'Fn::GetAtt': ['SigningKey', 'PublicKeyPem'] },
      }),
    });
    t.hasResourceProperties('AWS::CloudFront::KeyGroup', {
      KeyGroupConfig: Match.objectLike({ Name: names.signingKeyGroup }),
    });
    t.hasOutput('SigningKeySecretArn', {});
    t.hasOutput('KeyPairId', {});
    t.hasOutput('DistributionArn', {});
  });

  it('standard logging v2 (parquet) is delivered from us-east-1 into the Seoul cf-logs bucket', () => {
    const l = templates.cdnLogs;
    l.hasResourceProperties('AWS::Logs::DeliverySource', { LogType: 'ACCESS_LOGS' });
    l.hasResourceProperties('AWS::Logs::DeliveryDestination', {
      DeliveryDestinationType: 'S3',
      OutputFormat: 'parquet',
    });
    l.hasResourceProperties('AWS::Logs::Delivery', {
      RecordFields: [...CF_LOG_FIELDS], // order = Glue column order (positional parquet mapping in the ops stack)
      S3SuffixPath: '{DistributionId}/{yyyy}/{MM}/{dd}/{HH}',
    });
    expect(CF_LOG_FIELDS).toEqual(expect.arrayContaining(['x-edge-result-type', 'sc-bytes', 'c-country']));
    t.resourceCountIs('AWS::Logs::DeliverySource', 0); // the Logs API rejects CloudFront sources outside us-east-1
    t.hasResourceProperties('AWS::S3::Bucket', { BucketName: names.cfLogsBucket('111111111111') });
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AWSLogDeliveryWrite',
            Condition: Match.objectLike({
              ArnLike: { 'aws:SourceArn': 'arn:aws:logs:us-east-1:111111111111:delivery-source:*' },
            }),
          }),
        ]),
      }),
    });
  });

  it('waf: CLOUDFRONT scope, managed common rule set + 2,000/5min rate limit, metrics on', () => {
    templates.waf.hasResourceProperties('AWS::WAFv2::WebACL', {
      Name: names.webAcl,
      Scope: 'CLOUDFRONT',
      VisibilityConfig: Match.objectLike({ CloudWatchMetricsEnabled: true }),
      Rules: Match.arrayWith([
        Match.objectLike({
          Statement: {
            ManagedRuleGroupStatement: { VendorName: 'AWS', Name: 'AWSManagedRulesCommonRuleSet' },
          },
        }),
        Match.objectLike({
          Statement: { RateBasedStatement: { Limit: 2000, AggregateKeyType: 'IP' } },
          Action: { Block: {} },
        }),
      ]),
    });
    expect(stacks.waf.region).toBe('us-east-1');
  });

  it('custom domain: us-east-1 certificates, data.<domain> alias, TLSv1.2_2021, Route53 A/AAAA', () => {
    const { templates: d } = buildTestApp({
      portalDomain: 'portal.example.org',
      hostedZoneId: 'Z0123456789ABCDEFGHIJ',
    });
    d.waf.resourceCountIs('AWS::CertificateManager::Certificate', 2);
    const cfg = Object.values(d.cdn.findResources('AWS::CloudFront::Distribution'))[0]!.Properties
      .DistributionConfig;
    expect(cfg.Aliases).toEqual(['data.portal.example.org']);
    expect(cfg.ViewerCertificate.MinimumProtocolVersion).toBe('TLSv1.2_2021');
    expect(cfg.ViewerCertificate.SslSupportMethod).toBe('sni-only');
    d.cdn.resourceCountIs('AWS::Route53::RecordSet', 2);
    d.web.resourceCountIs('AWS::Route53::RecordSet', 2);
  });
});

describe('web stack (T1.10)', () => {
  const { templates } = buildTestApp();
  const t = templates.web;
  const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0]!.Properties
    .DistributionConfig;

  it('/api/* behaviour: HTTP API origin, CachingDisabled, custom origin request policy without Host, x-origin-verify header', () => {
    const api = (dist.CacheBehaviors as Array<Record<string, unknown>>).find(
      (b) => b.PathPattern === `${API_BASE}/*`,
    )!;
    expect(api).toBeDefined();
    // Authorization can only be forwarded through the cache key, so a zero-TTL custom cache policy carries it
    // and the origin request policy forwards the rest without Host (API Gateway answers 403 to a foreign Host).
    expect(api.CachePolicyId).not.toBe(CACHING_DISABLED_ID);
    const cache = Object.values(t.findResources('AWS::CloudFront::CachePolicy'))[0]!.Properties
      .CachePolicyConfig;
    expect(cache.DefaultTTL).toBe(0);
    expect(cache.MaxTTL).toBe(1);
    expect(cache.ParametersInCacheKeyAndForwardedToOrigin.HeadersConfig.Headers).toEqual(['Authorization']);
    expect(api.OriginRequestPolicyId).not.toBe(ALL_VIEWER_AND_CLOUDFRONT_2022_ID);
    const policy = Object.values(t.findResources('AWS::CloudFront::OriginRequestPolicy'))[0]!.Properties
      .OriginRequestPolicyConfig;
    expect(policy.HeadersConfig.HeaderBehavior).toBe('whitelist');
    expect(policy.HeadersConfig.Headers).toEqual(
      expect.arrayContaining(['CloudFront-Viewer-Address', 'CloudFront-Viewer-Country', 'Content-Type']),
    );
    expect(policy.HeadersConfig.Headers).not.toContain('Host');
    expect(policy.HeadersConfig.Headers).not.toContain('Authorization');
    expect(api.ViewerProtocolPolicy).toBe('https-only');
    const origin = (dist.Origins as Array<Record<string, unknown>>).find((o) => o.Id === api.TargetOriginId)!;
    const headers = origin.OriginCustomHeaders as Array<{ HeaderName: string; HeaderValue: unknown }>;
    expect(headers.map((h) => h.HeaderName)).toEqual([ORIGIN_VERIFY_HEADER]);
    expect(JSON.stringify(headers[0]!.HeaderValue)).toContain('{{resolve:secretsmanager:');
    expect(JSON.stringify(origin.DomainName)).toContain('.execute-api.ap-northeast-2.amazonaws.com');
  });

  it('SPA routing: default root object, viewer-request rewrite function (no error pages, so API 403/404 pass through), S3 origin with OAC', () => {
    expect(dist.DefaultRootObject).toBe('index.html');
    expect(dist.CustomErrorResponses).toBeUndefined();
    const assoc = dist.DefaultCacheBehavior.FunctionAssociations as Array<Record<string, unknown>>;
    expect(assoc).toHaveLength(1);
    expect(assoc[0]!.EventType).toBe('viewer-request');
    t.hasResourceProperties('AWS::CloudFront::Function', { Name: 'genome-portal-web-spa-rewrite' });
    const apiBehavior = (dist.CacheBehaviors as Array<Record<string, unknown>>).find(
      (b) => b.PathPattern === `${API_BASE}/*`,
    )!;
    expect(apiBehavior.FunctionAssociations).toBeUndefined();
    const s3Origin = (dist.Origins as Array<Record<string, unknown>>).find(
      (o) => o.Id === dist.DefaultCacheBehavior.TargetOriginId,
    )!;
    expect(s3Origin.OriginAccessControlId).toBeDefined();
    t.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: names.webBucket('111111111111', 'ap-northeast-2'),
    });
  });

  it('config.json carries the contract thresholds and a placeholder index.html when web/dist is absent', () => {
    const { stacks } = buildTestApp();
    expect(stacks.web.portalConfig.splitThresholdBytes).toBe(SPLIT_THRESHOLD_BYTES);
    expect(stacks.web.portalConfig.singleObjectLimitBytes).toBe(SINGLE_OBJECT_LIMIT_BYTES);
    expect(stacks.web.portalConfig.apiBase).toBe(API_BASE);
    expect(stacks.web.portalConfig.mfaMode).toBe('REQUIRED');
    expect(stacks.web.portalConfig.brand.name).toBe('Genome Data Portal');
    t.resourceCountIs('Custom::CDKBucketDeployment', 1);
    t.hasOutput('PortalUrl', {});
  });

  it('brand.logoFile is uploaded at brand.logoUrl as a third deployment source; the local path never reaches config.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gp-logo-test-'));
    const logoFile = join(dir, 'provider.png');
    writeFileSync(logoFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]));
    const { stacks, templates } = buildTestApp({
      brand: {
        name: 'Genome Data Portal',
        logoUrl: '/brand/provider.png',
        logoFile,
        primaryColor: '#0f6cbd',
      },
    });
    const deployment = Object.values(templates.web.findResources('Custom::CDKBucketDeployment'))[0] as {
      Properties: { SourceObjectKeys: unknown[]; Prune: boolean };
    };
    expect(deployment.Properties.SourceObjectKeys).toHaveLength(3); // placeholder index, config.json, logo asset
    expect(deployment.Properties.Prune).toBe(true);
    expect(stacks.web.portalConfig.brand).toEqual({
      name: 'Genome Data Portal',
      logoUrl: '/brand/provider.png',
      primaryColor: '#0f6cbd',
    });
    // staged exactly at the URL path, bytes intact (binary-safe)
    const staged = stageLogo(logoFile, '/brand/provider.png');
    expect(readFileSync(join(staged, 'brand', 'provider.png'))).toEqual(readFileSync(logoFile));
    expect(stageLogo(logoFile, '/brand/provider.png')).toBe(staged); // content-addressed: stable asset hash
  });

  it('without logoFile the deployment has two sources and the SPA default logo URL is kept', () => {
    const { stacks, templates } = buildTestApp();
    const deployment = Object.values(templates.web.findResources('Custom::CDKBucketDeployment'))[0] as {
      Properties: { SourceObjectKeys: unknown[] };
    };
    expect(deployment.Properties.SourceObjectKeys).toHaveLength(2);
    expect(stacks.web.portalConfig.brand.logoUrl).toBe(DEFAULT_LOGO_URL);
  });
});
