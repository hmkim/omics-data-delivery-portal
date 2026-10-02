import { Match } from 'aws-cdk-lib/assertions';
import { API_BASE, LAMBDA_ENV, ORIGIN_VERIFY_HEADER, SECRET_NAMES } from '@genome-portal/contract';
import { describe, expect, it } from 'vitest';
import { names } from '../../../lib/constants';
import { allowedIamActions, buildTestApp } from './helpers';

describe('api stack (T1.8~T1.9)', () => {
  const { templates } = buildTestApp();
  const t = templates.api;
  const roles = t.findResources('AWS::IAM::Role');
  const policies = t.findResources('AWS::IAM::Policy');

  const policyFor = (roleLogicalId: string) =>
    Object.values(policies).filter((p) => JSON.stringify(p.Properties.Roles).includes(roleLogicalId));
  const roleId = (roleName: string) =>
    Object.entries(roles).find(([, r]) => r.Properties?.RoleName === roleName)![0];

  it('creates exactly the grantee / admin / read-only roles', () => {
    expect(
      Object.values(roles)
        .map((r) => r.Properties?.RoleName)
        .sort(),
    ).toEqual([names.adminRole, names.granteeRole, names.readOnlyRole].sort());
  });

  it('no role has any S3 object action (all data access goes through Access Grants)', () => {
    const actions = allowedIamActions(t);
    for (const a of actions) {
      expect(a).not.toMatch(/^s3:(GetObject|PutObject|DeleteObject|ListBucket)/);
      expect(a).not.toBe('s3:*');
    }
    expect(JSON.stringify(t.toJSON())).not.toMatch(/s3:(GetObject|PutObject)/);
  });

  it('grantee role: GetDataAccess on the instance ARN, signing key + origin-verify secrets, tables RW, SSM read', () => {
    const doc = JSON.stringify(policyFor(roleId(names.granteeRole)));
    expect(doc).toContain('s3:GetDataAccess');
    expect(doc).toContain('secretsmanager:GetSecretValue');
    expect(doc).toContain('dynamodb:PutItem');
    expect(doc).toContain('ssm:GetParameter');
    expect(doc).not.toContain('s3:CreateAccessGrant');
    expect(doc).not.toContain('cognito-idp');
  });

  it('admin role: grant lifecycle + Cognito Admin*, but NO s3:GetDataAccess', () => {
    const doc = JSON.stringify(policyFor(roleId(names.adminRole)));
    for (const a of [
      's3:CreateAccessGrant',
      's3:DeleteAccessGrant',
      's3:ListAccessGrants',
      's3:GetAccessGrant',
      'cognito-idp:Admin*',
    ]) {
      expect(doc).toContain(a);
    }
    expect(doc).not.toContain('s3:GetDataAccess');
    expect(doc).not.toContain(SECRET_NAMES.cfSigningKey);
  });

  it('read-only role: DynamoDB reads only, no writes, no Access Grants API', () => {
    const doc = JSON.stringify(policyFor(roleId(names.readOnlyRole)));
    expect(doc).toContain('dynamodb:Query');
    expect(doc).not.toContain('dynamodb:PutItem');
    expect(doc).not.toContain('dynamodb:UpdateItem');
    expect(doc).not.toContain('s3:GetDataAccess');
    expect(doc).not.toContain('s3:CreateAccessGrant');
  });

  it('origin-verify secret is generated (random, 64 hex-ish chars)', () => {
    t.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: SECRET_NAMES.originVerify,
      GenerateSecretString: Match.objectLike({ PasswordLength: 64, ExcludePunctuation: true }),
    });
  });

  it('six handlers: Node 22 / arm64 / 512MB, timeouts, role mapping, every LAMBDA_ENV key present', () => {
    const fns = Object.values(t.findResources('AWS::Lambda::Function'));
    expect(fns).toHaveLength(6);
    const byName = Object.fromEntries(fns.map((f) => [f.Properties.FunctionName as string, f]));
    const expectRole = (fn: string, role: string) =>
      expect(JSON.stringify(byName[names.fn(fn)]!.Properties.Role)).toContain(roleId(role));
    expectRole('locations', names.readOnlyRole);
    expectRole('object-status', names.readOnlyRole);
    expectRole('credentials', names.granteeRole);
    expectRole('downloads', names.granteeRole);
    expectRole('renew', names.granteeRole);
    expectRole('admin', names.adminRole);
    for (const f of fns) {
      expect(f.Properties.Runtime).toBe('nodejs22.x');
      expect(f.Properties.Architectures).toEqual(['arm64']);
      expect(f.Properties.MemorySize).toBe(512);
      const envKeys = Object.keys(f.Properties.Environment.Variables as Record<string, unknown>);
      for (const k of Object.values(LAMBDA_ENV)) expect(envKeys).toContain(k);
    }
    expect(byName[names.fn('downloads')]!.Properties.Timeout).toBe(15);
    expect(byName[names.fn('renew')]!.Properties.Timeout).toBe(15);
    expect(byName[names.fn('locations')]!.Properties.Timeout).toBe(10);
  });

  it('HTTP API: JWT authorizer on all six routes, throttle 100/200, access logs, CORS only for localhost:5173', () => {
    t.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
      JwtConfiguration: Match.objectLike({ Audience: Match.anyValue() }),
    });
    const routes = Object.values(t.findResources('AWS::ApiGatewayV2::Route'));
    const keys = routes.map((r) => r.Properties.RouteKey as string).sort();
    expect(keys).toEqual(
      [
        `GET ${API_BASE}/locations`,
        `POST ${API_BASE}/credentials`,
        `POST ${API_BASE}/downloads`,
        `POST ${API_BASE}/downloads/{id}/renew`,
        `POST ${API_BASE}/objects/status`,
        `POST ${API_BASE}/admin/{proxy+}`,
      ].sort(),
    );
    for (const r of routes) {
      expect(r.Properties.AuthorizationType).toBe('JWT');
      expect(r.Properties.AuthorizerId).toBeDefined();
    }
    t.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      DefaultRouteSettings: Match.objectLike({ ThrottlingRateLimit: 100, ThrottlingBurstLimit: 200 }),
      AccessLogSettings: Match.objectLike({ DestinationArn: Match.anyValue(), Format: Match.anyValue() }),
    });
    t.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowOrigins: ['http://localhost:5173'],
        AllowHeaders: Match.arrayWith([ORIGIN_VERIFY_HEADER]),
      }),
    });
  });
});
