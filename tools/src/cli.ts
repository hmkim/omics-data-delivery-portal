/**
 * Command tree for `npm run admin -- <cmd>` (design §7.3). Parsing is separated from execution so the
 * tree can be unit-tested: `buildProgram(handlers)` wires each sub-command to a handler you provide.
 */
import { grantScopeFor, parseScope } from '@genome-portal/contract';
import { Command, InvalidArgumentError, Option } from 'commander';
import { isIsoDay } from './dates.js';

export interface GlobalOptions {
  config?: string;
  /** Ignore the cached token and sign in again */
  login?: boolean;
}

export interface CliHandlers {
  orgCreate(args: { orgId: string; name: string }, g: GlobalOptions): Promise<void>;
  orgDisable(args: { orgId: string }, g: GlobalOptions): Promise<void>;
  locationAssign(
    args: { orgId: string; bucket: string; prefix: string; label?: string },
    g: GlobalOptions,
  ): Promise<void>;
  locationUnassign(args: { orgId: string; bucket: string; prefix: string }, g: GlobalOptions): Promise<void>;
  locationUnassignAll(args: { yes: boolean }, g: GlobalOptions): Promise<void>;
  locationList(args: { orgId?: string }, g: GlobalOptions): Promise<void>;
  userCreate(args: { email: string; orgId: string; lang: 'ko' | 'en' }, g: GlobalOptions): Promise<void>;
  userDisable(args: { email: string }, g: GlobalOptions): Promise<void>;
  userEnable(args: { email: string }, g: GlobalOptions): Promise<void>;
  userDelete(args: { email: string }, g: GlobalOptions): Promise<void>;
  countReset(args: { bucket: string; key: string }, g: GlobalOptions): Promise<void>;
  auditExport(args: { from: string; to: string; out: string }, g: GlobalOptions): Promise<void>;
}

const ORG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseOrgId(v: string): string {
  if (!ORG_ID.test(v))
    throw new InvalidArgumentError(
      'org id: 1-64 chars, letters/digits/._- and must start with a letter or digit',
    );
  return v;
}

export function parseBucket(v: string): string {
  if (!BUCKET.test(v))
    throw new InvalidArgumentError('bucket: 3-63 lowercase letters, digits, dots or hyphens');
  return v;
}

/** A location prefix must end with "/" and contain no empty, "." or ".." segments (design §2.4 / §7.3). */
export function parsePrefix(v: string): string {
  const probe = parseScope(grantScopeFor('probe-bucket', v), 'probe-bucket');
  if (!probe)
    throw new InvalidArgumentError(
      'prefix: must end with "/" and must not contain empty, "." or ".." segments, nor "*"',
    );
  return probe.prefix;
}

export function parseEmail(v: string): string {
  if (!EMAIL.test(v)) throw new InvalidArgumentError('email: not a valid address');
  return v.toLowerCase();
}

export function parseDay(v: string): string {
  if (!isIsoDay(v)) throw new InvalidArgumentError('date: expected YYYY-MM-DD');
  return v;
}

export function parseObjectKey(v: string): string {
  if (v.length === 0 || v.endsWith('/'))
    throw new InvalidArgumentError('key: must be an object key, not a prefix');
  return v;
}

function globals(cmd: Command): GlobalOptions {
  // optsWithGlobals() merges the root program's --config/--login into the leaf command's options.
  const o = cmd.optsWithGlobals<{ config?: string; login?: boolean }>();
  return { config: o.config, login: o.login };
}

export function buildProgram(h: CliHandlers): Command {
  const program = new Command('admin')
    .description('genome-portal admin CLI (organisations, locations, users, download counts, audit export)')
    .option('--config <path>', 'admin config JSON (default tools/admin.config.json)')
    .option('--login', 'ignore the cached token and sign in again')
    .showHelpAfterError()
    .enablePositionalOptions();

  // org
  const org = program.command('org').description('organisation management');
  org
    .command('create')
    .requiredOption('--id <orgId>', 'organisation id', parseOrgId)
    .requiredOption('--name <name>', 'display name')
    .action(async function (this: Command, opts: { id: string; name: string }) {
      await h.orgCreate({ orgId: opts.id, name: opts.name }, globals(this));
    });
  org
    .command('disable')
    .requiredOption('--id <orgId>', 'organisation id', parseOrgId)
    .action(async function (this: Command, opts: { id: string }) {
      await h.orgDisable({ orgId: opts.id }, globals(this));
    });

  // location
  const location = program.command('location').description('S3 location (bucket + prefix) assignment');
  location
    .command('assign')
    .requiredOption('--org <orgId>', 'organisation id', parseOrgId)
    .requiredOption('--bucket <bucket>', 'data bucket', parseBucket)
    .requiredOption('--prefix <prefix>', 'prefix ending with "/" e.g. projects/P2026-0412/', parsePrefix)
    .option('--label <label>', 'display label')
    .action(async function (
      this: Command,
      opts: { org: string; bucket: string; prefix: string; label?: string },
    ) {
      const args: { orgId: string; bucket: string; prefix: string; label?: string } = {
        orgId: opts.org,
        bucket: opts.bucket,
        prefix: opts.prefix,
      };
      if (opts.label) args.label = opts.label;
      await h.locationAssign(args, globals(this));
    });
  location
    .command('unassign')
    .option('--org <orgId>', 'organisation id', parseOrgId)
    .option('--bucket <bucket>', 'data bucket', parseBucket)
    .option('--prefix <prefix>', 'prefix ending with "/"', parsePrefix)
    .option('--all', 'remove every assignment and every Access Grant (teardown)')
    .option('--yes', 'do not ask for confirmation with --all')
    .action(async function (
      this: Command,
      opts: { org?: string; bucket?: string; prefix?: string; all?: boolean; yes?: boolean },
    ) {
      if (opts.all) {
        if (opts.org || opts.bucket || opts.prefix)
          this.error('--all cannot be combined with --org/--bucket/--prefix');
        await h.locationUnassignAll({ yes: Boolean(opts.yes) }, globals(this));
        return;
      }
      if (!opts.org || !opts.bucket || !opts.prefix)
        this.error('--org, --bucket and --prefix are required (or use --all)');
      await h.locationUnassign({ orgId: opts.org, bucket: opts.bucket, prefix: opts.prefix }, globals(this));
    });
  location
    .command('list')
    .option('--org <orgId>', 'only locations assigned to this organisation', parseOrgId)
    .action(async function (this: Command, opts: { org?: string }) {
      await h.locationList(opts.org ? { orgId: opts.org } : {}, globals(this));
    });

  // user
  const user = program.command('user').description('Cognito user management');
  user
    .command('create')
    .requiredOption('--email <email>', 'user e-mail (username)', parseEmail)
    .requiredOption('--org <orgId>', 'organisation id', parseOrgId)
    .addOption(new Option('--lang <lang>', 'UI language').choices(['ko', 'en']).makeOptionMandatory())
    .action(async function (this: Command, opts: { email: string; org: string; lang: 'ko' | 'en' }) {
      await h.userCreate({ email: opts.email, orgId: opts.org, lang: opts.lang }, globals(this));
    });
  for (const [name, handler] of [
    ['disable', (a: { email: string }, g: GlobalOptions) => h.userDisable(a, g)],
    ['enable', (a: { email: string }, g: GlobalOptions) => h.userEnable(a, g)],
    ['delete', (a: { email: string }, g: GlobalOptions) => h.userDelete(a, g)],
  ] as const) {
    user
      .command(name)
      .requiredOption('--email <email>', 'user e-mail (username)', parseEmail)
      .action(async function (this: Command, opts: { email: string }) {
        await handler({ email: opts.email }, globals(this));
      });
  }

  // count
  program
    .command('count')
    .description('object download counter')
    .command('reset')
    .requiredOption('--bucket <bucket>', 'data bucket', parseBucket)
    .requiredOption('--key <key>', 'object key', parseObjectKey)
    .action(async function (this: Command, opts: { bucket: string; key: string }) {
      await h.countReset({ bucket: opts.bucket, key: opts.key }, globals(this));
    });

  // audit
  program
    .command('audit')
    .description('audit log export')
    .command('export')
    .requiredOption('--from <YYYY-MM-DD>', 'first UTC day (inclusive)', parseDay)
    .requiredOption('--to <YYYY-MM-DD>', 'last UTC day (inclusive)', parseDay)
    .requiredOption('--out <file.csv>', 'output CSV path')
    .action(async function (this: Command, opts: { from: string; to: string; out: string }) {
      await h.auditExport({ from: opts.from, to: opts.to, out: opts.out }, globals(this));
    });

  return program;
}
