import * as cdk from 'aws-cdk-lib';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { EnvironmentConfig, envResourceName } from '../config/environments';

/**
 * Props for SESEventDestinationConstruct
 */
export interface SESEventDestinationProps {
  /** Environment configuration */
  readonly config: EnvironmentConfig;

  /** SES configuration set to attach event destination to */
  readonly configurationSet: ses.ConfigurationSet;
}

/**
 * SES Event Destination Construct
 *
 * Creates the event processing pipeline for SES events:
 * 1. SNS Topic (SES publishes events here)
 * 2. SQS Queue (subscribes to SNS, buffers events for Lambda)
 * 3. Dead Letter Queue (DLQ) for failed event processing
 * 4. Dedicated KMS keys for SNS and SQS encryption
 * 5. SES Event Destination (configures which events to publish)
 *
 * Event Flow:
 * SES → SNS Topic → SQS Queue → Lambda Handler → DynamoDB
 *                              ↓ (on failure)
 *                            DLQ
 *
 * Security Architecture:
 * - SNS topic restricted to SES publisher only (resource policy)
 * - SNS and SQS CMK encryption in all environments
 * - SNS message signature verification performed in Lambda using SNS envelope
 * - Least privilege IAM: Lambda gets queue read/delete only
 *
 * Events Published:
 * - SEND: Email accepted by SES
 * - DELIVERY: Email delivered successfully
 * - BOUNCE: Email bounced (hard/soft)
 * - COMPLAINT: Recipient marked as spam
 * - REJECT: SES rejected email (invalid recipient, suppression, etc.)
 *
 * NOT published (not needed for MVP):
 * - OPEN: Requires tracking pixel (domain layer responsibility)
 * - CLICK: Requires link rewriting (domain layer responsibility)
 * - RENDERING_FAILURE: Not applicable (using simple HTML/text)
 *
 * Per PLATFORM_INVARIANTS.md:
 * - Environment-scoped naming for all resources
 * - Dedicated encryption keys (separate from DynamoDB)
 * - Least privilege IAM policies
 *
 * Retry and DLQ Strategy:
 * - SQS visibility timeout: 6x Lambda timeout (recommended by AWS)
 * - Max receive count: 3 attempts before moving to DLQ
 * - DLQ retention: 14 days (allows time to investigate failures)
 * - Main queue retention: 4 days (standard SQS retention)
 *
 * Cost Optimization:
 * - SQS standard queue (not FIFO) - events can be processed out of order
 * - No SNS message retention (SQS provides buffering)
 * - DLQ retention limited to 14 days (not indefinite)
 */
export class SESEventDestinationConstruct extends Construct {
  /** SNS topic for SES event publishing */
  public readonly topic: sns.Topic;

  /** SQS queue for event buffering */
  public readonly queue: sqs.Queue;

  /** Dead letter queue for failed events */
  public readonly deadLetterQueue: sqs.Queue;

  /** KMS encryption key for SQS */
  public readonly encryptionKey: kms.Key;

  /** KMS encryption key for SNS */
  public readonly topicEncryptionKey: kms.Key;

  constructor(scope: Construct, id: string, props: SESEventDestinationProps) {
    super(scope, id);

    const { config, configurationSet } = props;
    const accountId = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;

    /**
     * Dedicated KMS Key for SQS Event Encryption
     *
     * Separate from DynamoDB encryption key per security best practices:
     * - Least privilege: SQS Lambda processor doesn't need DynamoDB key access
     * - Blast radius reduction: Key compromise affects only SES events, not data
     * - Independent rotation: Can rotate SES event key without affecting DynamoDB
     *
     * Key policy:
     * - SQS service can use key to decrypt messages
     * - Lambda execution role can decrypt (added when Lambda is created)
     * - Root account retains key management permissions
     */
    this.encryptionKey = new kms.Key(this, 'EncryptionKey', {
      alias: `alias/${envResourceName(config.env, 'email-ses-events-key')}`,
      description: `Encryption key for SES event queues (${config.env})`,
      enableKeyRotation: true,
      removalPolicy:
        config.env === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Allow SQS to decrypt messages with this key
    this.encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowSQSToDecrypt',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('sqs.amazonaws.com')],
        actions: [
          'kms:Decrypt',
          'kms:GenerateDataKey',
        ],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'kms:ViaService': `sqs.${region}.amazonaws.com`,
            'kms:CallerAccount': accountId,
          },
        },
      })
    );

    /**
     * Dedicated KMS Key for SNS Event Encryption
     *
     * Separate from the SQS key to avoid dependency cycles with SNS → SQS subscriptions.
     */
    this.topicEncryptionKey = new kms.Key(this, 'TopicEncryptionKey', {
      alias: `alias/${envResourceName(config.env, 'email-ses-topic-key')}`,
      description: `Encryption key for SES event topic (${config.env})`,
      enableKeyRotation: true,
      removalPolicy:
        config.env === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Allow SNS to encrypt messages with this key
    this.topicEncryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowSNSToEncrypt',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('sns.amazonaws.com')],
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:DescribeKey',
        ],
        resources: ['*'],
        conditions: {
          StringEqualsIfExists: {
            'kms:ViaService': `sns.${region}.amazonaws.com`,
          },
        },
      })
    );
    this.topicEncryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowSNSToCreateGrant',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('sns.amazonaws.com')],
        actions: ['kms:CreateGrant'],
        resources: ['*'],
        conditions: {
          StringEqualsIfExists: {
            'kms:ViaService': `sns.${region}.amazonaws.com`,
          },
        },
      })
    );
    this.topicEncryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowSESToUseKey',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
        resources: ['*'],
        conditions: {
          StringEqualsIfExists: {
            'kms:ViaService': `sns.${region}.amazonaws.com`,
          },
        },
      })
    );

    /**
     * Dead Letter Queue (DLQ)
     *
     * Receives messages that failed processing after 3 attempts.
     *
     * Retention: 14 days
     * - Provides time to investigate failures
     * - Prevents indefinite storage of failed messages
     * - Aligns with operational telemetry retention (not business records)
     *
     * Encryption: Same KMS key as main queue
     * - Simplifies key management
     * - Failed messages contain same sensitive data as successful ones
     *
     * Monitoring:
     * - CloudWatch alarm should trigger on any DLQ messages (not implemented here)
     * - DLQ depth > 0 indicates processing failures requiring investigation
     */
    this.deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      queueName: envResourceName(config.env, 'email-ses-events-dlq'),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: this.encryptionKey,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy:
        config.env === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    /**
     * SQS Queue for SES Events
     *
     * Buffers events between SNS and Lambda for reliable processing.
     *
     * Why SQS between SNS and Lambda:
     * - Retry logic: Lambda failures automatically retry via SQS
     * - Rate limiting: Controls Lambda concurrency (batch size)
     * - Backpressure: Queue absorbs spikes in event volume
     * - DLQ support: Failed events moved to DLQ after retries
     *
     * Visibility timeout: 360 seconds (6x Lambda timeout of 60s)
     * - Recommended by AWS: 6x function timeout
     * - Prevents duplicate processing while Lambda is running
     * - Allows time for retries within same visibility window
     *
     * Max receive count: 3
     * - Event processed up to 3 times before moving to DLQ
     * - Balances retry attempts with DLQ escalation
     * - Prevents infinite retry loops on persistent failures
     *
     * Retention: 4 days (default SQS retention)
     * - Long enough to handle temporary Lambda outages
     * - Short enough to avoid indefinite event storage
     */
    this.queue = new sqs.Queue(this, 'Queue', {
      queueName: envResourceName(config.env, 'email-ses-events'),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: this.encryptionKey,
      visibilityTimeout: cdk.Duration.seconds(360), // 6x Lambda timeout
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3,
      },
      removalPolicy:
        config.env === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    /**
     * SNS Topic for SES Event Publishing
     *
     * SES publishes events to this topic, which fans out to SQS.
     *
     * Topic policy restrictions:
     * - Only SES service can publish
     * - Only from this AWS account
     * - If SourceArn is present, restrict to configuration set or identity
     *
     * Security rationale:
     * - Prevents unauthorized event injection
     * - Enforces single source of truth (SES only)
     * - Reduces attack surface for event poisoning
     *
     * Why SNS before SQS (instead of SES → SQS directly):
     * - SES natively supports SNS, not SQS
     * - SNS provides fan-out if multiple consumers needed later
     * - SNS handles SES event delivery retries
     * - Standard AWS pattern for SES event processing
     */
    this.topic = new sns.Topic(this, 'Topic', {
      topicName: envResourceName(config.env, 'email-ses-events'),
      displayName: `SES Events for email.ponton.io (${config.env})`,
      masterKey: this.topicEncryptionKey,
    });

    // Restrict SNS topic to SES publisher only
    const topicPolicyResult = this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowSESToPublish',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        actions: ['SNS:Publish'],
        resources: [this.topic.topicArn],
        conditions: {
          StringEqualsIfExists: {
            'aws:SourceAccount': accountId,
          },
          ArnLikeIfExists: {
            'aws:SourceArn': [
              `arn:aws:ses:${region}:${accountId}:configuration-set/${config.ses.configurationSetName}*`,
              `arn:aws:ses:${region}:${accountId}:identity/${config.ses.verifiedDomain}`,
            ],
          },
        },
      })
    );

    /**
     * Subscribe SQS queue to SNS topic
     *
     * SNS message signature verification:
     * - Lambda verifies SNS signatures using the SNS envelope
     * - Prevents tampering and event forgery
     * - Requires raw SNS envelope in SQS payload
     *
     * Raw message delivery: false (default)
     * - SNS wraps SES event in SNS envelope
     * - Provides SNS metadata (MessageId, Timestamp, Signature)
     * - Lambda extracts SES event from Message field
     * - Standard pattern for SNS → SQS → Lambda
     */
    this.topic.addSubscription(
      new subscriptions.SqsSubscription(this.queue, {
        rawMessageDelivery: false, // Keep SNS envelope for Lambda signature verification
      })
    );

    /**
     * SES Event Destination
     *
     * Configures SES to publish events to SNS topic.
     *
     * Events published:
     * - SEND: Email accepted by SES (useful for delivery tracking)
     * - DELIVERY: Email delivered to recipient's mail server
     * - BOUNCE: Email bounced (hard bounce or soft bounce)
     * - COMPLAINT: Recipient marked email as spam
     * - REJECT: SES rejected email (invalid recipient, suppression list)
     *
     * NOT published:
     * - OPEN: Requires tracking pixel (not needed for MVP)
     * - CLICK: Requires link rewriting (not needed for MVP)
     * - RENDERING_FAILURE: Not applicable (using simple HTML/text)
     *
     * Event destination naming:
     * - Single destination per configuration set (simple setup)
     * - Environment-scoped name for clarity
     */
    const eventDestination = new ses.CfnConfigurationSetEventDestination(this, 'EventDestination', {
      configurationSetName: configurationSet.configurationSetName,
      eventDestination: {
        name: envResourceName(config.env, 'email-ses-sns-destination'),
        enabled: true,
        matchingEventTypes: ['send', 'delivery', 'bounce', 'complaint', 'reject'],
        snsDestination: {
          topicArn: this.topic.topicArn,
        },
      },
    });
    if (topicPolicyResult.policyDependable) {
      eventDestination.node.addDependency(topicPolicyResult.policyDependable);
    }

    // Add tags to all resources
    cdk.Tags.of(this.encryptionKey).add('Environment', config.env);
    cdk.Tags.of(this.encryptionKey).add('ManagedBy', 'CDK');
    cdk.Tags.of(this.encryptionKey).add('Project', 'email.ponton.io');

    cdk.Tags.of(this.topicEncryptionKey).add('Environment', config.env);
    cdk.Tags.of(this.topicEncryptionKey).add('ManagedBy', 'CDK');
    cdk.Tags.of(this.topicEncryptionKey).add('Project', 'email.ponton.io');

    cdk.Tags.of(this.topic).add('Environment', config.env);
    cdk.Tags.of(this.topic).add('ManagedBy', 'CDK');
    cdk.Tags.of(this.topic).add('Project', 'email.ponton.io');

    cdk.Tags.of(this.queue).add('Environment', config.env);
    cdk.Tags.of(this.queue).add('ManagedBy', 'CDK');
    cdk.Tags.of(this.queue).add('Project', 'email.ponton.io');

    cdk.Tags.of(this.deadLetterQueue).add('Environment', config.env);
    cdk.Tags.of(this.deadLetterQueue).add('ManagedBy', 'CDK');
    cdk.Tags.of(this.deadLetterQueue).add('Project', 'email.ponton.io');
  }
}
