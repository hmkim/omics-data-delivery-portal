import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { CloudTrailClient } from '@aws-sdk/client-cloudtrail';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { S3ControlClient } from '@aws-sdk/client-s3-control';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SSMClient } from '@aws-sdk/client-ssm';
import { fromEnv } from '@aws-sdk/credential-provider-env';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types';

/** Deployed dev region; CloudFormation for the WAF / CDN-logs stacks and CloudFront metrics live in us-east-1. */
export const REGION = process.env['INTEG_REGION'] ?? 'ap-northeast-2';
export const US_EAST_1 = 'us-east-1';

/** How long a credential snapshot is trusted before the file is re-read (sandbox tokens are re-vended by hand). */
const CREDENTIAL_REFRESH_MS = 10 * 60 * 1000;

/**
 * The sandbox rotates the shared credentials file while a long run (slow tests take >60 min) is in flight.
 * The default chain caches what it read first, so this provider re-reads the file on every refresh and
 * stamps a short expiration so the SDK asks again every few minutes.
 */
export function refreshingCredentials(): AwsCredentialIdentityProvider {
  const ini = fromIni({ ignoreCache: true });
  const env = fromEnv();
  return async (): Promise<AwsCredentialIdentity> => {
    const c = await ini().catch(() => env());
    return { ...c, expiration: new Date(Date.now() + CREDENTIAL_REFRESH_MS) };
  };
}

const credentials = refreshingCredentials();

function memo<T>(factory: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= factory());
}

export const aws = {
  cfn: memo(() => new CloudFormationClient({ region: REGION, credentials })),
  cfnUsEast1: memo(() => new CloudFormationClient({ region: US_EAST_1, credentials })),
  cognito: memo(() => new CognitoIdentityProviderClient({ region: REGION, credentials })),
  s3: memo(() => new S3Client({ region: REGION, credentials })),
  s3control: memo(() => new S3ControlClient({ region: REGION, credentials })),
  ddb: memo(() =>
    DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION, credentials }), {
      marshallOptions: { removeUndefinedValues: true },
    }),
  ),
  ssm: memo(() => new SSMClient({ region: REGION, credentials })),
  secrets: memo(() => new SecretsManagerClient({ region: REGION, credentials })),
  cloudwatch: memo(() => new CloudWatchClient({ region: REGION, credentials })),
  cloudtrail: memo(() => new CloudTrailClient({ region: REGION, credentials })),
  lambda: memo(() => new LambdaClient({ region: REGION, credentials })),
} as const;

/** S3 client bound to the credentials the portal handed out (T6.3 isolation checks). */
export function s3WithCredentials(c: {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: string;
}): S3Client {
  return new S3Client({
    region: REGION,
    credentials: {
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      sessionToken: c.sessionToken,
      expiration: c.expiration ? new Date(c.expiration) : undefined,
    },
  });
}
