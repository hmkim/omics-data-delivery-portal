#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { buildPortalApp } from '../lib/app';
import { loadConfig } from '../lib/config';

const app = new App();
const envName = (app.node.tryGetContext('env') as string | undefined) ?? 'dev';
const cfg = loadConfig(envName);

// Account resolution: -c account=... (offline synth / CI) > config.account > the deploying credentials.
const account =
  (app.node.tryGetContext('account') as string | undefined) ?? cfg.account ?? process.env.CDK_DEFAULT_ACCOUNT;
if (!account) {
  throw new Error(
    `No account for env "${envName}": pass -c account=<12 digits>, set "account" in infra/config/${envName}.json, or run with AWS credentials so the CLI can resolve it`,
  );
}

// -c skipCdnPolicy=true: first-deployment fallback when CloudFront rejects a not-yet-existing origin bucket (README).
const skipCdnPolicyRaw = app.node.tryGetContext('skipCdnPolicy') as string | boolean | undefined;
const skipCdnPolicy = skipCdnPolicyRaw === true || String(skipCdnPolicyRaw).toLowerCase() === 'true';

buildPortalApp(app, { cfg, account, skipCdnPolicy });
