import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/** The neutral default logo the SPA ships (`web/public/brand/logo.svg`), served when no `logoFile` is configured. */
export const DEFAULT_LOGO_URL = '/brand/logo.svg';

const brandSchema = z.object({
  name: z.string().min(1),
  /**
   * URL the SPA renders in the header. A site-relative path (`/brand/...`) is served from the static bucket:
   * either the SPA's default logo (`/brand/logo.svg`) or the file given in `logoFile`. An absolute `https://` URL
   * is used as-is (provider-hosted image).
   */
  logoUrl: z.string().min(1),
  /**
   * Provider logo image to upload to the static bucket at `logoUrl` on every deploy (svg/png/webp/jpg). Path
   * relative to `infra/config/` (or absolute). Keeps the customer's logo out of the source tree (R1.7, N7).
   */
  logoFile: z.string().min(1).optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

/**
 * CloudFront flat-rate plan tiers the cdn stack can subscribe the data distribution to (T1.6b, N4). FREE is not
 * offered: 100 GB/month allowance, no access logs, three per account — unusable for genome delivery.
 */
export const FLAT_RATE_TIERS = ['PRO', 'BUSINESS', 'PREMIUM'] as const;
/** Premium usage levels (`DEFAULT` = 50 TB; L2..L7 raise the allowance and the price). Only valid with PREMIUM. */
export const PREMIUM_USAGE_LEVELS = [
  'DEFAULT',
  'CF_PREMIUM_L2',
  'CF_PREMIUM_L3',
  'CF_PREMIUM_L4',
  'CF_PREMIUM_L5',
  'CF_PREMIUM_L6',
  'CF_PREMIUM_L7',
] as const;

const flatRatePlanSchema = z.object({
  tier: z.enum(FLAT_RATE_TIERS),
  usageLevel: z.enum(PREMIUM_USAGE_LEVELS).optional(),
});

export type FlatRatePlanConfig = z.infer<typeof flatRatePlanSchema>;

export const deployConfigSchema = z.object({
  /** 12-digit account. Optional: falls back to the deploying credentials (CDK_DEFAULT_ACCOUNT). */
  account: z
    .string()
    .regex(/^\d{12}$/)
    .optional(),
  region: z.string().default('ap-northeast-2'),
  /** Existing data bucket to import. Omit to create genome-portal-data-<account>-<region>. */
  dataBucketName: z.string().min(3).optional(),
  /** Existing S3 Access Grants instance (one per account+region). Omit to create. */
  accessGrantsInstanceArn: z.string().startsWith('arn:aws:s3:').optional(),
  /** Principals allowed to write to the data bucket (the provider's upload pipeline). */
  uploaderPrincipalArns: z.array(z.string().startsWith('arn:aws:iam::')).default([]),
  /**
   * Operator / break-glass principals exempt from the data bucket's "deny everyone else" statement
   * (design §2.5 "계정 관리자 역할"). The account root is always exempt. Empty = only root.
   */
  adminPrincipalArns: z.array(z.string().startsWith('arn:aws:iam::')).default([]),
  mfaMode: z.enum(['REQUIRED', 'OPTIONAL']).default('REQUIRED'),
  alertEmail: z.string().email(),
  /** Custom domain for the portal; data distribution uses data.<portalDomain>. Requires hostedZoneId. */
  portalDomain: z.string().min(3).optional(),
  hostedZoneId: z.string().min(1).optional(),
  /**
   * CloudFront flat-rate plan for the data distribution (T1.6b, N4): the cdn stack creates an
   * `AWS::PricingPlanManager::Subscription` for the distribution + its WAF Web ACL. Paid tiers are created in
   * `PENDING_APPROVAL` — nothing is billed and the plan is not applied until an operator approves it
   * (`ApprovePaidSubscription`, runbook §1). Omit for pay-as-you-go (no subscription resource).
   * Changing the tier here does NOT change an existing subscription: change it in the console/CLI first, then update
   * the config to match (CloudFormation rejects tier changes).
   */
  flatRatePlan: flatRatePlanSchema.optional(),
  brand: brandSchema,
});

export type DeployConfig = z.infer<typeof deployConfigSchema>;

export function loadConfig(envName: string, configDir = resolve(__dirname, '..', 'config')): DeployConfig {
  const file = resolve(configDir, `${envName}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read deployment config ${file}: ${(err as Error).message}`);
  }
  const parsed = deployConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid deployment config ${file}:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    );
  }
  if (parsed.data.portalDomain && !parsed.data.hostedZoneId) {
    throw new Error(`Invalid deployment config ${file}: hostedZoneId is required when portalDomain is set`);
  }
  const plan = parsed.data.flatRatePlan;
  if (plan?.usageLevel && plan.usageLevel !== 'DEFAULT' && plan.tier !== 'PREMIUM') {
    throw new Error(
      `Invalid deployment config ${file}: flatRatePlan.usageLevel ${plan.usageLevel} is only valid with tier PREMIUM (PRO/BUSINESS allowances are fixed)`,
    );
  }
  const brand = parsed.data.brand;
  if (brand.logoFile) {
    const logoFile = resolve(configDir, brand.logoFile);
    if (!existsSync(logoFile)) {
      throw new Error(`Invalid deployment config ${file}: brand.logoFile ${logoFile} does not exist`);
    }
    if (!brand.logoUrl.startsWith('/')) {
      throw new Error(
        `Invalid deployment config ${file}: brand.logoFile is uploaded to the static bucket at brand.logoUrl, so logoUrl must be a site-relative path such as /brand/logo.svg (got ${brand.logoUrl})`,
      );
    }
    brand.logoFile = logoFile;
  } else if (brand.logoUrl.startsWith('/') && brand.logoUrl !== DEFAULT_LOGO_URL) {
    // dev 2026-10-01: config.json pointed at /brand/logo.svg but nothing was ever deployed there -> broken image
    throw new Error(
      `Invalid deployment config ${file}: brand.logoUrl ${brand.logoUrl} points into the static bucket but no brand.logoFile is configured; only ${DEFAULT_LOGO_URL} (the SPA's default logo) is served without one`,
    );
  }
  return parsed.data;
}
