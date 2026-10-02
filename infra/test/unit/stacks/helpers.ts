import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildPortalApp, type PortalAppOptions, type PortalStacks } from '../../../lib/app';
import type { DeployConfig } from '../../../lib/config';

export const TEST_ACCOUNT = '111111111111';

export const baseConfig: DeployConfig = {
  region: 'ap-northeast-2',
  uploaderPrincipalArns: [],
  adminPrincipalArns: [],
  mfaMode: 'REQUIRED',
  alertEmail: 'ops@example.com',
  brand: { name: 'Genome Data Portal', logoUrl: '/brand/logo.svg', primaryColor: '#0f6cbd' },
};

export interface BuiltApp {
  app: App;
  stacks: PortalStacks;
  templates: Record<keyof PortalStacks, Template>;
}

/** Feature flags exactly as `cdk synth` sees them (infra/cdk.json), so templates match the real synth. */
const cdkJsonContext = (
  JSON.parse(readFileSync(resolve(__dirname, '..', '..', '..', 'cdk.json'), 'utf8')) as {
    context: Record<string, unknown>;
  }
).context;

/** Builds the whole app once; Lambda bundling is skipped (no esbuild) to keep the suite fast. */
export function buildTestApp(
  cfgOverrides: Partial<DeployConfig> = {},
  opts: Partial<PortalAppOptions> = {},
): BuiltApp {
  const app = new App({
    context: { ...cdkJsonContext, 'aws:cdk:bundling-stacks': [] },
  });
  const cfg: DeployConfig = { ...baseConfig, ...cfgOverrides };
  const stacks = buildPortalApp(app, {
    cfg,
    account: TEST_ACCOUNT,
    nag: false,
    webDistDir: '/nonexistent/web/dist',
    ...opts,
  });
  const templates = Object.fromEntries(
    (Object.keys(stacks) as Array<keyof PortalStacks>).map((k) => [k, Template.fromStack(stacks[k])]),
  ) as Record<keyof PortalStacks, Template>;
  return { app, stacks, templates };
}

/** All IAM actions that appear in Allow statements of IAM roles / policies in a template. */
export function allowedIamActions(template: Template): Set<string> {
  const actions = new Set<string>();
  const collect = (doc: unknown) => {
    const statements =
      (doc as { Statement?: Array<{ Effect?: string; Action?: string | string[] }> } | undefined)
        ?.Statement ?? [];
    for (const st of statements) {
      if (st.Effect !== 'Allow' || !st.Action) continue;
      for (const a of Array.isArray(st.Action) ? st.Action : [st.Action]) actions.add(a);
    }
  };
  for (const res of Object.values(template.findResources('AWS::IAM::Policy')))
    collect(res.Properties?.PolicyDocument);
  for (const res of Object.values(template.findResources('AWS::IAM::Role'))) {
    for (const p of res.Properties?.Policies ?? []) collect(p.PolicyDocument);
  }
  return actions;
}
