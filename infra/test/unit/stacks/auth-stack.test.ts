import { Match } from 'aws-cdk-lib/assertions';
import {
  ID_TOKEN_VALIDITY_MINUTES,
  REFRESH_TOKEN_VALIDITY_HOURS,
  TABLE_NAMES,
} from '@genome-portal/contract';
import { describe, expect, it } from 'vitest';
import { names } from '../../../lib/constants';
import { buildTestApp } from './helpers';

describe('auth stack (T1.1)', () => {
  const { templates } = buildTestApp();
  const t = templates.auth;

  it('app client: refresh token 24h, ID/access 60min, token revocation ON, no secret, PKCE code flow', () => {
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: names.userPoolClient,
      RefreshTokenValidity: REFRESH_TOKEN_VALIDITY_HOURS * 60,
      IdTokenValidity: ID_TOKEN_VALIDITY_MINUTES,
      AccessTokenValidity: ID_TOKEN_VALIDITY_MINUTES,
      TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'minutes' },
      EnableTokenRevocation: true,
      GenerateSecret: false,
      PreventUserExistenceErrors: 'ENABLED',
      AllowedOAuthFlows: ['code'],
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH']),
    });
  });

  it('user pool: email username, admin-only sign-up, strong password, TOTP MFA required, immutable custom:orgId', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: names.userPool,
      UsernameAttributes: ['email'],
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      MfaConfiguration: 'ON',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      Policies: {
        PasswordPolicy: Match.objectLike({
          MinimumLength: 12,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
        }),
      },
      Schema: Match.arrayWith([
        Match.objectLike({ Name: 'orgId', Mutable: false }),
        Match.objectLike({ Name: 'lang', Mutable: true }),
      ]),
      AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }] },
      LambdaConfig: { PostAuthentication: Match.anyValue() },
    });
    t.resourceCountIs('AWS::Cognito::UserPoolGroup', 1);
    t.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: names.adminsGroup });
  });

  it('mfaMode=OPTIONAL is honoured', () => {
    const optional = buildTestApp({ mfaMode: 'OPTIONAL' }).templates.auth;
    optional.hasResourceProperties('AWS::Cognito::UserPool', { MfaConfiguration: 'OPTIONAL' });
  });

  it('post-auth trigger may only PutItem into the audit table (ARN by name, no data-stack reference)', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: names.fn('post-auth'),
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
    });
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'dynamodb:PutItem',
            Resource: `arn:aws:dynamodb:ap-northeast-2:111111111111:table/${TABLE_NAMES.auditEvents}`,
          }),
        ]),
      }),
    });
    expect(JSON.stringify(t.toJSON())).not.toContain('Fn::ImportValue');
  });
});
