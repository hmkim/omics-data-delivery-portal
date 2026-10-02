/**
 * Shared aws-sdk-client-mock setup: mocks every SDK client the Lambdas use and provides the
 * default "happy path" responses (SSM settings, origin-verify secret, CloudFront signing key).
 */
import { generateKeyPairSync } from 'node:crypto';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { S3ControlClient } from '@aws-sdk/client-s3-control';
import { S3Client } from '@aws-sdk/client-s3';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { SSM_DEFAULTS, SSM_PARAMS } from '@genome-portal/contract';
import { TEST } from './fixtures';

export const ddbMock = mockClient(DynamoDBDocumentClient);
export const ssmMock = mockClient(SSMClient);
export const secretsMock = mockClient(SecretsManagerClient);
export const s3ControlMock = mockClient(S3ControlClient);
export const s3Mock = mockClient(S3Client);
export const cognitoMock = mockClient(CognitoIdentityProviderClient);

export const { privateKey: TEST_PRIVATE_KEY_PEM } = (() => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
})();

export function ssmSettings(overrides: Partial<Record<keyof typeof SSM_PARAMS, string>> = {}) {
  const values = { ...SSM_DEFAULTS, ...overrides };
  return {
    Parameters: (Object.keys(SSM_PARAMS) as Array<keyof typeof SSM_PARAMS>).map((k) => ({
      Name: SSM_PARAMS[k],
      Value: values[k],
      Type: 'String' as const,
    })),
    InvalidParameters: [] as string[],
  };
}

/** Reset all mocks and install the default responses. Call from beforeEach. */
export function resetAllMocks(settings: Partial<Record<keyof typeof SSM_PARAMS, string>> = {}): void {
  ddbMock.reset();
  ssmMock.reset();
  secretsMock.reset();
  s3ControlMock.reset();
  s3Mock.reset();
  cognitoMock.reset();

  ssmMock.on(GetParametersCommand).resolves(ssmSettings(settings));
  secretsMock.on(GetSecretValueCommand).callsFake((input: { SecretId?: string }) => {
    if (input.SecretId?.includes('origin-verify')) return { SecretString: TEST.originSecret };
    if (input.SecretId?.includes('cf-signing-key'))
      return { SecretString: JSON.stringify({ privateKey: TEST_PRIVATE_KEY_PEM }) };
    throw Object.assign(new Error('ResourceNotFoundException'), { name: 'ResourceNotFoundException' });
  });
}

export function grantCredentials(
  expiration: Date = new Date(Date.now() + 3600_000),
  matched = `s3://${TEST.bucket}/projects/P1/*`,
) {
  return {
    Credentials: {
      AccessKeyId: 'ASIATESTKEY',
      SecretAccessKey: 'testsecret',
      SessionToken: 'testsession',
      Expiration: expiration,
    },
    MatchedGrantTarget: matched,
  };
}

export function awsError(name: string, httpStatusCode?: number): Error {
  return Object.assign(new Error(name), { name, $metadata: httpStatusCode ? { httpStatusCode } : {} });
}
