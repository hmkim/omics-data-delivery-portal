import { resolve } from 'node:path';
import { ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import {
  API_BASE,
  LAMBDA_ENV,
  LOCAL_DEV_ORIGIN,
  METRICS_NAMESPACE,
  ORIGIN_VERIFY_HEADER,
  SECRET_NAMES,
  names,
  type SSM_PARAMS,
} from './constants';
import { portalNodejsFunction } from './lambda-defaults';
import { PortalStack, type PortalStackProps } from './portal-stack';

export interface ApiStackProps extends PortalStackProps {
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
  orgsTable: dynamodb.ITable;
  objectDownloadsTable: dynamodb.ITable;
  auditEventsTable: dynamodb.ITable;
  ssmParameters: Record<keyof typeof SSM_PARAMS, ssm.IStringParameter>;
  dataBucketName: string;
  accessGrantsInstanceArn: string;
  accessGrantsLocationId: string;
  /** Host name of the data distribution (data.<portalDomain> or *.cloudfront.net). */
  cfDomainName: string;
  /** CloudFront public key id = Key-Pair-Id of signed URLs. */
  cfKeyPairId: string;
  cfSigningKeySecretArn: string;
}

export type HandlerName = 'locations' | 'credentials' | 'downloads' | 'renew' | 'object-status' | 'admin';

const HANDLERS_DIR = resolve(__dirname, '..', 'lambda', 'handlers');

/**
 * T1.8~T1.9 -- IAM roles (grantee / admin / read-only), origin-verify secret, HTTP API + JWT authorizer,
 * six Lambda handlers (design §2.3, §6, §8). No role has any S3 object action: all S3 data access goes through
 * Access Grants credentials returned by GetDataAccess.
 */
export class ApiStack extends PortalStack {
  public readonly httpApi: apigwv2.HttpApi;
  public readonly apiEndpoint: string;
  public readonly originVerifySecret: secretsmanager.Secret;
  public readonly granteeRole: iam.Role;
  public readonly adminRole: iam.Role;
  public readonly readOnlyRole: iam.Role;
  public readonly functions: Record<HandlerName, lambda.Function>;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props, 'HTTP API, JWT authorizer, Lambda handlers, grantee/admin/read-only roles');

    // --- x-origin-verify secret (design §6): 32 random bytes, hex encoded
    this.originVerifySecret = new secretsmanager.Secret(this, 'OriginVerifySecret', {
      secretName: SECRET_NAMES.originVerify,
      description: 'genome-portal: value of the x-origin-verify header CloudFront adds on /api/* requests',
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
        excludeUppercase: true,
        includeSpace: false,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const signingKeySecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'SigningKeySecret',
      props.cfSigningKeySecretArn,
    );

    // --- roles (T1.8)
    const lambdaPrincipal = new iam.ServicePrincipal('lambda.amazonaws.com');
    const tables = [props.orgsTable, props.objectDownloadsTable, props.auditEventsTable];
    const ssmParams = Object.values(props.ssmParameters);

    const logsStatement = (fnNames: string[]) =>
      new iam.PolicyStatement({
        sid: 'Logs',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: fnNames.map((n) =>
          Stack.of(this).formatArn({
            service: 'logs',
            resource: 'log-group',
            resourceName: `/aws/lambda/${n}:*`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ),
      });
    const metricsStatement = new iam.PolicyStatement({
      sid: 'Metrics',
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': METRICS_NAMESPACE } },
    });
    const grantArnPattern = Stack.of(this).formatArn({
      service: 's3',
      resource: 'access-grants/default/grant',
      resourceName: '*',
    });

    this.granteeRole = new iam.Role(this, 'GranteeRole', {
      roleName: names.granteeRole,
      description:
        'genome-portal: Access Grants grantee (credentials/downloads/renew Lambdas). No S3 object actions.',
      assumedBy: lambdaPrincipal,
    });
    this.granteeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'GetDataAccess',
        actions: ['s3:GetDataAccess'],
        resources: [props.accessGrantsInstanceArn],
      }),
    );
    for (const t of tables) t.grantReadWriteData(this.granteeRole);
    for (const p of ssmParams) p.grantRead(this.granteeRole);
    signingKeySecret.grantRead(this.granteeRole);
    this.originVerifySecret.grantRead(this.granteeRole);
    this.granteeRole.addToPolicy(
      logsStatement([names.fn('credentials'), names.fn('downloads'), names.fn('renew')]),
    );
    this.granteeRole.addToPolicy(metricsStatement);

    this.adminRole = new iam.Role(this, 'AdminRole', {
      roleName: names.adminRole,
      description:
        'genome-portal: admin API (grant lifecycle, Cognito admin, DynamoDB). No s3:GetDataAccess.',
      assumedBy: lambdaPrincipal,
    });
    this.adminRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AccessGrantsLifecycle',
        actions: ['s3:CreateAccessGrant', 's3:DeleteAccessGrant', 's3:ListAccessGrants', 's3:GetAccessGrant'],
        resources: [props.accessGrantsInstanceArn, grantArnPattern],
      }),
    );
    this.adminRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CognitoAdmin',
        actions: ['cognito-idp:Admin*'],
        resources: [props.userPool.userPoolArn],
      }),
    );
    for (const t of tables) t.grantReadWriteData(this.adminRole);
    for (const p of ssmParams) p.grantRead(this.adminRole);
    this.originVerifySecret.grantRead(this.adminRole);
    this.adminRole.addToPolicy(logsStatement([names.fn('admin')]));
    this.adminRole.addToPolicy(metricsStatement);

    this.readOnlyRole = new iam.Role(this, 'ReadOnlyRole', {
      roleName: names.readOnlyRole,
      description: 'genome-portal: read-only API (locations, object status).',
      assumedBy: lambdaPrincipal,
    });
    for (const t of tables) t.grantReadData(this.readOnlyRole);
    for (const p of ssmParams) p.grantRead(this.readOnlyRole);
    this.originVerifySecret.grantRead(this.readOnlyRole);
    this.readOnlyRole.addToPolicy(logsStatement([names.fn('locations'), names.fn('object-status')]));
    this.readOnlyRole.addToPolicy(metricsStatement);

    // --- Lambda handlers (T1.9). Every function gets every LAMBDA_ENV key (contract).
    const environment: Record<string, string> = {
      [LAMBDA_ENV.ACCOUNT_ID]: this.account,
      [LAMBDA_ENV.REGION]: this.region,
      [LAMBDA_ENV.ORGS_TABLE]: props.orgsTable.tableName,
      [LAMBDA_ENV.DOWNLOADS_TABLE]: props.objectDownloadsTable.tableName,
      [LAMBDA_ENV.AUDIT_TABLE]: props.auditEventsTable.tableName,
      [LAMBDA_ENV.DATA_BUCKET]: props.dataBucketName,
      [LAMBDA_ENV.ACCESS_GRANTS_INSTANCE_ARN]: props.accessGrantsInstanceArn,
      [LAMBDA_ENV.ACCESS_GRANTS_LOCATION_ID]: props.accessGrantsLocationId,
      [LAMBDA_ENV.GRANTEE_ROLE_ARN]: this.granteeRole.roleArn,
      [LAMBDA_ENV.CF_DOMAIN]: props.cfDomainName,
      [LAMBDA_ENV.CF_KEY_PAIR_ID]: props.cfKeyPairId,
      [LAMBDA_ENV.CF_SIGNING_KEY_SECRET_ARN]: props.cfSigningKeySecretArn,
      [LAMBDA_ENV.ORIGIN_VERIFY_SECRET_ARN]: this.originVerifySecret.secretArn,
      [LAMBDA_ENV.USER_POOL_ID]: props.userPool.userPoolId,
      [LAMBDA_ENV.METRICS_NAMESPACE]: METRICS_NAMESPACE,
    };

    const mk = (name: HandlerName, role: iam.Role, timeoutSeconds: number, description: string) =>
      portalNodejsFunction(this, `Fn-${name}`, {
        functionName: names.fn(name),
        entry: resolve(HANDLERS_DIR, `${name}.ts`),
        description: `genome-portal: ${description}`,
        role,
        memorySize: 512,
        timeout: Duration.seconds(timeoutSeconds),
        environment,
      });

    this.functions = {
      locations: mk('locations', this.readOnlyRole, 10, 'GET /api/locations (Storage Browser listLocations)'),
      credentials: mk(
        'credentials',
        this.granteeRole,
        10,
        'POST /api/credentials (GetDataAccess prefix READ)',
      ),
      downloads: mk('downloads', this.granteeRole, 15, 'POST /api/downloads (path decision + signed URL)'),
      renew: mk('renew', this.granteeRole, 15, 'POST /api/downloads/{id}/renew (same-path re-issue)'),
      'object-status': mk(
        'object-status',
        this.readOnlyRole,
        10,
        'POST /api/objects/status (counts, next path)',
      ),
      admin: mk(
        'admin',
        this.adminRole,
        10,
        'POST /api/admin/* (orgs, locations, users, reset-count, audit-export)',
      ),
    };

    // --- HTTP API (T1.9)
    const authorizer = new HttpJwtAuthorizer(
      'CognitoJwt',
      `https://cognito-idp.${this.region}.amazonaws.com/${props.userPool.userPoolId}`,
      { jwtAudience: [props.userPoolClient.userPoolClientId], authorizerName: 'genome-portal-cognito-jwt' },
    );

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: names.httpApi,
      description: 'genome-portal API (called through the web distribution /api/* behaviour)',
      createDefaultStage: false,
      defaultAuthorizer: authorizer,
      corsPreflight: {
        allowOrigins: [LOCAL_DEV_ORIGIN],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['authorization', 'content-type', ORIGIN_VERIFY_HEADER],
        maxAge: Duration.hours(1),
      },
    });

    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: names.apiAccessLogGroup,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const stage = this.httpApi.addStage('DefaultStage', {
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: 100, burstLimit: 200 },
      detailedMetricsEnabled: true,
      accessLogSettings: {
        destination: new apigwv2.LogGroupLogDestination(accessLogs),
        format: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: false,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: false,
        }),
      },
    });

    const route = (path: string, methods: apigwv2.HttpMethod[], fn: lambda.Function, integrationId: string) =>
      this.httpApi.addRoutes({
        path,
        methods,
        authorizer,
        integration: new HttpLambdaIntegration(integrationId, fn, {
          payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
        }),
      });
    route(
      `${API_BASE}/locations`,
      [apigwv2.HttpMethod.GET],
      this.functions.locations,
      'LocationsIntegration',
    );
    route(
      `${API_BASE}/credentials`,
      [apigwv2.HttpMethod.POST],
      this.functions.credentials,
      'CredentialsIntegration',
    );
    route(
      `${API_BASE}/downloads`,
      [apigwv2.HttpMethod.POST],
      this.functions.downloads,
      'DownloadsIntegration',
    );
    route(
      `${API_BASE}/downloads/{id}/renew`,
      [apigwv2.HttpMethod.POST],
      this.functions.renew,
      'RenewIntegration',
    );
    route(
      `${API_BASE}/objects/status`,
      [apigwv2.HttpMethod.POST],
      this.functions['object-status'],
      'ObjectStatusIntegration',
    );
    route(`${API_BASE}/admin/{proxy+}`, [apigwv2.HttpMethod.POST], this.functions.admin, 'AdminIntegration');

    this.apiEndpoint = stage.url;

    new CfnOutput(this, 'ApiEndpoint', { value: this.apiEndpoint });
    new CfnOutput(this, 'ApiId', { value: this.httpApi.apiId });
    new CfnOutput(this, 'OriginVerifySecretArn', { value: this.originVerifySecret.secretArn });
    new CfnOutput(this, 'GranteeRoleArn', { value: this.granteeRole.roleArn });
    new CfnOutput(this, 'AdminRoleArn', { value: this.adminRole.roleArn });
  }
}
