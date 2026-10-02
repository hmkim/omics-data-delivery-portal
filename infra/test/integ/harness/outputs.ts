import { DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { STACK_IDS } from '../../../lib/constants';
import { aws } from './aws';

/** Output keys of the eight stacks (design §1; brief "Deployed dev facts"). */
export interface StackOutputs {
  // auth
  UserPoolId: string;
  ClientId: string;
  // cdn (data distribution)
  DistributionId: string;
  DomainName: string;
  KeyPairId: string;
  // data
  DataBucketName: string;
  OrgsTableName: string;
  ObjectDownloadsTableName: string;
  AuditEventsTableName: string;
  GranteeRoleArn: string;
  AccessGrantsInstanceArn: string;
  LocationId: string;
  // api
  ApiEndpoint: string;
  ApiId: string;
  OriginVerifySecretArn: string;
  // web
  PortalUrl: string;
  WebDistributionId: string;
  // ops
  OpsDailyFunctionName: string;
  AthenaWorkGroup: string;
  AuditArchiveBucketName: string;
}

const REQUIRED: ReadonlyArray<keyof StackOutputs> = [
  'UserPoolId',
  'ClientId',
  'DistributionId',
  'DomainName',
  'KeyPairId',
  'DataBucketName',
  'OrgsTableName',
  'ObjectDownloadsTableName',
  'AuditEventsTableName',
  'GranteeRoleArn',
  'AccessGrantsInstanceArn',
  'LocationId',
  'ApiEndpoint',
  'ApiId',
  'OriginVerifySecretArn',
  'PortalUrl',
  'WebDistributionId',
  'OpsDailyFunctionName',
  'AthenaWorkGroup',
  'AuditArchiveBucketName',
];

/** Stack id -> region. */
const STACKS: ReadonlyArray<{ id: string; usEast1: boolean }> = [
  { id: STACK_IDS.auth, usEast1: false },
  { id: STACK_IDS.waf, usEast1: true },
  { id: STACK_IDS.cdn, usEast1: false },
  { id: STACK_IDS.cdnLogs, usEast1: true },
  { id: STACK_IDS.data, usEast1: false },
  { id: STACK_IDS.api, usEast1: false },
  { id: STACK_IDS.web, usEast1: false },
  { id: STACK_IDS.ops, usEast1: false },
];

let cached: Promise<StackOutputs & { raw: Record<string, string> }> | undefined;

async function describe(stackId: string, usEast1: boolean): Promise<Record<string, string>> {
  const client = usEast1 ? aws.cfnUsEast1() : aws.cfn();
  const out = await client.send(new DescribeStacksCommand({ StackName: stackId }));
  const stack = out.Stacks?.[0];
  if (!stack) throw new Error(`stack ${stackId} not found`);
  const record: Record<string, string> = {};
  for (const o of stack.Outputs ?? [])
    if (o.OutputKey && o.OutputValue !== undefined) record[o.OutputKey] = o.OutputValue;
  return record;
}

/** DescribeStacks for the eight stacks, merged and validated; cached per process. */
export function stackOutputs(): Promise<StackOutputs & { raw: Record<string, string> }> {
  cached ??= (async () => {
    const parts = await Promise.all(STACKS.map((s) => describe(s.id, s.usEast1)));
    const raw = Object.assign({}, ...parts) as Record<string, string>;
    const missing = REQUIRED.filter((k) => !raw[k]);
    if (missing.length > 0) throw new Error(`stack outputs missing: ${missing.join(', ')}`);
    const typed = Object.fromEntries(REQUIRED.map((k) => [k, raw[k]])) as unknown as StackOutputs;
    return { ...typed, raw };
  })();
  return cached;
}

/** `${PortalUrl}` without a trailing slash. */
export async function portalBase(): Promise<string> {
  const o = await stackOutputs();
  return o.PortalUrl.replace(/\/+$/, '');
}

/** `${ApiEndpoint}` without a trailing slash. */
export async function apiBase(): Promise<string> {
  const o = await stackOutputs();
  return o.ApiEndpoint.replace(/\/+$/, '');
}
