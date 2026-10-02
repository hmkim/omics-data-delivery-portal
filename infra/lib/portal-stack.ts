import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { DeployConfig } from './config';

export interface PortalStackProps extends StackProps {
  cfg: DeployConfig;
}

/** Base class for all portal stacks: keeps the config handy and the description uniform. */
export abstract class PortalStack extends Stack {
  protected readonly cfg: DeployConfig;

  constructor(scope: Construct, id: string, props: PortalStackProps, description: string) {
    super(scope, id, { ...props, description: `genome-portal: ${description}` });
    this.cfg = props.cfg;
  }
}
