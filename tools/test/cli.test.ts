import { describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import { buildProgram, parseEmail, parseOrgId, parsePrefix, type CliHandlers } from '../src/cli.js';

function makeHandlers(): { h: CliHandlers; calls: Record<keyof CliHandlers, ReturnType<typeof vi.fn>> } {
  const names: Array<keyof CliHandlers> = [
    'orgCreate',
    'orgDisable',
    'locationAssign',
    'locationUnassign',
    'locationUnassignAll',
    'locationList',
    'userCreate',
    'userDisable',
    'userEnable',
    'userDelete',
    'countReset',
    'auditExport',
  ];
  const calls = Object.fromEntries(names.map((n) => [n, vi.fn().mockResolvedValue(undefined)])) as Record<
    keyof CliHandlers,
    ReturnType<typeof vi.fn>
  >;
  return { h: calls as unknown as CliHandlers, calls };
}

/** Parses `argv` (user args only) with exit/output captured. Returns the commander error, if any. */
async function run(program: Command, argv: string[]): Promise<{ error?: string }> {
  let error: string | undefined;
  const silence = (cmd: Command) => {
    cmd.exitOverride();
    cmd.configureOutput({ writeErr: (s) => (error = (error ?? '') + s), writeOut: () => undefined });
    cmd.commands.forEach(silence);
  };
  silence(program);
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    error = (error ?? '') + (e as Error).message;
  }
  return error ? { error } : {};
}

describe('admin CLI parsing', () => {
  it('org create', async () => {
    const { h, calls } = makeHandlers();
    const r = await run(buildProgram(h), [
      'org',
      'create',
      '--id',
      'KU-lab',
      '--name',
      'Korea University lab',
    ]);
    expect(r.error).toBeUndefined();
    expect(calls.orgCreate).toHaveBeenCalledWith(
      { orgId: 'KU-lab', name: 'Korea University lab' },
      { config: undefined, login: undefined },
    );
  });

  it('org create requires --name', async () => {
    const { h, calls } = makeHandlers();
    const r = await run(buildProgram(h), ['org', 'create', '--id', 'KU-lab']);
    expect(r.error).toMatch(/--name/);
    expect(calls.orgCreate).not.toHaveBeenCalled();
  });

  it('passes global --config and --login to the handler', async () => {
    const { h, calls } = makeHandlers();
    const r = await run(buildProgram(h), [
      '--config',
      '/tmp/x.json',
      '--login',
      'org',
      'disable',
      '--id',
      'demo',
    ]);
    expect(r.error).toBeUndefined();
    expect(calls.orgDisable).toHaveBeenCalledWith({ orgId: 'demo' }, { config: '/tmp/x.json', login: true });
  });

  it('location assign with a valid prefix', async () => {
    const { h, calls } = makeHandlers();
    const r = await run(buildProgram(h), [
      'location',
      'assign',
      '--org',
      'KU-lab',
      '--bucket',
      'genome-portal-data-111111111111-ap-northeast-2',
      '--prefix',
      'projects/P2026-0412/',
    ]);
    expect(r.error).toBeUndefined();
    expect(calls.locationAssign).toHaveBeenCalledWith(
      {
        orgId: 'KU-lab',
        bucket: 'genome-portal-data-111111111111-ap-northeast-2',
        prefix: 'projects/P2026-0412/',
      },
      expect.anything(),
    );
  });

  it('location assign rejects a prefix without trailing slash or with ".."', async () => {
    const { h, calls } = makeHandlers();
    const p = buildProgram(h);
    const r1 = await run(p, [
      'location',
      'assign',
      '--org',
      'a',
      '--bucket',
      'bucket-1',
      '--prefix',
      'projects/P1',
    ]);
    expect(r1.error).toMatch(/prefix/);
    const r2 = await run(buildProgram(h), [
      'location',
      'assign',
      '--org',
      'a',
      '--bucket',
      'bucket-1',
      '--prefix',
      'projects/../P1/',
    ]);
    expect(r2.error).toMatch(/prefix/);
    expect(calls.locationAssign).not.toHaveBeenCalled();
  });

  it('location unassign --all routes to unassignAll and refuses extra selectors', async () => {
    const { h, calls } = makeHandlers();
    const r = await run(buildProgram(h), ['location', 'unassign', '--all', '--yes']);
    expect(r.error).toBeUndefined();
    expect(calls.locationUnassignAll).toHaveBeenCalledWith({ yes: true }, expect.anything());

    const r2 = await run(buildProgram(h), ['location', 'unassign', '--all', '--org', 'x']);
    expect(r2.error).toMatch(/cannot be combined/);
  });

  it('location unassign without --all needs org/bucket/prefix', async () => {
    const { h, calls } = makeHandlers();
    const r = await run(buildProgram(h), ['location', 'unassign', '--org', 'x']);
    expect(r.error).toMatch(/--org, --bucket and --prefix/);
    const ok = await run(buildProgram(h), [
      'location',
      'unassign',
      '--org',
      'x',
      '--bucket',
      'bucket-1',
      '--prefix',
      'p/',
    ]);
    expect(ok.error).toBeUndefined();
    expect(calls.locationUnassign).toHaveBeenCalledWith(
      { orgId: 'x', bucket: 'bucket-1', prefix: 'p/' },
      expect.anything(),
    );
  });

  it('location list with and without --org', async () => {
    const { h, calls } = makeHandlers();
    await run(buildProgram(h), ['location', 'list']);
    await run(buildProgram(h), ['location', 'list', '--org', 'KU-lab']);
    expect(calls.locationList).toHaveBeenNthCalledWith(1, {}, expect.anything());
    expect(calls.locationList).toHaveBeenNthCalledWith(2, { orgId: 'KU-lab' }, expect.anything());
  });

  it('user create validates --lang choices and lower-cases the e-mail', async () => {
    const { h, calls } = makeHandlers();
    const ok = await run(buildProgram(h), [
      'user',
      'create',
      '--email',
      'Lee@KU.example',
      '--org',
      'KU-lab',
      '--lang',
      'en',
    ]);
    expect(ok.error).toBeUndefined();
    expect(calls.userCreate).toHaveBeenCalledWith(
      { email: 'lee@ku.example', orgId: 'KU-lab', lang: 'en' },
      expect.anything(),
    );
    const bad = await run(buildProgram(h), [
      'user',
      'create',
      '--email',
      'lee@ku.example',
      '--org',
      'KU-lab',
      '--lang',
      'fr',
    ]);
    expect(bad.error).toMatch(/lang/);
  });

  it('user disable/enable/delete', async () => {
    const { h, calls } = makeHandlers();
    await run(buildProgram(h), ['user', 'disable', '--email', 'a@b.co']);
    await run(buildProgram(h), ['user', 'enable', '--email', 'a@b.co']);
    await run(buildProgram(h), ['user', 'delete', '--email', 'a@b.co']);
    expect(calls.userDisable).toHaveBeenCalledWith({ email: 'a@b.co' }, expect.anything());
    expect(calls.userEnable).toHaveBeenCalledWith({ email: 'a@b.co' }, expect.anything());
    expect(calls.userDelete).toHaveBeenCalledWith({ email: 'a@b.co' }, expect.anything());
  });

  it('count reset', async () => {
    const { h, calls } = makeHandlers();
    const r = await run(buildProgram(h), [
      'count',
      'reset',
      '--bucket',
      'bucket-1',
      '--key',
      'projects/P1/sample01.g.vcf.gz',
    ]);
    expect(r.error).toBeUndefined();
    expect(calls.countReset).toHaveBeenCalledWith(
      { bucket: 'bucket-1', key: 'projects/P1/sample01.g.vcf.gz' },
      expect.anything(),
    );
    const bad = await run(buildProgram(h), [
      'count',
      'reset',
      '--bucket',
      'bucket-1',
      '--key',
      'projects/P1/',
    ]);
    expect(bad.error).toMatch(/key/);
  });

  it('audit export validates dates', async () => {
    const { h, calls } = makeHandlers();
    const ok = await run(buildProgram(h), [
      'audit',
      'export',
      '--from',
      '2026-10-01',
      '--to',
      '2026-10-31',
      '--out',
      'audit.csv',
    ]);
    expect(ok.error).toBeUndefined();
    expect(calls.auditExport).toHaveBeenCalledWith(
      { from: '2026-10-01', to: '2026-10-31', out: 'audit.csv' },
      expect.anything(),
    );
    const bad = await run(buildProgram(h), [
      'audit',
      'export',
      '--from',
      '2026-10-1',
      '--to',
      '2026-10-31',
      '--out',
      'x.csv',
    ]);
    expect(bad.error).toMatch(/YYYY-MM-DD/);
  });

  it('unknown command is an error', async () => {
    const { h } = makeHandlers();
    const r = await run(buildProgram(h), ['frobnicate']);
    expect(r.error).toMatch(/unknown command/i);
  });
});

describe('argument parsers', () => {
  it('parsePrefix accepts nested prefixes and rejects "*"', () => {
    expect(parsePrefix('projects/P1/sub/')).toBe('projects/P1/sub/');
    expect(() => parsePrefix('projects/*/')).toThrow();
    expect(() => parsePrefix('projects//P1/')).toThrow();
    expect(() => parsePrefix('/')).toThrow();
  });
  it('parseOrgId rejects spaces and leading punctuation', () => {
    expect(parseOrgId('KU-lab.2026')).toBe('KU-lab.2026');
    expect(() => parseOrgId('KU lab')).toThrow();
    expect(() => parseOrgId('-x')).toThrow();
  });
  it('parseEmail normalises case', () => {
    expect(parseEmail('A@B.CO')).toBe('a@b.co');
    expect(() => parseEmail('nope')).toThrow();
  });
});
