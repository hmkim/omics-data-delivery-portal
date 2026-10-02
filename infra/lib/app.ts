import { Aspects, type App } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ApiStack } from './api-stack';
import { applyProjectTag, ResourcePrefixAspect } from './aspects';
import { AuthStack } from './auth-stack';
import { CdnLogsStack } from './cdn-logs-stack';
import { CdnStack } from './cdn-stack';
import type { DeployConfig } from './config';
import { STACK_IDS } from './constants';
import { DataStack } from './data-stack';
import { applyNagSuppressions } from './nag-suppressions';
import { OpsStack } from './ops-stack';
import { WafStack } from './waf-stack';
import { WebStack } from './web-stack';

export interface PortalAppOptions {
  cfg: DeployConfig;
  account: string;
  /** `-c skipCdnPolicy=true` (README first-deployment fallback, T1.7). */
  skipCdnPolicy?: boolean;
  /** Attach cdk-nag AwsSolutions checks (default true). */
  nag?: boolean;
  /** Built SPA directory override (tests). */
  webDistDir?: string;
}

export interface PortalStacks {
  auth: AuthStack;
  waf: WafStack;
  cdn: CdnStack;
  cdnLogs: CdnLogsStack;
  data: DataStack;
  api: ApiStack;
  web: WebStack;
  ops: OpsStack;
}

/**
 * Builds the eight stacks and wires their props. Dependency direction (README, T1.7):
 * auth, waf -> cdn -> cdn-logs (us-east-1) / data -> api -> web -> ops. cdn never references data constructs; data
 * consumes the distribution ARN for its bucket / KMS policies, which keeps the CloudFormation graph acyclic.
 */
export function buildPortalApp(app: App, opts: PortalAppOptions): PortalStacks {
  const { cfg, account } = opts;
  const primary = { account, region: cfg.region };
  const usEast1 = { account, region: 'us-east-1' };
  const common = { cfg, crossRegionReferences: true };

  const auth = new AuthStack(app, STACK_IDS.auth, { ...common, env: primary });
  const waf = new WafStack(app, STACK_IDS.waf, { ...common, env: usEast1 });
  const cdn = new CdnStack(app, STACK_IDS.cdn, {
    ...common,
    env: primary,
    webAclArn: waf.webAclArn,
    certificate: waf.dataCertificate,
  });
  const cdnLogs = new CdnLogsStack(app, STACK_IDS.cdnLogs, {
    ...common,
    env: usEast1,
    distributionArn: cdn.distribution.distributionArn,
    logsBucketArn: cdn.logsBucket.bucketArn,
  });
  const data = new DataStack(app, STACK_IDS.data, {
    ...common,
    env: primary,
    distributionArn: cdn.distribution.distributionArn,
    skipCdnPolicy: opts.skipCdnPolicy ?? false,
  });
  const api = new ApiStack(app, STACK_IDS.api, {
    ...common,
    env: primary,
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
    orgsTable: data.orgsTable,
    objectDownloadsTable: data.objectDownloadsTable,
    auditEventsTable: data.auditEventsTable,
    ssmParameters: data.ssmParameters,
    dataBucketName: data.dataBucketName,
    accessGrantsInstanceArn: data.accessGrantsInstanceArn,
    accessGrantsLocationId: data.accessGrantsLocationId,
    cfDomainName: cdn.dataDomainName,
    cfKeyPairId: cdn.publicKey.publicKeyId,
    cfSigningKeySecretArn: cdn.signingKeySecretArn,
  });
  const web = new WebStack(app, STACK_IDS.web, {
    ...common,
    env: primary,
    userPoolId: auth.userPool.userPoolId,
    userPoolClientId: auth.userPoolClient.userPoolClientId,
    apiId: api.httpApi.apiId,
    originVerifySecret: api.originVerifySecret,
    dataBucketName: data.dataBucketName,
    cfDomainName: cdn.dataDomainName,
    certificate: waf.portalCertificate,
    webDistDir: opts.webDistDir,
  });
  const ops = new OpsStack(app, STACK_IDS.ops, {
    ...common,
    env: primary,
    distributionId: cdn.distribution.distributionId,
    cfLogsBucket: cdn.logsBucket,
    cfLogPrefix: cdn.logPrefixForDistribution,
    orgsTable: data.orgsTable,
    auditEventsTable: data.auditEventsTable,
    accessGrantsInstanceArn: data.accessGrantsInstanceArn,
    granteeRoleArn: api.granteeRole.roleArn,
    downloadsFunction: api.functions.downloads,
    apiId: api.httpApi.apiId,
  });

  const stacks: PortalStacks = { auth, waf, cdn, cdnLogs, data, api, web, ops };

  applyProjectTag(app);
  Aspects.of(app).add(new ResourcePrefixAspect());
  if (opts.nag ?? true) {
    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  }
  applyNagSuppressions(
    {
      [STACK_IDS.auth]: auth,
      [STACK_IDS.waf]: waf,
      [STACK_IDS.cdn]: cdn,
      [STACK_IDS.cdnLogs]: cdnLogs,
      [STACK_IDS.data]: data,
      [STACK_IDS.api]: api,
      [STACK_IDS.web]: web,
      [STACK_IDS.ops]: ops,
    },
    cfg,
  );
  return stacks;
}
