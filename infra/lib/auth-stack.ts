import { resolve } from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';
import {
  ID_TOKEN_VALIDITY_MINUTES,
  LAMBDA_ENV,
  LOCAL_DEV_ORIGIN,
  METRICS_NAMESPACE,
  REFRESH_TOKEN_VALIDITY_HOURS,
  TABLE_NAMES,
  names,
} from './constants';
import { portalNodejsFunction } from './lambda-defaults';
import { PortalStack, type PortalStackProps } from './portal-stack';

export const HANDLERS_DIR = resolve(__dirname, '..', 'lambda', 'handlers');

/**
 * T1.1 -- Cognito user pool, SPA app client, `admins` group and the post-authentication trigger (design §2.1).
 * The trigger writes LOGIN_SUCCESS audit events; the audit table lives in the data stack, so the permission
 * is granted on an ARN built from the table-name constant (referencing the construct would create a cycle).
 */
export class AuthStack extends PortalStack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly postAuthFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: PortalStackProps) {
    super(scope, id, props, 'Cognito user pool, app client and admins group (R1)');

    const auditTableArn = Stack.of(this).formatArn({
      service: 'dynamodb',
      resource: 'table',
      resourceName: TABLE_NAMES.auditEvents,
    });

    this.postAuthFunction = portalNodejsFunction(this, 'PostAuthFn', {
      functionName: names.fn('post-auth'),
      entry: resolve(HANDLERS_DIR, 'post-auth.ts'),
      description: 'genome-portal: Cognito post-authentication trigger (LOGIN_SUCCESS audit event)',
      timeout: Duration.seconds(10),
      environment: {
        [LAMBDA_ENV.AUDIT_TABLE]: TABLE_NAMES.auditEvents,
        [LAMBDA_ENV.ACCOUNT_ID]: this.account,
        [LAMBDA_ENV.REGION]: this.region,
        [LAMBDA_ENV.METRICS_NAMESPACE]: METRICS_NAMESPACE,
      },
    });
    this.postAuthFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AuditPut',
        actions: ['dynamodb:PutItem'],
        resources: [auditTableArn],
      }),
    );

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: names.userPool,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      customAttributes: {
        orgId: new cognito.StringAttribute({ minLen: 1, maxLen: 64, mutable: false }),
        lang: new cognito.StringAttribute({ minLen: 2, maxLen: 2, mutable: true }),
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(7),
      },
      mfa: this.cfg.mfaMode === 'REQUIRED' ? cognito.Mfa.REQUIRED : cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      lambdaTriggers: { postAuthentication: this.postAuthFunction },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.userPoolClient = this.userPool.addClient('SpaClient', {
      userPoolClientName: names.userPoolClient,
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        // The SPA signs in with SRP through the Amplify Authenticator; these URLs only matter for the hosted UI
        // (PKCE code flow) and are the portal origin when a custom domain is configured, plus the Vite dev server.
        callbackUrls: this.portalOrigins(),
        logoutUrls: this.portalOrigins(),
      },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      idTokenValidity: Duration.minutes(ID_TOKEN_VALIDITY_MINUTES),
      accessTokenValidity: Duration.minutes(ID_TOKEN_VALIDITY_MINUTES),
      refreshTokenValidity: Duration.hours(REFRESH_TOKEN_VALIDITY_HOURS),
    });

    new cognito.CfnUserPoolGroup(this, 'AdminsGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: names.adminsGroup,
      description: 'genome-portal administrators (admin API access)',
    });

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'ClientId', { value: this.userPoolClient.userPoolClientId });
    new CfnOutput(this, 'UserPoolArn', { value: this.userPool.userPoolArn });
  }

  private portalOrigins(): string[] {
    return this.cfg.portalDomain
      ? [`https://${this.cfg.portalDomain}`, LOCAL_DEV_ORIGIN]
      : [LOCAL_DEV_ORIGIN];
  }
}
