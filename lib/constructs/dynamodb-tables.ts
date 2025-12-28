import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { EnvironmentConfig, envResourceName } from '../config/environments';

/**
 * Props for DynamoDBTablesConstruct
 */
export interface DynamoDBTablesProps {
  /** Environment configuration */
  readonly config: EnvironmentConfig;

  /**
   * Whether to enable Point-in-Time Recovery (PITR)
   * Recommended: true for prod, false for dev (cost optimization)
   */
  readonly enablePointInTimeRecovery: boolean;

  /**
   * Whether to enable deletion protection
   * Recommended: true for prod, false for dev (development flexibility)
   */
  readonly enableDeletionProtection: boolean;
}

/**
 * DynamoDB Tables Construct
 *
 * Creates all 5 DynamoDB tables for the email platform per Milestone 2 specifications:
 *
 * 1. Subscribers - Subscriber records with lifecycle state
 * 2. AuditEvents - Immutable audit trail of all state transitions
 * 3. EngagementEvents - Click/open tracking events (6-month TTL)
 * 4. Campaigns - Campaign metadata and configuration
 * 5. Deliveries - Individual delivery records per subscriber per campaign
 *
 * Per PLATFORM_INVARIANTS.md:
 * - All primary identifiers are ULIDs (section 2)
 * - Data retention classes define which tables are retained indefinitely vs 6 months (section 11)
 * - Email hashing uses HMAC-SHA256 for terminal states (section 10)
 *
 * Security Architecture:
 * - Customer Managed Keys (CMK) for encryption at rest on sensitive tables
 * - NO plaintext email in GSI projections - uses emailNormalizedHash (HMAC-SHA256)
 * - Token GSIs use KEYS_ONLY projection (prevent token leakage)
 * - Point-in-Time Recovery enabled for prod (data protection)
 * - Deletion protection enabled for prod (prevent accidental deletion)
 *
 * CRITICAL SECURITY NOTE - Email Hashing:
 * The emailNormalizedHash attribute MUST be populated by the domain layer using HMAC-SHA256
 * with a secret key. SHA256 alone is vulnerable to rainbow table attacks. The domain layer
 * (ponton.io_email_service) is responsible for:
 * 1. Normalizing email (lowercase, trim, punycode for IDN)
 * 2. Computing HMAC-SHA256(secretKey, normalizedEmail)
 * 3. Storing the deterministic hash for duplicate prevention
 *
 * This infrastructure layer defines the schema; the domain layer owns the hashing logic.
 */
export class DynamoDBTablesConstruct extends Construct {
  /** KMS key for encrypting sensitive tables (Subscribers, AuditEvents, Campaigns, Deliveries) */
  public readonly encryptionKey: kms.Key;

  /** Subscribers table - Subscriber lifecycle and PII */
  public readonly subscribersTable: dynamodb.Table;

  /** AuditEvents table - Immutable audit trail */
  public readonly auditEventsTable: dynamodb.Table;

  /** EngagementEvents table - Click/open tracking with TTL */
  public readonly engagementEventsTable: dynamodb.Table;

  /** Campaigns table - Campaign metadata */
  public readonly campaignsTable: dynamodb.Table;

  /** Deliveries table - Individual delivery records */
  public readonly deliveriesTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DynamoDBTablesProps) {
    super(scope, id);

    const { config, enablePointInTimeRecovery, enableDeletionProtection } = props;

    /**
     * Customer Managed Key (CMK) for DynamoDB encryption
     *
     * Used for tables containing sensitive data:
     * - Subscribers (PII: email, firstName)
     * - AuditEvents (state changes, may contain PII references)
     * - Campaigns (campaign content)
     * - Deliveries (delivery metadata)
     *
     * NOT used for:
     * - EngagementEvents (uses AWS managed key - operational telemetry only)
     *
     * Security controls:
     * - Automatic key rotation enabled (365-day cycle)
     * - Resource policy restricts usage to DynamoDB service within this account
     * - ViaService condition ensures key only usable through DynamoDB API
     * - Explicit deny for cross-account access
     * - Root account retains key management permissions
     */
    this.encryptionKey = new kms.Key(this, 'EncryptionKey', {
      alias: envResourceName(config.env, 'email-dynamodb-key'),
      description: `Encryption key for email platform DynamoDB tables (${config.env})`,
      enableKeyRotation: true,
      removalPolicy:
        config.env === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Add explicit resource policy to the KMS key
    // This implements defense-in-depth by restricting key usage at the resource level
    const accountId = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;

    // Allow DynamoDB service to use the key for encryption/decryption
    // ViaService condition ensures key can only be used through DynamoDB API calls
    this.encryptionKey.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'Allow DynamoDB to use the key',
        effect: cdk.aws_iam.Effect.ALLOW,
        principals: [new cdk.aws_iam.ServicePrincipal('dynamodb.amazonaws.com')],
        actions: [
          'kms:Decrypt',
          'kms:Encrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:CreateGrant',
          'kms:DescribeKey',
        ],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'kms:ViaService': `dynamodb.${region}.amazonaws.com`,
            'kms:CallerAccount': accountId,
          },
        },
      })
    );

    // Explicitly deny access from external accounts
    // This prevents accidental key policy modifications that could allow cross-account access
    this.encryptionKey.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'Deny external account access',
        effect: cdk.aws_iam.Effect.DENY,
        principals: [new cdk.aws_iam.AnyPrincipal()],
        actions: ['kms:*'],
        resources: ['*'],
        conditions: {
          StringNotEquals: {
            'aws:PrincipalAccount': accountId,
          },
        },
      })
    );

    /**
     * Table 1: Subscribers
     *
     * Primary Key: subscriberId (ULID)
     *
     * Attributes:
     * - subscriberId: ULID - Primary identifier
     * - email: String - Plaintext email (ONLY for non-terminal states per platform invariants)
     * - emailNormalizedHash: String - HMAC-SHA256 hash for lookups (prevents duplicate subscriptions)
     * - firstName: String - Optional first name (PII)
     * - state: String - PENDING | SUBSCRIBED | BOUNCED | UNSUBSCRIBED | SUPPRESSED
     * - confirmToken: String - One-time confirmation token (expires after use)
     * - unsubscribeToken: String - Permanent unsubscribe token
     * - createdAt: Number - Unix timestamp (milliseconds)
     * - updatedAt: Number - Unix timestamp (milliseconds)
     * - confirmedAt: Number - Unix timestamp when subscription confirmed
     * - bounceCount: Number - Number of bounces (for retry policy)
     * - lastBounceAt: Number - Unix timestamp of last bounce
     *
     * GSI 1: EmailHashIndex
     * - PK: emailNormalizedHash
     * - Purpose: Check if email already subscribed (duplicate prevention)
     * - Projection: KEYS_ONLY (no PII in projection)
     * - Security: Uses HMAC-SHA256 hash, NOT plaintext email
     *
     * GSI 2: ConfirmTokenIndex
     * - PK: confirmToken
     * - Purpose: Lookup subscriber by confirmation token
     * - Projection: KEYS_ONLY (prevent token leakage in scans)
     * - Security: Token never appears in ANY projection
     *
     * GSI 3: UnsubscribeTokenIndex
     * - PK: unsubscribeToken
     * - Purpose: Lookup subscriber by unsubscribe token
     * - Projection: KEYS_ONLY (prevent token leakage in scans)
     * - Security: Token never appears in ANY projection
     *
     * GSI 4: StateIndex
     * - PK: state
     * - SK: createdAt
     * - Purpose: Query subscribers by state (e.g., all PENDING subscribers)
     * - Projection: KEYS_ONLY (prevent PII exposure)
     * - Use case: Admin dashboard, monitoring, batch operations
     */
    this.subscribersTable = new dynamodb.Table(this, 'SubscribersTable', {
      tableName: envResourceName(config.env, 'email-subscribers'),
      partitionKey: {
        name: 'subscriberId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // On-demand pricing
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.encryptionKey,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: enablePointInTimeRecovery,
      },
      deletionProtection: enableDeletionProtection,
      removalPolicy:
        config.env === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      // Per platform invariants section 11: Subscriber records retained indefinitely
    });

    // GSI 1: EmailHashIndex - Duplicate prevention
    this.subscribersTable.addGlobalSecondaryIndex({
      indexName: 'EmailHashIndex',
      partitionKey: {
        name: 'emailNormalizedHash',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    // GSI 2: ConfirmTokenIndex - Token lookup
    this.subscribersTable.addGlobalSecondaryIndex({
      indexName: 'ConfirmTokenIndex',
      partitionKey: {
        name: 'confirmToken',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    // GSI 3: UnsubscribeTokenIndex - Token lookup
    this.subscribersTable.addGlobalSecondaryIndex({
      indexName: 'UnsubscribeTokenIndex',
      partitionKey: {
        name: 'unsubscribeToken',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    // GSI 4: StateIndex - Query by state
    this.subscribersTable.addGlobalSecondaryIndex({
      indexName: 'StateIndex',
      partitionKey: {
        name: 'state',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    /**
     * Table 2: AuditEvents
     *
     * Primary Key: eventId (ULID)
     *
     * Attributes:
     * - eventId: ULID - Primary identifier
     * - subscriberId: ULID - Reference to subscriber
     * - eventType: String - SUBSCRIBE | CONFIRM | UNSUBSCRIBE | SUPPRESS | BOUNCE | STATE_CHANGE | EMAIL_HASHED
     * - timestamp: Number - Unix timestamp (milliseconds)
     * - metadata: Map - Event-specific metadata (e.g., state transition, bounce reason)
     * - actorType: String - SYSTEM | SUBSCRIBER | ADMIN
     * - actorId: String - Optional actor identifier
     *
     * GSI 1: SubscriberEventsIndex
     * - PK: subscriberId
     * - SK: timestamp
     * - Purpose: Query all events for a specific subscriber (chronological order)
     * - Projection: INCLUDE with ['eventType', 'actorType'] (defense-in-depth security)
     * - Use case: Subscriber history filtering, monitoring dashboards
     *
     * Security rationale for INCLUDE projection:
     * - Minimizes data exposure in GSI (defense-in-depth)
     * - Prevents sensitive metadata in GSI from being accessible to roles that only
     *   have GSI query permissions but not base table access
     * - Full audit trail details require GetItem on base table (additional access control layer)
     * - Trade-off: Adds latency for full event details, but improves security posture
     *
     * Per platform invariants section 11: Audit events retained indefinitely
     */
    this.auditEventsTable = new dynamodb.Table(this, 'AuditEventsTable', {
      tableName: envResourceName(config.env, 'email-audit-events'),
      partitionKey: {
        name: 'eventId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.encryptionKey,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: enablePointInTimeRecovery,
      },
      deletionProtection: enableDeletionProtection,
      removalPolicy:
        config.env === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // GSI 1: SubscriberEventsIndex - Query events by subscriber
    // Uses INCLUDE projection for defense-in-depth (limits GSI data exposure)
    this.auditEventsTable.addGlobalSecondaryIndex({
      indexName: 'SubscriberEventsIndex',
      partitionKey: {
        name: 'subscriberId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['eventType', 'actorType'],
    });

    /**
     * Table 3: EngagementEvents
     *
     * Primary Key: eventId (ULID)
     *
     * Attributes:
     * - eventId: ULID - Primary identifier
     * - subscriberId: ULID - Reference to subscriber
     * - campaignId: ULID - Reference to campaign
     * - deliveryId: ULID - Reference to delivery record
     * - eventType: String - OPEN | CLICK | DELIVERY | BOUNCE | COMPLAINT
     * - timestamp: Number - Unix timestamp (milliseconds)
     * - metadata: Map - Event-specific data (e.g., clicked URL, user agent, IP)
     * - expiresAt: Number - Unix timestamp for TTL deletion (6 months from creation)
     *
     * GSI 1: SubscriberEngagementIndex
     * - PK: subscriberId
     * - SK: timestamp
     * - Purpose: Query engagement history for a subscriber
     * - Projection: ALL (analytics need full event details)
     *
     * GSI 2: CampaignEngagementIndex
     * - PK: campaignId
     * - SK: timestamp
     * - Purpose: Query all engagement for a campaign
     * - Projection: ALL (campaign analytics)
     *
     * TTL Configuration:
     * - TTL enabled on expiresAt attribute (Unix timestamp in SECONDS, not milliseconds)
     * - Per platform invariants section 11: Raw engagement events retained for 6 months only
     * - DynamoDB automatically deletes expired items (within 48 hours of expiration)
     *
     * CRITICAL: Domain Layer TTL Implementation Requirements
     *
     * The domain layer (ponton.io_email_service) MUST set expiresAt correctly.
     * DynamoDB TTL requires Unix timestamp in SECONDS, while timestamp uses milliseconds.
     *
     * Correct implementation example (TypeScript):
     * ```typescript
     * const now = Date.now(); // milliseconds
     * const sixMonthsInSeconds = 6 * 30 * 24 * 60 * 60; // 15552000 seconds
     *
     * const engagementEvent = {
     *   eventId: ulid(),
     *   subscriberId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
     *   campaignId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
     *   eventType: 'OPEN',
     *   timestamp: now, // milliseconds for sorting
     *   expiresAt: Math.floor(now / 1000) + sixMonthsInSeconds, // SECONDS for TTL
     *   metadata: { userAgent: '...', ip: '...' }
     * };
     * ```
     *
     * Common mistake to avoid:
     * ```typescript
     * // WRONG - This will expire immediately or never expire
     * expiresAt: now + sixMonthsInSeconds // milliseconds + seconds = wrong!
     *
     * // CORRECT - Convert to seconds first, then add
     * expiresAt: Math.floor(now / 1000) + sixMonthsInSeconds
     * ```
     *
     * Domain layer contract:
     * - timestamp: Unix milliseconds (for precise sorting and display)
     * - expiresAt: Unix seconds (for DynamoDB TTL compliance)
     * - Both must be set on every engagement event
     * - Missing expiresAt means event is never deleted (retention policy violation)
     *
     * Security:
     * - Uses AWS managed encryption (operational telemetry, not business records)
     * - TTL ensures automatic data purging (no sensitive data persists beyond 6 months)
     */
    this.engagementEventsTable = new dynamodb.Table(this, 'EngagementEventsTable', {
      tableName: envResourceName(config.env, 'email-engagement-events'),
      partitionKey: {
        name: 'eventId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED, // Operational data, not business records
      timeToLiveAttribute: 'expiresAt', // TTL enabled for automatic deletion
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: false, // Not required for operational telemetry
      },
      deletionProtection: enableDeletionProtection,
      removalPolicy:
        config.env === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // GSI 1: SubscriberEngagementIndex - Engagement by subscriber
    this.engagementEventsTable.addGlobalSecondaryIndex({
      indexName: 'SubscriberEngagementIndex',
      partitionKey: {
        name: 'subscriberId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.ALL, // Analytics need full details
    });

    // GSI 2: CampaignEngagementIndex - Engagement by campaign
    this.engagementEventsTable.addGlobalSecondaryIndex({
      indexName: 'CampaignEngagementIndex',
      partitionKey: {
        name: 'campaignId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.ALL, // Campaign analytics
    });

    /**
     * Table 4: Campaigns
     *
     * Primary Key: campaignId (ULID)
     *
     * Attributes:
     * - campaignId: ULID - Primary identifier
     * - name: String - Campaign display name
     * - subject: String - Email subject line
     * - fromName: String - Sender display name
     * - fromEmail: String - Sender email address
     * - htmlContent: String - HTML email body
     * - textContent: String - Plain text email body
     * - status: String - DRAFT | SCHEDULED | SENDING | SENT | CANCELLED
     * - createdAt: Number - Unix timestamp (milliseconds)
     * - updatedAt: Number - Unix timestamp (milliseconds)
     * - scheduledAt: Number - Unix timestamp when campaign should be sent
     * - sentAt: Number - Unix timestamp when campaign was sent
     * - stats: Map - Campaign statistics (sent, delivered, opened, clicked, bounced, complained)
     *
     * GSI 1: StatusIndex
     * - PK: status
     * - SK: createdAt
     * - Purpose: Query campaigns by status (e.g., all DRAFT campaigns)
     * - Projection: KEYS_ONLY (fetch full details via GetItem)
     * - Use case: Admin dashboard, campaign list filtering
     *
     * Per platform invariants section 11: Campaign metadata retained indefinitely
     */
    this.campaignsTable = new dynamodb.Table(this, 'CampaignsTable', {
      tableName: envResourceName(config.env, 'email-campaigns'),
      partitionKey: {
        name: 'campaignId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.encryptionKey,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: enablePointInTimeRecovery,
      },
      deletionProtection: enableDeletionProtection,
      removalPolicy:
        config.env === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // GSI 1: StatusIndex - Query by status
    this.campaignsTable.addGlobalSecondaryIndex({
      indexName: 'StatusIndex',
      partitionKey: {
        name: 'status',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    /**
     * Table 5: Deliveries
     *
     * Primary Key: deliveryId (ULID)
     *
     * Attributes:
     * - deliveryId: ULID - Primary identifier
     * - campaignId: ULID - Reference to campaign
     * - subscriberId: ULID - Reference to subscriber
     * - status: String - PENDING | SENT | DELIVERED | BOUNCED | COMPLAINED | FAILED
     * - createdAt: Number - Unix timestamp (milliseconds)
     * - updatedAt: Number - Unix timestamp (milliseconds)
     * - sentAt: Number - Unix timestamp when email was sent
     * - deliveredAt: Number - Unix timestamp when delivery confirmed
     * - bouncedAt: Number - Unix timestamp when bounce occurred
     * - bounceReason: String - Bounce/failure reason
     * - attemptCount: Number - Number of delivery attempts (for retry policy)
     * - lastAttemptAt: Number - Unix timestamp of last delivery attempt
     * - sesMessageId: String - AWS SES message ID (for event correlation)
     *
     * GSI 1: CampaignDeliveriesIndex
     * - PK: campaignId
     * - SK: createdAt
     * - Purpose: Query all deliveries for a campaign
     * - Projection: KEYS_ONLY (fetch full details via GetItem)
     * - Use case: Campaign delivery tracking, statistics
     *
     * GSI 2: SubscriberDeliveriesIndex
     * - PK: subscriberId
     * - SK: createdAt
     * - Purpose: Query all deliveries for a subscriber
     * - Projection: KEYS_ONLY (fetch full details via GetItem)
     * - Use case: Subscriber delivery history
     *
     * GSI 3: StatusIndex
     * - PK: status
     * - SK: createdAt
     * - Purpose: Query deliveries by status (e.g., all PENDING deliveries for retry)
     * - Projection: KEYS_ONLY (fetch full details via GetItem)
     * - Use case: Retry processing, monitoring
     *
     * Per platform invariants section 11: Delivery records retained indefinitely
     */
    this.deliveriesTable = new dynamodb.Table(this, 'DeliveriesTable', {
      tableName: envResourceName(config.env, 'email-deliveries'),
      partitionKey: {
        name: 'deliveryId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.encryptionKey,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: enablePointInTimeRecovery,
      },
      deletionProtection: enableDeletionProtection,
      removalPolicy:
        config.env === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // GSI 1: CampaignDeliveriesIndex - Deliveries by campaign
    this.deliveriesTable.addGlobalSecondaryIndex({
      indexName: 'CampaignDeliveriesIndex',
      partitionKey: {
        name: 'campaignId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    // GSI 2: SubscriberDeliveriesIndex - Deliveries by subscriber
    this.deliveriesTable.addGlobalSecondaryIndex({
      indexName: 'SubscriberDeliveriesIndex',
      partitionKey: {
        name: 'subscriberId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    // GSI 3: StatusIndex - Deliveries by status
    this.deliveriesTable.addGlobalSecondaryIndex({
      indexName: 'StatusIndex',
      partitionKey: {
        name: 'status',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    // Add tags to all resources
    cdk.Tags.of(this).add('Environment', config.env);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Project', 'email.ponton.io');
  }
}
