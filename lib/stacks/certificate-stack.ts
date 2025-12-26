import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { EnvironmentConfig, envResourceName } from '../config/environments';

/**
 * Props for CertificateStack
 */
export interface CertificateStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
}

/**
 * ACM Certificate Stack for API Gateway custom domain
 *
 * Creates an SSL/TLS certificate for api.email.ponton.io in us-east-1
 * (required for API Gateway custom domains per AWS requirements).
 *
 * The certificate is validated via DNS using the existing Route53 hosted zone.
 *
 * SECURITY NOTE: Certificate validation happens automatically via Route53
 * DNS records. No manual intervention required.
 */
export class CertificateStack extends cdk.Stack {
  /** The ACM certificate for the API domain */
  public readonly certificate: acm.ICertificate;

  /** The Route53 hosted zone (imported) */
  public readonly hostedZone: route53.IHostedZone;

  constructor(scope: Construct, id: string, props: CertificateStackProps) {
    super(scope, id, props);

    const { config } = props;

    // Import the existing Route53 hosted zone for ponton.io
    // Per user requirement: "Route53: Zone already exists for ponton.io"
    this.hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: config.hostedZoneName,
    });

    // Create ACM certificate for api.email.ponton.io
    // Must be in us-east-1 for API Gateway custom domain
    this.certificate = new acm.Certificate(
      this,
      envResourceName(config.env, 'ApiCertificate'),
      {
        domainName: config.apiDomain,
        validation: acm.CertificateValidation.fromDns(this.hostedZone),
        certificateName: envResourceName(config.env, 'api-certificate'),
      }
    );

    // Export certificate ARN for cross-stack reference
    new cdk.CfnOutput(this, 'CertificateArn', {
      value: this.certificate.certificateArn,
      description: `ACM Certificate ARN for ${config.apiDomain}`,
      exportName: envResourceName(config.env, 'ApiCertificateArn'),
    });

    // Export hosted zone ID for use in API Gateway stack
    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: this.hostedZone.hostedZoneId,
      description: `Route53 Hosted Zone ID for ${config.hostedZoneName}`,
      exportName: envResourceName(config.env, 'HostedZoneId'),
    });

    // Add tags for environment tracking
    cdk.Tags.of(this).add('Environment', config.env);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Project', 'email.ponton.io');
  }
}
