import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { EnvironmentConfig, envResourceName } from '../config/environments';
import { DynamoDBTablesConstruct } from '../constructs/dynamodb-tables';

/**
 * Props for DynamoDBStack
 */
export interface DynamoDBStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
}

/**
 * DynamoDB Stack
 *
 * Creates all DynamoDB tables and GSIs for the email platform.
 *
 * Tables created:
 * 1. Subscribers - Subscriber lifecycle and PII
 * 2. AuditEvents - Immutable audit trail
 * 3. EngagementEvents - Click/open tracking with 6-month TTL
 * 4. Campaigns - Campaign metadata
 * 5. Deliveries - Individual delivery records
 *
 * Security:
 * - Customer Managed Keys (CMK) for sensitive tables
 * - NO plaintext email in GSI projections
 * - Token GSIs use KEYS_ONLY projection
 * - Point-in-Time Recovery enabled for prod
 * - Deletion protection enabled for prod
 *
 * Per PLATFORM_INVARIANTS.md:
 * - All primary identifiers are ULIDs (section 2)
 * - Data retention classes enforced (section 11)
 * - Email hashing for terminal states (section 10)
 *
 * This is infrastructure wiring only - domain logic lives in ponton.io_email_service
 */
export class DynamoDBStack extends cdk.Stack {
  /** DynamoDB tables construct */
  public readonly tables: DynamoDBTablesConstruct;

  constructor(scope: Construct, id: string, props: DynamoDBStackProps) {
    super(scope, id, props);

    const { config } = props;

    // Create DynamoDB tables
    this.tables = new DynamoDBTablesConstruct(this, 'Tables', {
      config,
      // PITR and deletion protection configured per environment
      enablePointInTimeRecovery: config.dynamodb.enablePointInTimeRecovery,
      enableDeletionProtection: config.dynamodb.enableDeletionProtection,
    });

    // CloudFormation outputs for table names and ARNs
    new cdk.CfnOutput(this, 'SubscribersTableName', {
      value: this.tables.subscribersTable.tableName,
      description: 'Subscribers table name',
      exportName: envResourceName(config.env, 'SubscribersTableName'),
    });

    new cdk.CfnOutput(this, 'SubscribersTableArn', {
      value: this.tables.subscribersTable.tableArn,
      description: 'Subscribers table ARN',
      exportName: envResourceName(config.env, 'SubscribersTableArn'),
    });

    new cdk.CfnOutput(this, 'AuditEventsTableName', {
      value: this.tables.auditEventsTable.tableName,
      description: 'AuditEvents table name',
      exportName: envResourceName(config.env, 'AuditEventsTableName'),
    });

    new cdk.CfnOutput(this, 'AuditEventsTableArn', {
      value: this.tables.auditEventsTable.tableArn,
      description: 'AuditEvents table ARN',
      exportName: envResourceName(config.env, 'AuditEventsTableArn'),
    });

    new cdk.CfnOutput(this, 'EngagementEventsTableName', {
      value: this.tables.engagementEventsTable.tableName,
      description: 'EngagementEvents table name',
      exportName: envResourceName(config.env, 'EngagementEventsTableName'),
    });

    new cdk.CfnOutput(this, 'EngagementEventsTableArn', {
      value: this.tables.engagementEventsTable.tableArn,
      description: 'EngagementEvents table ARN',
      exportName: envResourceName(config.env, 'EngagementEventsTableArn'),
    });

    new cdk.CfnOutput(this, 'CampaignsTableName', {
      value: this.tables.campaignsTable.tableName,
      description: 'Campaigns table name',
      exportName: envResourceName(config.env, 'CampaignsTableName'),
    });

    new cdk.CfnOutput(this, 'CampaignsTableArn', {
      value: this.tables.campaignsTable.tableArn,
      description: 'Campaigns table ARN',
      exportName: envResourceName(config.env, 'CampaignsTableArn'),
    });

    new cdk.CfnOutput(this, 'DeliveriesTableName', {
      value: this.tables.deliveriesTable.tableName,
      description: 'Deliveries table name',
      exportName: envResourceName(config.env, 'DeliveriesTableName'),
    });

    new cdk.CfnOutput(this, 'DeliveriesTableArn', {
      value: this.tables.deliveriesTable.tableArn,
      description: 'Deliveries table ARN',
      exportName: envResourceName(config.env, 'DeliveriesTableArn'),
    });

    new cdk.CfnOutput(this, 'EncryptionKeyId', {
      value: this.tables.encryptionKey.keyId,
      description: 'KMS key ID for DynamoDB encryption',
      exportName: envResourceName(config.env, 'DynamoDBEncryptionKeyId'),
    });

    new cdk.CfnOutput(this, 'EncryptionKeyArn', {
      value: this.tables.encryptionKey.keyArn,
      description: 'KMS key ARN for DynamoDB encryption',
      exportName: envResourceName(config.env, 'DynamoDBEncryptionKeyArn'),
    });

    // Add tags
    cdk.Tags.of(this).add('Environment', config.env);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Project', 'email.ponton.io');
  }
}
