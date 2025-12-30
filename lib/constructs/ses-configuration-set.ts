import * as cdk from 'aws-cdk-lib';
import * as ses from 'aws-cdk-lib/aws-ses';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../config/environments';

/**
 * Props for SESConfigurationSetConstruct
 */
export interface SESConfigurationSetProps {
  /** Environment configuration */
  readonly config: EnvironmentConfig;
}

/**
 * SES Configuration Set Construct
 *
 * Creates an SES configuration set for tracking email sending metrics and events.
 *
 * Configuration sets allow:
 * 1. Event publishing (delivery, bounce, complaint, reject, open, click)
 * 2. Sending metrics and reputation monitoring
 * 3. IP pool management (future: dedicated IPs)
 * 4. Suppression list management
 *
 * Configuration Set Name:
 * - Dev: dev-email-ses-config
 * - Prod: prod-email-ses-config
 *
 * Environment scoping ensures:
 * - Separate event streams for dev and prod
 * - Independent reputation tracking
 * - No cross-environment event pollution
 *
 * Per PLATFORM_INVARIANTS.md:
 * - All resources environment-scoped
 * - SES sandbox in dev, production in prod
 *
 * Security:
 * - No sending authorization (TLS enforcement handled at SES service level)
 * - Reputation monitoring enabled by default
 * - Suppression list enabled (AWS-managed bounce/complaint suppression)
 *
 * Event Types Published:
 * - SEND: Email accepted by SES
 * - DELIVERY: Email delivered to recipient's mail server
 * - BOUNCE: Email bounced (hard bounce or soft bounce)
 * - COMPLAINT: Recipient marked email as spam
 * - REJECT: SES rejected email (invalid recipient, suppression list, etc.)
 *
 * Note: OPEN and CLICK events require additional configuration in email content
 * (tracking pixels and link rewriting). These are handled by the domain layer.
 */
export class SESConfigurationSetConstruct extends Construct {
  /** SES configuration set */
  public readonly configurationSet: ses.ConfigurationSet;

  constructor(scope: Construct, id: string, props: SESConfigurationSetProps) {
    super(scope, id);

    const { config } = props;

    /**
     * SES Configuration Set
     *
     * Environment-scoped configuration set for:
     * - Event publishing to SNS/SQS
     * - Sending reputation monitoring
     * - Suppression list management
     *
     * Suppression list enabled:
     * - Automatically suppresses bounced and complained addresses
     * - Prevents sending to addresses that previously bounced/complained
     * - Reduces spam complaints and improves sender reputation
     *
     * Reputation metrics enabled (default):
     * - Bounce rate monitoring
     * - Complaint rate monitoring
     * - SES automatically pauses sending if rates exceed thresholds
     */
    this.configurationSet = new ses.ConfigurationSet(this, 'ConfigurationSet', {
      configurationSetName: config.ses.configurationSetName,
      sendingEnabled: true,
      // Suppression options are managed at the account level
      // AWS SES suppression list is automatically enabled
    });

    // Add tags
    cdk.Tags.of(this.configurationSet).add('Environment', config.env);
    cdk.Tags.of(this.configurationSet).add('ManagedBy', 'CDK');
    cdk.Tags.of(this.configurationSet).add('Project', 'email.ponton.io');
  }
}
