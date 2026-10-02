import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DOWNLOAD_META_TTL_DAYS, keys, type DownloadPath } from '@genome-portal/contract';
import { ddbClient } from './clients';
import { requireEnv } from './env';

/** DL#<downloadId> / META in the audit-events table (design §3): pins the path for renewals (R4.6). */
export interface DownloadMeta {
  downloadId: string;
  userSub: string;
  orgId: string;
  bucket: string;
  key: string;
  path: DownloadPath;
  issuedAt: string;
  renewCount: number;
  matchedGrantTarget?: string;
}

export const META_SK = 'META';

export function downloadMetaTtl(issuedAt: Date): number {
  return Math.floor(issuedAt.getTime() / 1000) + DOWNLOAD_META_TTL_DAYS * 24 * 60 * 60;
}

export async function putDownloadMeta(meta: DownloadMeta): Promise<void> {
  await ddbClient().send(
    new PutCommand({
      TableName: requireEnv('AUDIT_TABLE'),
      Item: {
        pk: keys.dl(meta.downloadId),
        sk: META_SK,
        ...meta,
        expiresAt: downloadMetaTtl(new Date(meta.issuedAt)),
      },
    }),
  );
}

export async function getDownloadMeta(downloadId: string): Promise<DownloadMeta | undefined> {
  const out = await ddbClient().send(
    new GetCommand({ TableName: requireEnv('AUDIT_TABLE'), Key: { pk: keys.dl(downloadId), sk: META_SK } }),
  );
  const item = out.Item as Record<string, unknown> | undefined;
  if (!item) return undefined;
  const path = item['path'];
  if (
    typeof item['userSub'] !== 'string' ||
    typeof item['orgId'] !== 'string' ||
    typeof item['bucket'] !== 'string' ||
    typeof item['key'] !== 'string' ||
    (path !== 'S3' && path !== 'CF')
  ) {
    return undefined;
  }
  return {
    downloadId,
    userSub: item['userSub'],
    orgId: item['orgId'],
    bucket: item['bucket'],
    key: item['key'],
    path,
    issuedAt: typeof item['issuedAt'] === 'string' ? item['issuedAt'] : '',
    renewCount: typeof item['renewCount'] === 'number' ? item['renewCount'] : 0,
    matchedGrantTarget:
      typeof item['matchedGrantTarget'] === 'string' ? item['matchedGrantTarget'] : undefined,
  };
}

/** renewCount += 1; returns the new value. */
export async function incrementRenewCount(downloadId: string): Promise<number> {
  const out = await ddbClient().send(
    new UpdateCommand({
      TableName: requireEnv('AUDIT_TABLE'),
      Key: { pk: keys.dl(downloadId), sk: META_SK },
      UpdateExpression: 'ADD renewCount :one SET lastRenewedAt = :now',
      ExpressionAttributeValues: { ':one': 1, ':now': new Date().toISOString() },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  const value = (out.Attributes as Record<string, unknown> | undefined)?.['renewCount'];
  return typeof value === 'number' ? value : 0;
}
