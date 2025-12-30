import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { EnvironmentConfig, envResourceName } from '../config/environments';
import { SESIdentityConstruct } from '../constructs/ses-identity';
import { SESConfigurationSetConstruct } from '../constructs/ses-configuration-set';
import { SESEventDestinationConstruct } from '../constructs/ses-event-destination';
import { StandardLambdaFunction } from '../constructs/lambda-function';

/**
 * Props for SESStack
 */
export interface SESStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;

  /** Route53 hosted zone for DNS record creation */
  readonly hostedZone: route53.IHostedZone;

  /** DynamoDB tables for SES event processing */
  readonly tables: {
    readonly subscribersTable: dynamodb.ITable;
    readonly auditEventsTable: dynamodb.ITable;
    readonly engagementEventsTable: dynamodb.ITable;
    readonly deliveriesTable: dynamodb.ITable;
  };
}

/**
 * SES Stack
 *
 * Creates AWS SES configuration for email sending.
 *
 * Components:
 * 1. SES Email Identity (email.ponton.io with DKIM, SPF, DMARC)
 * 2. SES Configuration Set (environment-scoped)
 * 3. Event Destination Pipeline (SNS → SQS → Lambda → DynamoDB)
 * 4. Lambda Event Processor (handles delivery, bounce, complaint, reject events)
 *
 * Event Flow:
 * SES → SNS Topic → SQS Queue → Lambda Handler → DynamoDB Tables
 *                              ↓ (on failure)
 *                            DLQ
 *
 * Security Architecture:
 * - DKIM: AWS Easy DKIM (2048-bit keys, automatic rotation)
 * - SPF: Hard fail policy (-all)
 * - DMARC: Monitoring mode (p=none), upgrade to p=quarantine/reject later
 * - SNS: Restricted to SES publisher only
 * - SQS: Encrypted with dedicated CMK
 * - Lambda: Least privilege IAM (NO ses:SendEmail permission)
 * - SNS message signature verification: Verified in Lambda before processing
 *
 * Per PLATFORM_INVARIANTS.md:
 * - SES sandbox mode in dev (verified recipients only)
 * - Production mode in prod (can send to any recipient)
 * - All resources environment-scoped
 * - Infrastructure wiring only (domain logic in ponton.io_email_service)
 *
 * DynamoDB Integration:
 * - Lambda updates Deliveries table (delivery status)
 * - Lambda updates Subscribers table (bounce/complaint handling)
 * - Lambda creates AuditEvents (state transitions)
 * - Lambda creates EngagementEvents (delivery, bounce, complaint)
 *
 * Stack Dependencies:
 * - Requires Certificate Stack (for Route53 hosted zone)
 * - Requires DynamoDB Stack (for table references)
 * - Independent of API Gateway Stack
 * - Independent of Secrets Stack
 */
export class SESStack extends cdk.Stack {
  /** SES email identity construct */
  public readonly identity: SESIdentityConstruct;

  /** SES configuration set construct */
  public readonly configurationSet: SESConfigurationSetConstruct;

  /** SES event destination construct */
  public readonly eventDestination: SESEventDestinationConstruct;

  /** Lambda function for processing SES events */
  public readonly eventHandler: StandardLambdaFunction;

  constructor(scope: Construct, id: string, props: SESStackProps) {
    super(scope, id, props);

    const { config, hostedZone, tables } = props;

    /**
     * SES Email Identity
     *
     * Creates verified domain identity for email.ponton.io with:
     * - DKIM signing (Easy DKIM with 2048-bit keys)
     * - SPF record (v=spf1 include:amazonses.com -all)
     * - DMARC record (p=none for monitoring)
     * - Mail FROM domain (bounce.email.ponton.io)
     */
    this.identity = new SESIdentityConstruct(this, 'Identity', {
      config,
      hostedZone,
    });

    /**
     * SES Configuration Set
     *
     * Environment-scoped configuration set for:
     * - Event publishing
     * - Sending metrics
     * - Reputation monitoring
     */
    this.configurationSet = new SESConfigurationSetConstruct(
      this,
      'ConfigurationSet',
      {
        config,
      }
    );

    /**
     * SES Event Destination Pipeline
     *
     * Creates SNS → SQS → Lambda pipeline for SES events:
     * - SNS topic (SES publishes here)
     * - SQS queue (buffers events)
     * - Dead Letter Queue (failed events)
     * - Dedicated KMS key (encryption)
     */
    this.eventDestination = new SESEventDestinationConstruct(
      this,
      'EventDestination',
      {
        config,
        configurationSet: this.configurationSet.configurationSet,
      }
    );

    /**
     * Lambda Event Handler
     *
     * Processes SES events from SQS queue and updates DynamoDB tables.
     *
     * Environment variables:
     * - DELIVERIES_TABLE: Deliveries table name
     * - SUBSCRIBERS_TABLE: Subscribers table name
     * - AUDIT_EVENTS_TABLE: AuditEvents table name
     * - ENGAGEMENT_EVENTS_TABLE: EngagementEvents table name
     *
     * IAM permissions:
     * - SQS: ReceiveMessage, DeleteMessage on event queue
     * - KMS: Decrypt on SES events key
     * - DynamoDB: UpdateItem on Deliveries, Subscribers tables
     * - DynamoDB: PutItem on AuditEvents, EngagementEvents tables
     *
     * CRITICAL: NO ses:SendEmail permission (least privilege)
     * Event processor should never send email, only record events.
     */
    this.eventHandler = new StandardLambdaFunction(this, 'EventHandler', {
      config,
      functionName: 'email-ses-event-processor',
      handlerFileName: 'ses-event-handler',
      description: 'Process SES events (delivery, bounce, complaint, reject)',
      memorySize: 256,
      timeout: 60, // SQS visibility timeout is 6x this (360s)
      environment: {
        DELIVERIES_TABLE: tables.deliveriesTable.tableName,
        SUBSCRIBERS_TABLE: tables.subscribersTable.tableName,
        AUDIT_EVENTS_TABLE: tables.auditEventsTable.tableName,
        ENGAGEMENT_EVENTS_TABLE: tables.engagementEventsTable.tableName,
      },
    });

    // Grant Lambda permission to receive and delete messages from SQS queue
    this.eventDestination.queue.grantConsumeMessages(this.eventHandler.function);

    // Grant Lambda permission to decrypt messages using KMS key
    this.eventDestination.encryptionKey.grantDecrypt(this.eventHandler.function);

    // Grant Lambda permission to update DynamoDB tables
    tables.deliveriesTable.grantReadWriteData(this.eventHandler.function);
    tables.subscribersTable.grantReadWriteData(this.eventHandler.function);
    tables.auditEventsTable.grantWriteData(this.eventHandler.function);
    tables.engagementEventsTable.grantWriteData(this.eventHandler.function);

    // Configure Lambda to process events from SQS queue
    // Event source mapping handles:
    // - Polling SQS queue
    // - Batching messages (up to 10 per invocation)
    // - Partial batch failure support (failed items returned to queue)
    // - Automatic retry on function errors
    this.eventHandler.function.addEventSourceMapping('SQSEventSource', {
      eventSourceArn: this.eventDestination.queue.queueArn,
      batchSize: 10, // Process up to 10 events per invocation
      maxBatchingWindow: cdk.Duration.seconds(5), // Wait up to 5s to fill batch
      reportBatchItemFailures: true, // Enable partial batch failure
    });

    /**
     * CloudFormation Outputs
     *
     * Export key resource identifiers for reference by other stacks
     * and for deployment verification.
     */
    new cdk.CfnOutput(this, 'EmailIdentityName', {
      value: config.ses.verifiedDomain,
      description: 'SES verified domain',
      exportName: envResourceName(config.env, 'SESEmailIdentityName'),
    });

    new cdk.CfnOutput(this, 'ConfigurationSetName', {
      value: this.configurationSet.configurationSet.configurationSetName,
      description: 'SES configuration set name',
      exportName: envResourceName(config.env, 'SESConfigurationSetName'),
    });

    new cdk.CfnOutput(this, 'EventTopicArn', {
      value: this.eventDestination.topic.topicArn,
      description: 'SNS topic ARN for SES events',
      exportName: envResourceName(config.env, 'SESEventTopicArn'),
    });

    new cdk.CfnOutput(this, 'EventQueueUrl', {
      value: this.eventDestination.queue.queueUrl,
      description: 'SQS queue URL for SES events',
      exportName: envResourceName(config.env, 'SESEventQueueUrl'),
    });

    new cdk.CfnOutput(this, 'EventQueueArn', {
      value: this.eventDestination.queue.queueArn,
      description: 'SQS queue ARN for SES events',
      exportName: envResourceName(config.env, 'SESEventQueueArn'),
    });

    new cdk.CfnOutput(this, 'DeadLetterQueueUrl', {
      value: this.eventDestination.deadLetterQueue.queueUrl,
      description: 'Dead letter queue URL for failed SES events',
      exportName: envResourceName(config.env, 'SESDeadLetterQueueUrl'),
    });

    new cdk.CfnOutput(this, 'EventHandlerFunctionName', {
      value: this.eventHandler.function.functionName,
      description: 'Lambda function name for SES event processing',
      exportName: envResourceName(config.env, 'SESEventHandlerFunctionName'),
    });

    new cdk.CfnOutput(this, 'EventHandlerFunctionArn', {
      value: this.eventHandler.function.functionArn,
      description: 'Lambda function ARN for SES event processing',
      exportName: envResourceName(config.env, 'SESEventHandlerFunctionArn'),
    });

    new cdk.CfnOutput(this, 'EncryptionKeyId', {
      value: this.eventDestination.encryptionKey.keyId,
      description: 'KMS key ID for SES event encryption',
      exportName: envResourceName(config.env, 'SESEventEncryptionKeyId'),
    });

    new cdk.CfnOutput(this, 'EncryptionKeyArn', {
      value: this.eventDestination.encryptionKey.keyArn,
      description: 'KMS key ARN for SES event encryption',
      exportName: envResourceName(config.env, 'SESEventEncryptionKeyArn'),
    });

    // Add tags
    cdk.Tags.of(this).add('Environment', config.env);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Project', 'email.ponton.io');
  }
}
