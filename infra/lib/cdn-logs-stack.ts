import { CfnOutput } from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { CF_LOG_FIELDS, names } from './constants';
import { PortalStack, type PortalStackProps } from './portal-stack';

export interface CdnLogsStackProps extends PortalStackProps {
  /** Data distribution ARN (cross-region reference from the cdn stack). */
  distributionArn: string;
  /** Log bucket ARN in the primary region (cross-region reference from the cdn stack). */
  logsBucketArn: string;
}

/**
 * CloudFront standard logging v2 (design §4.1, §7.1) -- deployed in us-east-1.
 *
 * CloudFront is a global service and CloudWatch Logs only accepts `ACCESS_LOGS` delivery sources for it in
 * US East (N. Virginia): "you must specify the US East (N. Virginia) Region (us-east-1), even if you want to
 * enable cross Region delivery to another destination" (CloudFront Developer Guide, standard logging v2).
 * The first Seoul deployment failed with "PutDeliverySource action is not supported for this LogType in
 * region ap-northeast-2", which is why these three resources live here while the S3 bucket, the Glue table
 * and the Athena queries stay in the primary region. The bucket policy in the cdn stack trusts delivery
 * sources from us-east-1 accordingly.
 */
export class CdnLogsStack extends PortalStack {
  public readonly deliveryArn: string;

  constructor(scope: Construct, id: string, props: CdnLogsStackProps) {
    super(scope, id, props, 'CloudFront standard logging v2 delivery (us-east-1) into the Seoul log bucket');

    const source = new logs.CfnDeliverySource(this, 'CfLogSource', {
      name: names.cfLogDeliverySource,
      logType: 'ACCESS_LOGS',
      resourceArn: props.distributionArn,
    });
    const destination = new logs.CfnDeliveryDestination(this, 'CfLogDestination', {
      name: names.cfLogDeliveryDestination,
      deliveryDestinationType: 'S3',
      destinationResourceArn: props.logsBucketArn,
      outputFormat: 'parquet',
    });
    const delivery = new logs.CfnDelivery(this, 'CfLogDelivery', {
      deliverySourceName: source.name,
      deliveryDestinationArn: destination.attrArn,
      recordFields: [...CF_LOG_FIELDS],
      s3EnableHiveCompatiblePath: false,
      s3SuffixPath: '{DistributionId}/{yyyy}/{MM}/{dd}/{HH}',
    });
    delivery.node.addDependency(source);
    delivery.node.addDependency(destination);
    this.deliveryArn = delivery.attrArn;

    new CfnOutput(this, 'DeliveryArn', { value: this.deliveryArn });
  }
}
