/**
 * CloudFormation custom resource (Provider framework onEvent handler) that owns the CloudFront URL-signing key pair
 * (design §1 cdn stack, T1.6).
 *
 *  - Create: generate RSA-2048, store the PKCS#8 private key PEM as the SecretString of the Secrets Manager secret
 *    named in ResourceProperties.SecretName, return the SPKI public key PEM as Data.PublicKeyPem.
 *  - Update: never rotates. Reads the existing secret and derives the public key from the stored private key so
 *    the CfnPublicKey stays unchanged (in-flight signed URLs keep working).
 *  - Delete: deletes the secret. ForceDeleteWithoutRecovery is used because a secret scheduled for deletion blocks
 *    re-creating one with the same name on the next deployment; the key pair is regenerable and only invalidates
 *    URLs signed before the deletion.
 *
 * The secret value is the raw PEM string (no JSON wrapper); the signing Lambda passes it straight to
 * @aws-sdk/cloudfront-signer getSignedUrl({ privateKey }).
 */
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  ResourceExistsException,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { CdkCustomResourceEvent, CdkCustomResourceResponse } from 'aws-lambda';

export interface SigningKeyProperties {
  SecretName: string;
  Description?: string;
}

export interface SigningKeyData {
  PublicKeyPem: string;
  SecretArn: string;
}

let client: SecretsManagerClient | undefined;
function sm(): SecretsManagerClient {
  client ??= new SecretsManagerClient({});
  return client;
}

/** Exposed for tests: generate the pair and return both PEMs. */
export function generateSigningKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** Exposed for tests: the public key that belongs to a stored private key. */
export function publicKeyFromPrivatePem(privateKeyPem: string): string {
  return createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();
}

function propsOf(event: CdkCustomResourceEvent): SigningKeyProperties {
  const raw = event.ResourceProperties as unknown as Partial<SigningKeyProperties>;
  if (!raw.SecretName || typeof raw.SecretName !== 'string') {
    throw new Error('SigningKey custom resource requires ResourceProperties.SecretName');
  }
  return { SecretName: raw.SecretName, Description: raw.Description };
}

async function readExisting(secretId: string): Promise<{ arn: string; privateKeyPem: string } | undefined> {
  try {
    const out = await sm().send(new GetSecretValueCommand({ SecretId: secretId }));
    if (!out.ARN || !out.SecretString) return undefined;
    return { arn: out.ARN, privateKeyPem: out.SecretString };
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return undefined;
    throw err;
  }
}

async function onCreate(props: SigningKeyProperties): Promise<CdkCustomResourceResponse> {
  const pair = generateSigningKeyPair();
  let arn: string;
  try {
    const out = await sm().send(
      new CreateSecretCommand({
        Name: props.SecretName,
        Description: props.Description ?? 'genome-portal: CloudFront URL signing private key (PKCS#8 PEM)',
        SecretString: pair.privateKeyPem,
      }),
    );
    if (!out.ARN) throw new Error('CreateSecret returned no ARN');
    arn = out.ARN;
  } catch (err) {
    // A previous stack (or a manual run) left the secret behind: adopt it instead of failing the deployment.
    if (!(err instanceof ResourceExistsException)) throw err;
    const existing = await readExisting(props.SecretName);
    if (!existing) throw err;
    const data: SigningKeyData = {
      PublicKeyPem: publicKeyFromPrivatePem(existing.privateKeyPem),
      SecretArn: existing.arn,
    };
    return { PhysicalResourceId: existing.arn, Data: data };
  }
  const data: SigningKeyData = { PublicKeyPem: pair.publicKeyPem, SecretArn: arn };
  return { PhysicalResourceId: arn, Data: data };
}

async function onUpdate(props: SigningKeyProperties, physicalId: string): Promise<CdkCustomResourceResponse> {
  const existing = (await readExisting(physicalId)) ?? (await readExisting(props.SecretName));
  if (!existing) {
    // Secret vanished (deleted by hand): re-create so the distribution keeps a usable key group.
    return onCreate(props);
  }
  const data: SigningKeyData = {
    PublicKeyPem: publicKeyFromPrivatePem(existing.privateKeyPem),
    SecretArn: existing.arn,
  };
  return { PhysicalResourceId: existing.arn, Data: data };
}

async function onDelete(physicalId: string): Promise<CdkCustomResourceResponse> {
  try {
    await sm().send(new DeleteSecretCommand({ SecretId: physicalId, ForceDeleteWithoutRecovery: true }));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }
  return { PhysicalResourceId: physicalId };
}

export async function handler(event: CdkCustomResourceEvent): Promise<CdkCustomResourceResponse> {
  const props = propsOf(event);
  switch (event.RequestType) {
    case 'Create':
      return onCreate(props);
    case 'Update':
      return onUpdate(props, event.PhysicalResourceId);
    case 'Delete':
      return onDelete(event.PhysicalResourceId);
  }
}
