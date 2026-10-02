import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat, SourceMapMode } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

export interface PortalFunctionProps {
  functionName: string;
  entry: string;
  description: string;
  environment: Record<string, string>;
  timeout?: Duration;
  memorySize?: number;
  /** Explicit execution role (api stack roles); omitted = a dedicated role with Logs permissions only. */
  role?: iam.IRole;
  logRetention?: logs.RetentionDays;
}

/**
 * Every Lambda in the portal is built the same way (brief "핸들러 진입점 계약"): Node.js 22, arm64, esbuild,
 * SDK v3 left external (present in the runtime), minified with source maps. The log group is created here so its
 * retention is explicit and there is no runtime-created group for CloudFormation to collide with.
 */
export function portalNodejsFunction(
  scope: Construct,
  id: string,
  props: PortalFunctionProps,
): NodejsFunction {
  const logGroup = new logs.LogGroup(scope, `${id}Logs`, {
    logGroupName: `/aws/lambda/${props.functionName}`,
    retention: props.logRetention ?? logs.RetentionDays.ONE_YEAR,
    removalPolicy: RemovalPolicy.DESTROY,
  });
  // Dedicated role (no AWS managed policy): CloudWatch Logs on this function's own log group only.
  const role =
    props.role ??
    new iam.Role(scope, `${id}Role`, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `genome-portal: execution role of ${props.functionName}`,
      inlinePolicies: {
        logs: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'Logs',
              actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
              resources: [logGroup.logGroupArn],
            }),
          ],
        }),
      },
    });
  return new NodejsFunction(scope, id, {
    functionName: props.functionName,
    entry: props.entry,
    handler: 'handler',
    description: props.description,
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize: props.memorySize ?? 512,
    timeout: props.timeout ?? Duration.seconds(10),
    environment: {
      ...props.environment,
      NODE_OPTIONS: '--enable-source-maps',
    },
    role,
    logGroup,
    bundling: {
      minify: true,
      sourceMap: true,
      sourceMapMode: SourceMapMode.DEFAULT,
      sourcesContent: false,
      target: 'node22',
      format: OutputFormat.CJS,
      // default externalModules: the AWS SDK v3 shipped with the runtime is not bundled
    },
  });
}
