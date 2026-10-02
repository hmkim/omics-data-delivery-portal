import { CfnOutput } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import { names } from './constants';
import { PortalStack, type PortalStackProps } from './portal-stack';

/** Rate limit for the data distribution: 2,000 requests / 5 min / IP (design §1, N4). */
export const RATE_LIMIT_PER_5MIN = 2000;

/**
 * T1.5 -- us-east-1 edge resources: the WAF Web ACL the flat-rate plan requires (N4) and, when a custom domain
 * is configured, the ACM certificates CloudFront needs (they must live in us-east-1, so they are created here and
 * handed to the cdn / web stacks as cross-region references instead of via the deprecated DnsValidatedCertificate).
 */
export class WafStack extends PortalStack {
  public readonly webAcl: wafv2.CfnWebACL;
  /** ARN of the Web ACL, consumed by the cdn stack (cross-region reference). */
  public readonly webAclArn: string;
  /** Certificate for data.<portalDomain>; undefined without a custom domain. */
  public readonly dataCertificate?: acm.ICertificate;
  /** Certificate for <portalDomain>; undefined without a custom domain. */
  public readonly portalCertificate?: acm.ICertificate;

  constructor(scope: Construct, id: string, props: PortalStackProps) {
    super(
      scope,
      id,
      props,
      'WAF Web ACL for the data distribution (us-east-1, flat-rate plan requirement N4)',
    );

    this.webAcl = new wafv2.CfnWebACL(this, 'DataCdnAcl', {
      name: names.webAcl,
      description: 'genome-portal data distribution: AWS managed common rules + per-IP rate limit',
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'genome-portal-data-cdn-acl',
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 0,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'genome-portal-common-rules',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'RateLimitPerIp',
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: { limit: RATE_LIMIT_PER_5MIN, aggregateKeyType: 'IP' },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'genome-portal-rate-limit',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });
    this.webAclArn = this.webAcl.attrArn;

    if (this.cfg.portalDomain && this.cfg.hostedZoneId) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: this.cfg.hostedZoneId,
        zoneName: this.cfg.portalDomain,
      });
      this.dataCertificate = new acm.Certificate(this, 'DataCertificate', {
        domainName: `data.${this.cfg.portalDomain}`,
        validation: acm.CertificateValidation.fromDns(zone),
      });
      this.portalCertificate = new acm.Certificate(this, 'PortalCertificate', {
        domainName: this.cfg.portalDomain,
        validation: acm.CertificateValidation.fromDns(zone),
      });
      new CfnOutput(this, 'DataCertificateArn', { value: this.dataCertificate.certificateArn });
      new CfnOutput(this, 'PortalCertificateArn', { value: this.portalCertificate.certificateArn });
    }

    new CfnOutput(this, 'WebAclArn', { value: this.webAclArn });
  }
}
