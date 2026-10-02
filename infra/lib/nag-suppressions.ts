import type { Stack } from 'aws-cdk-lib';
import { NagSuppressions, type NagPackSuppression, type NagPackSuppressionAppliesTo } from 'cdk-nag';
import type { DeployConfig } from './config';
import { STACK_IDS } from './constants';

/**
 * cdk-nag (AwsSolutions) suppressions. Add an entry only with a concrete reason; the security review
 * (T8.2) re-reads this list. Path-less suppressions apply to the whole stack; `appliesTo` narrows granular
 * findings (IAM4/IAM5) to the exact policy / resource pattern so anything new still fails synth.
 */
export interface StackSuppression {
  stackId: string;
  path?: string;
  rules: Array<{ id: string; reason: string; appliesTo?: NagPackSuppressionAppliesTo[] }>;
}

const rx = (source: string): NagPackSuppressionAppliesTo => ({ regex: `/${source}/` });

const LAMBDA_RUNTIME = {
  id: 'AwsSolutions-L1',
  reason:
    'Handlers are built for Node.js 22 (brief: runtime NODEJS_22_X, esbuild target node22). Node.js 24 is newer in the runtime list; the upgrade is a deliberate, tested change, not an automatic one.',
};

const CDK_FRAMEWORK_MANAGED_POLICY = {
  id: 'AwsSolutions-IAM4',
  reason:
    'CDK-owned framework function (custom resource provider framework / BucketDeployment / cross-region export); it attaches AWSLambdaBasicExecutionRole by construction and runs only during deployments.',
  appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
};

const LOGS_WILDCARD = {
  id: 'AwsSolutions-IAM5',
  reason:
    'CloudWatch Logs requires the :* suffix on the log-group ARN for CreateLogStream / PutLogEvents; each role is limited to the log groups of its own functions.',
  appliesTo: [
    rx('^Resource::arn:aws:logs:[^:]+:[0-9]+:log-group:/aws/lambda/genome-portal-[a-z-]+:\\*$'),
    rx('^Resource::<[A-Za-z0-9]+Logs[A-Za-z0-9]*\\.Arn>$'),
  ],
};

const DDB_INDEX_WILDCARD = {
  id: 'AwsSolutions-IAM5',
  reason:
    'DynamoDB GSIs are addressed as <table>/index/*; the resources are the three portal tables only (CDK grantReadData / grantReadWriteData).',
  // Two spellings: same-stack <Table.Arn> and cross-stack import genome-portal-data:ExportsOutputFnGetAtt...Arn...
  appliesTo: [
    rx(
      '^Resource::(<|genome-portal-data:ExportsOutputFnGetAtt)(OrgsTable|ObjectDownloadsTable|AuditEventsTable)[A-Za-z0-9.>]+/index/\\*$',
    ),
  ],
};

const KMS_GRANT_WILDCARD = {
  id: 'AwsSolutions-IAM5',
  reason:
    'kms:GenerateDataKey* / kms:ReEncrypt* are the standard CDK DynamoDB key grant on the single portal data key.',
  appliesTo: ['Action::kms:GenerateDataKey*', 'Action::kms:ReEncrypt*'],
};

const CFR4_DEFAULT_DOMAIN = {
  id: 'AwsSolutions-CFR4',
  reason:
    'Without a custom domain CloudFront ignores MinimumProtocolVersion for the default *.cloudfront.net certificate. README warns that production must set portalDomain (N2); with portalDomain TLS_V1_2_2021 is enforced.',
};

export function buildSuppressions(cfg: DeployConfig): StackSuppression[] {
  return [
    // ---------------------------------------------------------------- every stack
    ...Object.values(STACK_IDS).map((stackId) => ({ stackId, rules: [LAMBDA_RUNTIME] })),

    // ---------------------------------------------------------------- auth
    {
      stackId: STACK_IDS.auth,
      rules: [
        {
          id: 'AwsSolutions-COG3',
          reason:
            'Advanced security / threat protection requires the Plus feature plan (per-MAU price). Users are admin-created, TOTP MFA is required by default, no self sign-up; cost/benefit re-evaluated in the security review (T8.2).',
        },
        {
          id: 'AwsSolutions-COG8',
          reason:
            'Plus tier not required for this user population (admin-created users, TOTP MFA, no self sign-up); re-evaluated in T8.2.',
        },
        ...(cfg.mfaMode === 'OPTIONAL'
          ? [
              {
                id: 'AwsSolutions-COG2',
                reason:
                  'mfaMode=OPTIONAL chosen by the operator in the deployment config (R1.4 allows OPTIONAL).',
              },
            ]
          : []),
        LOGS_WILDCARD,
      ],
    },

    // ---------------------------------------------------------------- waf: nothing to suppress

    // ---------------------------------------------------------------- cdn
    {
      stackId: STACK_IDS.cdn,
      rules: [
        {
          id: 'AwsSolutions-CFR1',
          reason:
            'Users are distributed worldwide (41% overseas, N1); geo restriction is explicitly not wanted.',
        },
        {
          id: 'AwsSolutions-CFR3',
          reason:
            'Standard logging v2 (parquet) is configured through AWS::Logs::DeliverySource/Destination/Delivery, which this rule does not inspect (design §4.1).',
        },
        ...(cfg.portalDomain ? [] : [CFR4_DEFAULT_DOMAIN]),
        {
          id: 'AwsSolutions-S1',
          reason:
            'CloudFront log delivery bucket; logging the log bucket adds no security signal (the data bucket has server access logging).',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Secrets Manager appends a random 6-character suffix to secret ARNs; the signing-key custom resource must address genome-portal/cf-signing-key-*.',
          appliesTo: [
            rx('^Resource::arn:aws:secretsmanager:[^:]+:[0-9]+:secret:genome-portal/cf-signing-key-\\*$'),
          ],
        },
        LOGS_WILDCARD,
      ],
    },
    {
      stackId: STACK_IDS.cdn,
      path: `/${STACK_IDS.cdn}/SigningKeyProvider/framework-onEvent`,
      rules: [
        CDK_FRAMEWORK_MANAGED_POLICY,
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'CDK provider framework grants lambda:InvokeFunction on the handler and its versions (:*) by construction.',
          appliesTo: [rx('^Resource::<SigningKeyFn[A-Z0-9]+\\.Arn>:\\*$')],
        },
      ],
    },

    // ---------------------------------------------------------------- data
    {
      stackId: STACK_IDS.data,
      rules: [
        {
          id: 'AwsSolutions-S1',
          reason:
            'Server access logs bucket itself (the data bucket logs into it); logging the log bucket adds no signal.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'The Access Grants location role must read any object under the data bucket (arn/*); every session is restricted by the s3:AccessGrantsInstanceArn condition to credentials minted by Access Grants for a granted prefix (design §2.3).',
          appliesTo: [
            rx('^Resource::<DataBucket[A-Z0-9]+\\.Arn>/\\*$'),
            rx(
              `^Resource::arn:aws:s3:::${cfg.dataBucketName ?? 'genome-portal-data-[0-9]+-[a-z0-9-]+'}/\\*$`,
            ),
          ],
        },
      ],
    },

    // ---------------------------------------------------------------- api
    {
      stackId: STACK_IDS.api,
      rules: [
        LOGS_WILDCARD,
        DDB_INDEX_WILDCARD,
        KMS_GRANT_WILDCARD,
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'The admin role manages Cognito users through the Admin* API family on the single portal user pool (design §2.3).',
          appliesTo: ['Action::cognito-idp:Admin*'],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Access grant ARNs carry a generated id; grant lifecycle is scoped to this account and the default instance (access-grants/default/grant/*).',
          appliesTo: [rx('^Resource::arn:aws:s3:[^:]+:[0-9]+:access-grants/default/grant/\\*$')],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'cloudwatch:PutMetricData has no resource-level permissions; the statement is restricted by the cloudwatch:namespace condition.',
          appliesTo: ['Resource::*'],
        },
        {
          id: 'AwsSolutions-SMG4',
          reason:
            'x-origin-verify is a shared header secret between CloudFront and the Lambdas; rotation requires a coordinated distribution update and is a documented manual runbook step (no automatic rotation Lambda).',
        },
        {
          id: 'AwsSolutions-APIG4',
          reason:
            'Every route uses the Cognito JWT authorizer; only the CORS preflight OPTIONS route is unauthenticated (by protocol).',
        },
      ],
    },

    // ---------------------------------------------------------------- web
    {
      stackId: STACK_IDS.web,
      rules: [
        {
          id: 'AwsSolutions-S1',
          reason: 'Static SPA asset bucket behind OAC; requests are logged at the API stage / Lambda level.',
        },
        { id: 'AwsSolutions-CFR1', reason: 'Users are distributed worldwide (N1); no geo restriction.' },
        {
          id: 'AwsSolutions-CFR2',
          reason:
            'The web distribution is pay-as-you-go (N6); the API behind it is protected by the Cognito JWT authorizer and the x-origin-verify header. WAF is required (and configured) on the flat-rate data distribution only (N4).',
        },
        {
          id: 'AwsSolutions-CFR3',
          reason: 'Static assets + API proxy; API access logs are kept by the HTTP API stage (T1.9).',
        },
        ...(cfg.portalDomain ? [] : [CFR4_DEFAULT_DOMAIN]),
        CDK_FRAMEWORK_MANAGED_POLICY,
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'CDK BucketDeployment framework role: reads the CDK asset bucket and writes/prunes the SPA bucket (object wildcards by construction; deployment-time only).',
          appliesTo: [
            'Action::s3:GetObject*',
            'Action::s3:GetBucket*',
            'Action::s3:List*',
            'Action::s3:DeleteObject*',
            'Action::s3:Abort*',
            'Resource::*',
            rx('^Resource::arn:aws:s3:::cdk-[a-z0-9]+-assets-[0-9]+-[a-z0-9-]+/\\*$'),
            rx('^Resource::<WebBucket[A-Z0-9]+\\.Arn>/\\*$'),
          ],
        },
      ],
    },

    // ---------------------------------------------------------------- ops
    {
      stackId: STACK_IDS.ops,
      rules: [
        LOGS_WILDCARD,
        DDB_INDEX_WILDCARD,
        KMS_GRANT_WILDCARD,
        {
          id: 'AwsSolutions-S1',
          reason:
            'Athena results / audit archive buckets hold derived operational data (no genome data); server access logging adds no signal here.',
        },
        {
          id: 'AwsSolutions-SNS2',
          reason:
            'Alarm notifications carry metric names and thresholds only (no customer data); a KMS-encrypted topic would need a CloudWatch-alarms key policy for no confidentiality gain.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'opsDaily reads the CloudFront log prefix of the data distribution and its own Athena results prefix, writes audit/* archive objects (object wildcards under fixed prefixes); CloudWatch GetMetric* has no resource-level permissions.',
          appliesTo: [
            'Action::s3:GetObject*',
            'Action::s3:GetBucket*',
            'Action::s3:List*',
            'Action::s3:DeleteObject*',
            'Action::s3:Abort*',
            'Resource::*',
            rx(
              '^Resource::(<|genome-portal-cdn:ExportsOutputFnGetAtt)CfLogsBucket[A-Za-z0-9.>]+/AWSLogs/[0-9]+/CloudFront/(<|genome-portal-cdn:ExportsOutputRef)DataDistribution[A-Za-z0-9>]+/\\*$',
            ),
            rx('^Resource::<AthenaBucket[A-Z0-9]+\\.Arn>/results/\\*$'),
            rx('^Resource::<AuditArchiveBucket[A-Z0-9]+\\.Arn>/audit/\\*$'),
          ],
        },
      ],
    },
  ];
}

export function applyNagSuppressions(stacks: Record<string, Stack>, cfg: DeployConfig): void {
  for (const s of buildSuppressions(cfg)) {
    const stack = stacks[s.stackId];
    if (!stack) throw new Error(`Suppression references unknown stack ${s.stackId}`);
    const rules: NagPackSuppression[] = s.rules.map((r) => ({
      id: r.id,
      reason: r.reason,
      appliesTo: r.appliesTo,
    }));
    if (s.path) {
      NagSuppressions.addResourceSuppressionsByPath(stack, s.path, rules, true);
    } else {
      NagSuppressions.addStackSuppressions(stack, rules, true);
    }
  }
}
