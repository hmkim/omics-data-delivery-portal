import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import {
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { DEV } from './env';

const execFileAsync = promisify(execFile);

export interface AwsIdentity {
  account: string;
  arn: string;
}

let cached: Promise<AwsIdentity | undefined> | undefined;

/** `aws sts get-caller-identity` through the CLI's own credential chain, once per worker process. */
export function awsIdentity(): Promise<AwsIdentity | undefined> {
  cached ??= (async () => {
    try {
      const { stdout } = await execFileAsync(
        'aws',
        ['sts', 'get-caller-identity', '--output', 'json', '--region', DEV.region],
        { timeout: 30_000 },
      );
      const parsed = JSON.parse(stdout) as { Account: string; Arn: string };
      return { account: parsed.Account, arn: parsed.Arn };
    } catch {
      return undefined;
    }
  })();
  return cached;
}

export type AwsGate = { ok: true; identity: AwsIdentity } | { ok: false; reason: string };

/**
 * Gate for everything that needs AWS credentials (T7.4 AdminUserGlobalSignOut, T7.6 Athena / server-side copy):
 * credentials must resolve AND belong to the dev account (a cloud desktop instance profile in another account does
 * not count). Callers `test.skip` with `reason` and print what to run later (README "Credential-gated tests").
 */
export async function awsGate(): Promise<AwsGate> {
  const identity = await awsIdentity();
  if (!identity) return { ok: false, reason: NO_AWS_CREDENTIALS };
  if (identity.account !== DEV.accountId) {
    return {
      ok: false,
      reason: `AWS credentials belong to account ${identity.account} (${identity.arn}), not the dev account ${DEV.accountId}. ${NO_AWS_CREDENTIALS}`,
    };
  }
  return { ok: true, identity };
}

export const NO_AWS_CREDENTIALS =
  'AWS credentials unavailable (`aws sts get-caller-identity` failed). Re-run this test once the operator session is back; see web/e2e/README.md "Credential-gated tests".';

/** Cognito `AdminUserGlobalSignOut`: revokes the user's refresh token (and Cognito-side access/ID token validity). */
export async function adminUserGlobalSignOut(email: string, userPoolId = DEV.userPoolId): Promise<void> {
  const client = new CognitoIdentityProviderClient({ region: DEV.region });
  await client.send(new AdminUserGlobalSignOutCommand({ UserPoolId: userPoolId, Username: email }));
}

export interface AthenaRow {
  [column: string]: string;
}

/** Runs one Athena query in the ops work group and returns the rows as column → string maps. */
export async function athenaQuery(sql: string, timeoutMs = 120_000): Promise<AthenaRow[]> {
  const client = new AthenaClient({ region: DEV.region });
  const started = await client.send(
    new StartQueryExecutionCommand({
      QueryString: sql,
      WorkGroup: DEV.athena.workGroup,
      QueryExecutionContext: { Database: DEV.athena.database },
    }),
  );
  const id = started.QueryExecutionId!;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const exec = await client.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const state = exec.QueryExecution?.Status?.State;
    if (state === 'SUCCEEDED') break;
    if (state === 'FAILED' || state === 'CANCELLED') {
      throw new Error(
        `Athena query ${state}: ${exec.QueryExecution?.Status?.StateChangeReason ?? ''}\n${sql}`,
      );
    }
    if (Date.now() > deadline) throw new Error(`Athena query ${id} did not finish within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  const rows: AthenaRow[] = [];
  let header: string[] | undefined;
  let nextToken: string | undefined;
  do {
    const page = await client.send(
      new GetQueryResultsCommand({ QueryExecutionId: id, NextToken: nextToken }),
    );
    for (const r of page.ResultSet?.Rows ?? []) {
      const values = (r.Data ?? []).map((d) => d.VarCharValue ?? '');
      if (!header) {
        header = values;
        continue;
      }
      rows.push(Object.fromEntries(header.map((h, i) => [h, values[i] ?? ''])));
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return rows;
}

/** `dt` partition value (`yyyy/MM/dd`, UTC) for a timestamp. */
export function athenaDt(at: Date): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, '0');
  const d = String(at.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

/**
 * Per-request result types for one object between two instants (CloudFront standard logs: `date`/`time` are
 * strings, `sc_range_start`/`sc_range_end` describe the part range). Both days are included when the window crosses
 * midnight UTC.
 */
export function cacheResultTypesSql(uriStem: string, from: Date, to: Date): string {
  const dts = [...new Set([athenaDt(from), athenaDt(to)])].map((d) => `'${d}'`).join(', ');
  const fromTs = from.toISOString().slice(0, 19).replace('T', ' ');
  const toTs = to.toISOString().slice(0, 19).replace('T', ' ');
  return [
    'SELECT date, time, x_edge_result_type, sc_range_start, sc_range_end, sc_status, x_edge_request_id',
    `FROM "${DEV.athena.database}"."${DEV.athena.table}"`,
    `WHERE dt IN (${dts})`,
    `  AND cs_uri_stem = '${uriStem}'`,
    `  AND concat(date, ' ', time) BETWEEN '${fromTs}' AND '${toTs}'`,
    'ORDER BY date, time',
  ].join('\n');
}
