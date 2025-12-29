import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../config/environments';

/**
 * Props for SSMParametersConstruct
 */
export interface SSMParametersProps {
  /** Environment configuration */
  readonly config: EnvironmentConfig;
}

/**
 * SSM Parameters Construct
 *
 * Creates AWS Systems Manager (SSM) Parameter Store parameters for
 * non-secret configuration values.
 *
 * Parameters created:
 *
 * 1. SES Configuration:
 *    - /email/{env}/ses/verified-domain
 *    - /email/{env}/ses/from-email
 *    - /email/{env}/ses/from-name
 *
 * 2. API Configuration:
 *    - /email/{env}/api/base-url
 *
 * 3. Tracking Configuration:
 *    - /email/{env}/tracking/click-redirect-base-url
 *    - /email/{env}/tracking/open-pixel-base-url
 *
 * 4. Retention Configuration:
 *    - /email/{env}/retention/engagement-ttl-days
 *
 * Naming Convention:
 * - Environment-scoped: /email/{env}/category/parameter-name
 * - Dev: /email/dev/...
 * - Prod: /email/prod/...
 *
 * Per PLATFORM_INVARIANTS.md section 4:
 * - Non-secret configuration lives in SSM Parameter Store
 * - Distinct parameters per environment
 *
 * Security:
 * - All parameters use String type (not SecureString - these are not secrets)
 * - Tier: Standard (up to 4KB, no additional cost)
 * - RemovalPolicy.RETAIN for prod (prevent accidental configuration loss)
 * - RemovalPolicy.DESTROY for dev (development flexibility)
 *
 * Why SSM Parameter Store instead of environment variables?
 * - Centralized configuration management
 * - Can be updated without redeploying Lambda functions
 * - IAM-controlled access
 * - CloudTrail logging of parameter access
 * - Versioning and change history
 *
 * Domain Layer Usage:
 * The domain layer (ponton.io_email_service) retrieves these parameters
 * on Lambda cold start and caches them for the Lambda lifetime.
 *
 * Parameter Values:
 * These are placeholder values that match the current environment configuration.
 * They can be updated via AWS Console or CLI without infrastructure changes.
 */
export class SSMParametersConstruct extends Construct {
  /** SES verified domain (e.g., email.ponton.io) */
  public readonly sesVerifiedDomain: ssm.StringParameter;

  /** SES from email address (e.g., newsletter@email.ponton.io) */
  public readonly sesFromEmail: ssm.StringParameter;

  /** SES from display name (e.g., Ponton Newsletter) */
  public readonly sesFromName: ssm.StringParameter;

  /** API base URL for the environment */
  public readonly apiBaseUrl: ssm.StringParameter;

  /** Click tracking redirect base URL */
  public readonly clickRedirectBaseUrl: ssm.StringParameter;

  /** Open tracking pixel base URL */
  public readonly openPixelBaseUrl: ssm.StringParameter;

  /** Engagement events TTL in days (180 days = 6 months per platform invariants) */
  public readonly engagementTtlDays: ssm.StringParameter;

  constructor(scope: Construct, id: string, props: SSMParametersProps) {
    super(scope, id);

    const { config } = props;
    const removalPolicy = config.secrets.retainOnDelete
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY;

    /**
     * SES Configuration Parameters
     */

    // SES verified domain
    // Per platform invariants: email.ponton.io domain for both dev and prod
    // (SES sandbox mode controls dev behavior, not the domain)
    this.sesVerifiedDomain = new ssm.StringParameter(this, 'SesVerifiedDomain', {
      parameterName: `/email/${config.env}/ses/verified-domain`,
      stringValue: 'email.ponton.io',
      description: `SES verified domain for sending emails (${config.env})`,
      tier: ssm.ParameterTier.STANDARD,
    });
    this.sesVerifiedDomain.applyRemovalPolicy(removalPolicy);

    // SES from email address
    // Dev and prod can use different sender addresses if needed
    this.sesFromEmail = new ssm.StringParameter(this, 'SesFromEmail', {
      parameterName: `/email/${config.env}/ses/from-email`,
      stringValue:
        config.env === 'dev'
          ? 'newsletter-dev@email.ponton.io'
          : 'newsletter@email.ponton.io',
      description: `Default from email address for campaigns (${config.env})`,
      tier: ssm.ParameterTier.STANDARD,
    });
    this.sesFromEmail.applyRemovalPolicy(removalPolicy);

    // SES from display name
    this.sesFromName = new ssm.StringParameter(this, 'SesFromName', {
      parameterName: `/email/${config.env}/ses/from-name`,
      stringValue: config.env === 'dev' ? 'Ponton Newsletter (Dev)' : 'Ponton Newsletter',
      description: `Default from display name for campaigns (${config.env})`,
      tier: ssm.ParameterTier.STANDARD,
    });
    this.sesFromName.applyRemovalPolicy(removalPolicy);

    /**
     * API Configuration Parameters
     */

    // API base URL
    // Used by the domain layer for generating absolute URLs in emails
    this.apiBaseUrl = new ssm.StringParameter(this, 'ApiBaseUrl', {
      parameterName: `/email/${config.env}/api/base-url`,
      stringValue: `https://${config.apiDomain}`,
      description: `API base URL for generating links (${config.env})`,
      tier: ssm.ParameterTier.STANDARD,
    });
    this.apiBaseUrl.applyRemovalPolicy(removalPolicy);

    /**
     * Tracking Configuration Parameters
     */

    // Click tracking redirect base URL
    // Format: https://{apiDomain}/v1/track/click/{token}
    this.clickRedirectBaseUrl = new ssm.StringParameter(this, 'ClickRedirectBaseUrl', {
      parameterName: `/email/${config.env}/tracking/click-redirect-base-url`,
      stringValue: `https://${config.apiDomain}/v1/track/click`,
      description: `Base URL for click tracking links (${config.env})`,
      tier: ssm.ParameterTier.STANDARD,
    });
    this.clickRedirectBaseUrl.applyRemovalPolicy(removalPolicy);

    // Open tracking pixel base URL
    // Format: https://{apiDomain}/v1/track/open/{token}
    this.openPixelBaseUrl = new ssm.StringParameter(this, 'OpenPixelBaseUrl', {
      parameterName: `/email/${config.env}/tracking/open-pixel-base-url`,
      stringValue: `https://${config.apiDomain}/v1/track/open`,
      description: `Base URL for open tracking pixels (${config.env})`,
      tier: ssm.ParameterTier.STANDARD,
    });
    this.openPixelBaseUrl.applyRemovalPolicy(removalPolicy);

    /**
     * Retention Configuration Parameters
     */

    // Engagement events TTL in days
    // Per platform invariants section 11: Raw engagement events retained for 6 months (180 days)
    this.engagementTtlDays = new ssm.StringParameter(this, 'EngagementTtlDays', {
      parameterName: `/email/${config.env}/retention/engagement-ttl-days`,
      stringValue: '180',
      description: `Engagement events TTL in days (${config.env}) - 180 days = 6 months per platform invariants`,
      tier: ssm.ParameterTier.STANDARD,
    });
    this.engagementTtlDays.applyRemovalPolicy(removalPolicy);

    // Add tags to all parameters
    cdk.Tags.of(this).add('Environment', config.env);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Project', 'email.ponton.io');
  }
}
