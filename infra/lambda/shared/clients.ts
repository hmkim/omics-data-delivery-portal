import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { S3ControlClient } from '@aws-sdk/client-s3-control';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { regionOrUndefined } from './env';

/**
 * One SDK client per service, created lazily and shared across a warm Lambda container.
 * Every module goes through these getters so aws-sdk-client-mock (which patches the class
 * prototype) sees a single instance per class in tests.
 */
let ddb: DynamoDBDocumentClient | undefined;
let ssm: SSMClient | undefined;
let secrets: SecretsManagerClient | undefined;
let s3control: S3ControlClient | undefined;
let cognito: CognitoIdentityProviderClient | undefined;

export function ddbClient(): DynamoDBDocumentClient {
  if (!ddb) {
    ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: regionOrUndefined() }), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return ddb;
}

export function ssmClient(): SSMClient {
  if (!ssm) ssm = new SSMClient({ region: regionOrUndefined() });
  return ssm;
}

export function secretsClient(): SecretsManagerClient {
  if (!secrets) secrets = new SecretsManagerClient({ region: regionOrUndefined() });
  return secrets;
}

export function s3ControlClient(): S3ControlClient {
  if (!s3control) s3control = new S3ControlClient({ region: regionOrUndefined() });
  return s3control;
}

export function cognitoClient(): CognitoIdentityProviderClient {
  if (!cognito) cognito = new CognitoIdentityProviderClient({ region: regionOrUndefined() });
  return cognito;
}
