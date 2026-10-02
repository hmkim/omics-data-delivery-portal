/**
 * Real command implementations: load config, obtain a token, call the admin API, print results.
 */
import type { AuditEvent, LocationRecord } from '@genome-portal/contract';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { AdminApiClient } from './api.js';
import { getIdToken } from './auth.js';
import type { CliHandlers, GlobalOptions } from './cli.js';
import { loadAdminConfig } from './config.js';
import { auditEventToCsvRow, csvHeader } from './csv.js';
import { expandDays } from './dates.js';
import { promptLine } from './prompt.js';

function client(g: GlobalOptions): AdminApiClient {
  const cfg = loadAdminConfig(g.config);
  let forceLogin = Boolean(g.login);
  return new AdminApiClient({
    portalUrl: cfg.portalUrl,
    getIdToken: async () => {
      const token = await getIdToken(cfg, { forceLogin });
      forceLogin = false; // only the first call in a process honours --login
      return token;
    },
  });
}

function printJson(v: unknown): void {
  console.log(JSON.stringify(v, null, 2));
}

function printLocations(items: LocationRecord[]): void {
  if (items.length === 0) {
    console.log('(no locations)');
    return;
  }
  const rows = items.map((l) => ({
    bucket: l.bucket,
    prefix: l.prefix,
    orgs: l.orgIds.join(' '),
    grant: l.accessGrantId ?? '-',
    label: l.label ?? '',
  }));
  console.table(rows);
}

export const handlers: CliHandlers = {
  async orgCreate({ orgId, name }, g) {
    printJson(await client(g).org({ action: 'create', orgId, name }));
  },
  async orgDisable({ orgId }, g) {
    printJson(await client(g).org({ action: 'disable', orgId }));
  },

  async locationAssign({ orgId, bucket, prefix, label }, g) {
    const req = label
      ? ({ action: 'assign', orgId, bucket, prefix, label } as const)
      : ({ action: 'assign', orgId, bucket, prefix } as const);
    printJson(await client(g).location(req));
  },
  async locationUnassign({ orgId, bucket, prefix }, g) {
    printJson(await client(g).location({ action: 'unassign', orgId, bucket, prefix }));
  },
  async locationUnassignAll({ yes }, g) {
    if (!yes) {
      const answer = await promptLine(
        'This removes EVERY organisation->location assignment and deletes EVERY S3 Access Grant of the portal. Type "unassign all" to continue: ',
      );
      if (answer.trim() !== 'unassign all') {
        console.error('aborted');
        process.exitCode = 1;
        return;
      }
    }
    printJson(await client(g).location({ action: 'unassign-all' }));
  },
  async locationList({ orgId }, g) {
    const res = await client(g).locationList(orgId);
    printLocations(res.items ?? []);
  },

  async userCreate({ email, orgId, lang }, g) {
    printJson(await client(g).user({ action: 'create', email, orgId, lang }));
    console.error(`Temporary password has been e-mailed to ${email} by Cognito.`);
  },
  async userDisable({ email }, g) {
    printJson(await client(g).user({ action: 'disable', email }));
  },
  async userEnable({ email }, g) {
    printJson(await client(g).user({ action: 'enable', email }));
  },
  async userDelete({ email }, g) {
    printJson(await client(g).user({ action: 'delete', email }));
  },

  async countReset({ bucket, key }, g) {
    printJson(await client(g).resetCount({ bucket, key }));
  },

  async auditExport({ from, to, out }, g) {
    const days = expandDays(from, to);
    const api = client(g);
    const stream = createWriteStream(out, { encoding: 'utf8' });
    const write = async (line: string) => {
      if (!stream.write(line + '\r\n')) await once(stream, 'drain');
    };
    await write(csvHeader());
    let total = 0;
    for (const day of days) {
      let perDay = 0;
      for await (const event of api.auditEventsForDay(day)) {
        await write(auditEventToCsvRow(event as AuditEvent));
        perDay += 1;
      }
      total += perDay;
      console.error(`${day}: ${perDay} events`);
    }
    stream.end();
    await once(stream, 'finish');
    console.error(`wrote ${total} events for ${days.length} day(s) to ${out}`);
  },
};
