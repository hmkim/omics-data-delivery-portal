import { Annotations, CfnResource, type IAspect, Tags, Token, type App } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import { PROJECT_TAG, RESOURCE_PREFIX } from './constants';

/** Tag every taggable resource in the app with Project=genome-portal (N7). */
export function applyProjectTag(app: App): void {
  Tags.of(app).add(PROJECT_TAG.key, PROJECT_TAG.value);
}

/**
 * CloudFormation properties that carry a physical resource name. Every one of them must start with
 * `genome-portal` (or `/genome-portal/` for SSM parameter names) so no customer name can leak into
 * an identifier (N7). Names left to CloudFormation (undefined / tokens) are fine.
 */
const NAME_PROPERTIES = [
  'BucketName',
  'TableName',
  'FunctionName',
  'RoleName',
  'PolicyName',
  'UserPoolName',
  'TopicName',
  'QueueName',
  'LogGroupName',
  'SecretName',
  'ParameterName',
  'DashboardName',
  'AlarmName',
  'WorkGroup',
  'DatabaseName',
  'StateMachineName',
  'Name',
] as const;

export class ResourcePrefixAspect implements IAspect {
  public visit(node: IConstruct): void {
    if (!(node instanceof CfnResource)) return;
    const props = (node as unknown as { _cfnProperties?: Record<string, unknown> })._cfnProperties;
    if (!props) return;
    for (const prop of NAME_PROPERTIES) {
      const value = props[prop];
      if (typeof value !== 'string' || Token.isUnresolved(value)) continue; // undefined or a token -> CloudFormation names it
      if (value.startsWith(RESOURCE_PREFIX) || value.startsWith(`/${RESOURCE_PREFIX}/`)) continue;
      if (
        prop === 'Name' &&
        !node.cfnResourceType.startsWith('AWS::WAFv2') &&
        !node.cfnResourceType.startsWith('AWS::Glue')
      ) {
        continue; // 'Name' is only a physical name for a few resource types
      }
      Annotations.of(node).addError(
        `${node.cfnResourceType}.${prop}="${value}" must start with "${RESOURCE_PREFIX}" (N7: no customer names in identifiers)`,
      );
    }
  }
}
