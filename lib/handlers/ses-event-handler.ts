import { SQSEvent, SQSRecord, Context } from 'aws-lambda';
import * as crypto from 'crypto';
import * as https from 'https';
import { CloudWatch } from '@aws-sdk/client-cloudwatch';
import AWS from 'aws-sdk';
import { handleSesEvent } from '../../../ponton.io_email_service/dist/domain/ses.js';
import {
  sanitizeSESEvent,
  createLogContext,
} from '../utils/log-sanitization';

// Initialize CloudWatch client for custom metrics
const cloudwatch = new CloudWatch({});
const dynamo = new AWS.DynamoDB.DocumentClient();
const secretsManager = new AWS.SecretsManager();
const ssm = new AWS.SSM();

let cachedEmailHashSecret: string | null = null;
let cachedEngagementTtlDays: number | null = null;

/**
 * SES Event Handler
 *
 * Processes SES events (delivery, bounce, complaint, reject) from SQS queue.
 *
 * Event Flow:
 * SES → SNS → SQS → This Lambda → DynamoDB (Deliveries, AuditEvents, Subscribers)
 *
 * Per PLATFORM_INVARIANTS.md section 16:
 * - Infrastructure layer validates SNS signature before domain processing
 * - Domain layer (ponton.io_email_service) owns business logic
 * - This handler is infrastructure wiring only
 *
 * Security:
 * - SNS signature verification: Performed in this handler using SNS envelope
 * - No email addresses logged (PII protection)
 * - Least privilege IAM: No ses:SendEmail permission
 * - Partial batch failure support (SQS)
 *
 * Event Types Handled:
 * - SEND: Email accepted by SES
 * - DELIVERY: Email delivered successfully
 * - BOUNCE: Email bounced (hard/soft)
 * - COMPLAINT: Recipient marked as spam
 * - REJECT: SES rejected email (invalid recipient, suppression)
 *
 * Retry Strategy:
 * - SQS visibility timeout: 360 seconds (6x function timeout)
 * - Max receive count: 3 attempts before DLQ
 * - Partial batch failure: Failed records returned to queue for retry
 *
 * Environment Variables (injected by infrastructure):
 * - ENVIRONMENT: dev | prod
 * - REGION: AWS region
 * - LOG_LEVEL: DEBUG | INFO
 * - DELIVERIES_TABLE: DynamoDB Deliveries table name
 * - AUDIT_EVENTS_TABLE: DynamoDB AuditEvents table name
 * - SUBSCRIBERS_TABLE: DynamoDB Subscribers table name
 *
 * CloudWatch Logs:
 * - No email addresses logged (PII protection per Milestone 6)
 * - Log sanitization utility removes all PII fields
 * - Log delivery IDs, event types, timestamps only
 * - Log retention: 180 days per platform invariants
 *
 * CloudWatch Metrics:
 * - Custom metrics for SES events (delivered, bounced, complained, rejected)
 * - Namespace: email.ponton.io/{env}
 * - Dimensions: EventType
 * - Used for dashboard and alarms
 *
 * Infrastructure Wiring:
 * - Parses SNS envelope and extracts SES event
 * - Validates SNS signature before processing
 * - Calls domain layer (ponton.io_email_service) for DELIVERY/BOUNCE/COMPLAINT logic
 * - Updates DynamoDB tables (Deliveries, AuditEvents, Subscribers, EngagementEvents)
 * - Returns batch item failures for retry
 *
 * The domain layer owns:
 * - Bounce handling logic (update subscriber state)
 * - Complaint handling logic (suppress subscriber)
 * - Delivery tracking (recovery + audit/engagement)
 */

/**
 * SES event types from SNS
 */
interface SESEvent {
  eventType: 'Send' | 'Delivery' | 'Bounce' | 'Complaint' | 'Reject';
  mail: {
    timestamp: string;
    messageId: string;
    source: string;
    destination: string[];
    tags?: Record<string, string[]>;
  };
  delivery?: {
    timestamp: string;
    processingTimeMillis: number;
    recipients: string[];
    smtpResponse: string;
  };
  bounce?: {
    bounceType: 'Undetermined' | 'Permanent' | 'Transient';
    bounceSubType: string;
    bouncedRecipients: Array<{
      emailAddress: string;
      status?: string;
      diagnosticCode?: string;
    }>;
    timestamp: string;
  };
  complaint?: {
    complainedRecipients: Array<{
      emailAddress: string;
    }>;
    timestamp: string;
    complaintFeedbackType?: string;
  };
  reject?: {
    reason: string;
  };
}

/**
 * SNS message wrapper
 */
interface SNSMessage {
  Message: string; // JSON-encoded SES event
  MessageId: string;
  Signature: string; // SNS signature (verified here)
  SignatureVersion: string;
  SigningCertURL: string;
  Timestamp: string;
  TopicArn: string;
  Type: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
}

/**
 * Batch item failure format for SQS partial batch response
 */
interface BatchItemFailure {
  itemIdentifier: string; // SQS message ID
}

/**
 * Lambda response for SQS batch processing with partial failure support
 */
interface SQSBatchResponse {
  batchItemFailures: BatchItemFailure[];
}

type SubscriberState =
  | 'PENDING'
  | 'SUBSCRIBED'
  | 'BOUNCED'
  | 'UNSUBSCRIBED'
  | 'SUPPRESSED';

interface DomainTokenRecord {
  hash: string;
  issuedAt?: Date;
  expiresAt?: Date;
  usedAt?: Date | null;
  rotatedAt?: Date;
}

interface DomainSubscriberTokens {
  confirmation: DomainTokenRecord | null;
  subscriber: DomainTokenRecord;
}

interface DomainSubscriber {
  id: string;
  state: SubscriberState;
  email: string | null;
  emailNormalized: string | null;
  hashedEmail: string | null;
  bounceCount: number;
  lastBounceAt: Date | null;
  tokens: DomainSubscriberTokens;
  createdAt: Date;
  updatedAt: Date;
  confirmedAt: Date | null;
  unsubscribedAt: Date | null;
  suppressedAt: Date | null;
}

interface DomainAuditEvent {
  id: string;
  type: string;
  entityType: string;
  entityId: string;
  actorType: string;
  occurredAt: Date;
  details?: Record<string, string | number | boolean | null>;
}

interface DomainEngagementEvent {
  id: string;
  type: string;
  campaignId: string;
  deliveryId: string;
  occurredAt: Date;
}

type DeliveryStatus =
  | 'SENT'
  | 'DELIVERED'
  | 'BOUNCED'
  | 'COMPLAINED'
  | 'REJECTED';

/**
 * Process SES events from SQS queue
 *
 * @param event - SQS event with SES messages from SNS
 * @param context - Lambda context
 * @returns Batch item failures for retry
 */
export async function handler(
  event: SQSEvent,
  context: Context
): Promise<SQSBatchResponse> {
  const logLevel = process.env.LOG_LEVEL || 'INFO';
  const environment = process.env.ENVIRONMENT || 'dev';

  if (logLevel === 'DEBUG') {
    console.log(
      'SES Event Handler invoked',
      createLogContext(context.awsRequestId, {
        recordCount: event.Records.length,
      })
    );
  }

  const batchItemFailures: BatchItemFailure[] = [];

  // Process each SQS record (each contains an SNS message with SES event)
  for (const record of event.Records) {
    try {
      await processRecord(record, context);
    } catch (error) {
      // Log error without exposing PII (log sanitization applied)
      console.error(
        'Failed to process SES event',
        createLogContext(context.awsRequestId, {
          messageId: record.messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
        })
      );

      // Add to batch item failures for retry
      batchItemFailures.push({
        itemIdentifier: record.messageId,
      });
    }
  }

  if (batchItemFailures.length > 0) {
    console.warn(
      'Partial batch failure',
      createLogContext(context.awsRequestId, {
        failedCount: batchItemFailures.length,
        totalCount: event.Records.length,
      })
    );
  }

  // Return failed items for SQS retry
  // Successfully processed items are automatically deleted from queue
  return { batchItemFailures };
}

/**
 * Process a single SQS record containing SNS message with SES event
 *
 * @param record - SQS record
 * @param context - Lambda context
 */
async function processRecord(record: SQSRecord, context: Context): Promise<void> {
  const logLevel = process.env.LOG_LEVEL || 'INFO';
  const environment = process.env.ENVIRONMENT || 'dev';

  // Parse SNS message from SQS record body
  const snsMessage: SNSMessage = JSON.parse(record.body);

  // Verify SNS signature before trusting payload per PLATFORM_INVARIANTS.md
  await verifySnsSignature(snsMessage);

  // Parse SES event from SNS message
  const sesEvent: SESEvent = JSON.parse(snsMessage.Message);

  if (logLevel === 'DEBUG') {
    // Log sanitized event (NO email addresses per Milestone 6 security requirements)
    console.log(
      'Processing SES event',
      createLogContext(context.awsRequestId, {
        event: sanitizeSESEvent(sesEvent),
        snsMessageId: snsMessage.MessageId,
      })
    );
  }

  // Emit CloudWatch custom metric for event type
  await emitSESEventMetric(sesEvent.eventType, environment);

  switch (sesEvent.eventType) {
    case 'Send':
      await handleSend(sesEvent, context);
      break;
    case 'Delivery':
      await handleDelivery(sesEvent, context);
      break;
    case 'Bounce':
      await handleBounce(sesEvent, context);
      break;
    case 'Complaint':
      await handleComplaint(sesEvent, context);
      break;
    case 'Reject':
      await handleReject(sesEvent, context);
      break;
    default:
      console.warn(
        'Unknown SES event type',
        createLogContext(context.awsRequestId, {
          eventType: (sesEvent as any).eventType,
        })
      );
  }
}

/**
 * Handle SEND event (email accepted by SES)
 *
 * Updates Deliveries table: status = SENT, sentAt = timestamp.
 * No audit/engagement events are emitted here (domain layer handles delivery/bounce/complaint).
 */
async function handleSend(event: SESEvent, context: Context): Promise<void> {
  const logLevel = process.env.LOG_LEVEL || 'INFO';

  if (logLevel === 'DEBUG') {
    console.log(
      'Handling SEND event',
      createLogContext(context.awsRequestId, {
        event: sanitizeSESEvent(event),
      })
    );
  }

  const derived = await resolveDeliveryContext(event, context, false);
  if (!derived) {
    return;
  }

  await updateDeliveryRecord(derived, {
    status: 'SENT',
    sentAt: derived.eventTimestamp,
    sesMessageId: event.mail.messageId,
  });
}

/**
 * Handle DELIVERY event (email delivered successfully)
 *
 * - Calls domain layer to emit audit/engagement events and recover bounced subscribers.
 * - Updates Deliveries table: status = DELIVERED, deliveredAt = timestamp.
 */
async function handleDelivery(event: SESEvent, context: Context): Promise<void> {
  const logLevel = process.env.LOG_LEVEL || 'INFO';

  if (logLevel === 'DEBUG') {
    console.log(
      'Handling DELIVERY event',
      createLogContext(context.awsRequestId, {
        event: sanitizeSESEvent(event),
      })
    );
  }

  const derived = await resolveDeliveryContext(event, context, true);
  if (!derived) {
    return;
  }

  const domainResult = await applyDomainSesEvent(
    derived,
    {
      eventType: 'DELIVERY',
    },
    context
  );

  if (!domainResult) {
    return;
  }

  await updateDeliveryRecord(derived, {
    status: 'DELIVERED',
    deliveredAt: derived.eventTimestamp,
    sesMessageId: event.mail.messageId,
  });

  await persistDomainResult(derived, domainResult);
}

/**
 * Handle BOUNCE event (email bounced)
 *
 * - Calls domain layer to update subscriber state and emit audit/engagement events.
 * - Updates Deliveries table: status = BOUNCED, bouncedAt = timestamp, bounceReason.
 *
 * Per PLATFORM_INVARIANTS.md section 10:
 * - Hard bounce → BOUNCED state → email hashed and removed
 */
async function handleBounce(event: SESEvent, context: Context): Promise<void> {
  const logLevel = process.env.LOG_LEVEL || 'INFO';

  if (logLevel === 'DEBUG') {
    console.log(
      'Handling BOUNCE event',
      createLogContext(context.awsRequestId, {
        event: sanitizeSESEvent(event),
      })
    );
  }

  const bounceType = mapBounceType(event.bounce?.bounceType);
  if (!bounceType) {
    console.warn(
      'Unsupported bounce type',
      createLogContext(context.awsRequestId, {
        bounceType: event.bounce?.bounceType,
      })
    );
    return;
  }

  const derived = await resolveDeliveryContext(event, context, true);
  if (!derived) {
    return;
  }

  const attemptNumber = derived.attemptNumber;
  if (!attemptNumber) {
    console.warn(
      'Missing bounce attempt number',
      createLogContext(context.awsRequestId, {
        deliveryId: derived.deliveryId,
      })
    );
    return;
  }

  const domainResult = await applyDomainSesEvent(
    derived,
    {
      eventType: 'BOUNCE',
      bounceType,
      attemptNumber,
    },
    context
  );

  if (!domainResult) {
    return;
  }

  await updateDeliveryRecord(derived, {
    status: 'BOUNCED',
    bouncedAt: derived.eventTimestamp,
    bounceReason: event.bounce?.bounceSubType ?? event.bounce?.bounceType ?? 'UNKNOWN',
    attemptCount: attemptNumber,
    lastAttemptAt: derived.eventTimestamp,
    sesMessageId: event.mail.messageId,
  });

  await persistDomainResult(derived, domainResult);
}

/**
 * Handle COMPLAINT event (recipient marked as spam)
 *
 * - Calls domain layer to suppress subscriber and emit audit/engagement events.
 * - Updates Deliveries table: status = COMPLAINED.
 *
 * Per PLATFORM_INVARIANTS.md section 10:
 * - Complaint → SUPPRESSED state → email hashed and removed
 */
async function handleComplaint(event: SESEvent, context: Context): Promise<void> {
  const logLevel = process.env.LOG_LEVEL || 'INFO';

  if (logLevel === 'DEBUG') {
    console.log(
      'Handling COMPLAINT event',
      createLogContext(context.awsRequestId, {
        event: sanitizeSESEvent(event),
      })
    );
  }

  const derived = await resolveDeliveryContext(event, context, true);
  if (!derived) {
    return;
  }

  const domainResult = await applyDomainSesEvent(
    derived,
    {
      eventType: 'COMPLAINT',
    },
    context
  );

  if (!domainResult) {
    return;
  }

  await updateDeliveryRecord(derived, {
    status: 'COMPLAINED',
    complainedAt: derived.eventTimestamp,
    sesMessageId: event.mail.messageId,
  });

  await persistDomainResult(derived, domainResult);
}

/**
 * Handle REJECT event (SES rejected email)
 *
 * Updates Deliveries table: status = REJECTED, bounceReason = reject reason.
 */
async function handleReject(event: SESEvent, context: Context): Promise<void> {
  const logLevel = process.env.LOG_LEVEL || 'INFO';

  if (logLevel === 'DEBUG') {
    console.log(
      'Handling REJECT event',
      createLogContext(context.awsRequestId, {
        event: sanitizeSESEvent(event),
      })
    );
  }

  const derived = await resolveDeliveryContext(event, context, false);
  if (!derived) {
    return;
  }

  await updateDeliveryRecord(derived, {
    status: 'REJECTED',
    rejectedAt: derived.eventTimestamp,
    bounceReason: event.reject?.reason ?? 'UNKNOWN',
    sesMessageId: event.mail.messageId,
  });
}

/**
 * Emit CloudWatch custom metric for SES event
 *
 * Publishes custom metrics to CloudWatch for dashboard and alarms.
 * Metrics are namespaced by environment and dimensioned by event type.
 *
 * IMPORTANT: This function is async but fire-and-forget to avoid blocking
 * event processing. Metric emission failures are logged but don't fail the handler.
 *
 * SECURITY: Errors are monitored for potential quota exhaustion attacks.
 * If CloudWatch quota is exceeded, metrics will fail but events will still process.
 *
 * @param eventType - SES event type
 * @param environment - Environment name (dev/prod)
 */
async function emitSESEventMetric(eventType: string, environment: string): Promise<void> {
  // Fire and forget - don't block event processing
  cloudwatch
    .putMetricData({
      Namespace: `email.ponton.io/${environment}`,
      MetricData: [
        {
          MetricName: 'SESEvents',
          Value: 1,
          Unit: 'Count',
          Timestamp: new Date(),
          Dimensions: [
            {
              Name: 'EventType',
              Value: eventType,
            },
          ],
        },
      ],
    })
    .catch((error: unknown) => {
      // Log metric emission failure but don't throw
      // Event processing should not fail due to metric issues
      console.error('CloudWatch metric emission failed', {
        eventType,
        error: error instanceof Error ? error.message : 'Unknown error',
        // This error should be monitored - could indicate quota issues or API throttling
      });
    });
}

interface DeliveryContext {
  environment: string;
  deliveriesTable: string;
  subscribersTable: string;
  auditEventsTable: string;
  engagementEventsTable: string;
  deliveryId: string;
  campaignId: string;
  subscriberId: string;
  subscriberItem: Record<string, any>;
  subscriber: DomainSubscriber;
  attemptNumber?: number;
  eventTimestamp: number;
}

async function resolveDeliveryContext(
  event: SESEvent,
  context: Context,
  requireSubscriber: boolean
): Promise<DeliveryContext | null> {
  const environment = process.env.ENVIRONMENT || 'dev';
  const deliveriesTable = process.env.DELIVERIES_TABLE;
  const subscribersTable = process.env.SUBSCRIBERS_TABLE;
  const auditEventsTable = process.env.AUDIT_EVENTS_TABLE;
  const engagementEventsTable = process.env.ENGAGEMENT_EVENTS_TABLE;

  if (!deliveriesTable || !subscribersTable || !auditEventsTable || !engagementEventsTable) {
    console.error(
      'Missing DynamoDB table environment variables',
      createLogContext(context.awsRequestId, {
        deliveriesTable,
        subscribersTable,
        auditEventsTable,
        engagementEventsTable,
      })
    );
    return null;
  }

  const tags = event.mail.tags ?? {};
  const deliveryId = getTagValue(tags, ['deliveryId', 'delivery_id']);
  const campaignIdTag = getTagValue(tags, ['campaignId', 'campaign_id']);
  const subscriberIdTag = getTagValue(tags, ['subscriberId', 'subscriber_id']);
  const attemptTag = getTagValue(tags, ['attempt', 'attemptNumber', 'attempt_number']);
  const attemptNumber = attemptTag ? Number.parseInt(attemptTag, 10) : undefined;

  if (!deliveryId) {
    console.warn(
      'Missing deliveryId tag on SES event',
      createLogContext(context.awsRequestId, {
        messageId: event.mail.messageId,
      })
    );
    return null;
  }

  const deliveryItem = await getDeliveryItem(deliveriesTable, deliveryId);
  const campaignId = campaignIdTag ?? deliveryItem?.campaignId;
  const subscriberId = subscriberIdTag ?? deliveryItem?.subscriberId;
  const derivedAttemptNumber = attemptNumber ?? deliveryItem?.attemptCount;

  if (!campaignId || !subscriberId) {
    console.warn(
      'Missing campaignId or subscriberId for SES event',
      createLogContext(context.awsRequestId, {
        deliveryId,
        hasDeliveryRecord: Boolean(deliveryItem),
      })
    );
    return null;
  }

  const eventTimestamp = resolveEventTimestamp(event);

  if (!requireSubscriber) {
    const placeholderSubscriber: DomainSubscriber = {
      id: subscriberId,
      state: 'SUBSCRIBED',
      email: null,
      emailNormalized: null,
      hashedEmail: null,
      bounceCount: 0,
      lastBounceAt: null,
      tokens: {
        confirmation: null,
        subscriber: {
          hash: '',
          rotatedAt: new Date(0),
        },
      },
      createdAt: new Date(0),
      updatedAt: new Date(0),
      confirmedAt: null,
      unsubscribedAt: null,
      suppressedAt: null,
    };

    return {
      environment,
      deliveriesTable,
      subscribersTable,
      auditEventsTable,
      engagementEventsTable,
      deliveryId,
      campaignId,
      subscriberId,
      subscriberItem: {},
      subscriber: placeholderSubscriber,
      attemptNumber: derivedAttemptNumber,
      eventTimestamp,
    };
  }

  const subscriberItem = await getSubscriberItem(subscribersTable, subscriberId);
  if (!subscriberItem) {
    console.warn(
      'Subscriber record not found for SES event',
      createLogContext(context.awsRequestId, {
        subscriberId,
        deliveryId,
      })
    );
    return null;
  }

  const subscriber = parseSubscriberItem(subscriberItem);
  if (!subscriber) {
    console.warn(
      'Failed to parse subscriber record for SES event',
      createLogContext(context.awsRequestId, {
        subscriberId,
        deliveryId,
      })
    );
    return null;
  }

  return {
    environment,
    deliveriesTable,
    subscribersTable,
    auditEventsTable,
    engagementEventsTable,
    deliveryId,
    campaignId,
    subscriberId,
    subscriberItem,
    subscriber,
    attemptNumber: derivedAttemptNumber,
    eventTimestamp,
  };
}

async function applyDomainSesEvent(
  contextData: DeliveryContext,
  input: { eventType: 'DELIVERY' | 'BOUNCE' | 'COMPLAINT'; bounceType?: 'HARD' | 'SOFT'; attemptNumber?: number },
  context: Context
): Promise<{ subscriber: DomainSubscriber; auditEvents: DomainAuditEvent[]; engagementEvents: DomainEngagementEvent[]; logEntries: any[] } | null> {
  const emailHashSecret = await getEmailHashSecret(contextData.environment);

  const result = handleSesEvent({
    eventType: input.eventType,
    bounceType: input.bounceType,
    subscriber: contextData.subscriber,
    campaignId: contextData.campaignId,
    deliveryId: contextData.deliveryId,
    attemptNumber: input.attemptNumber,
    requestId: context.awsRequestId,
    emailHashHmacSecret: emailHashSecret,
  });

  if (!result || !result.ok) {
    const logEntries = result?.logEntries ?? [];
    for (const entry of logEntries) {
      console.warn('SES domain validation failed', entry);
    }
    return null;
  }

  for (const entry of result.logEntries ?? []) {
    console.log(JSON.stringify(entry));
  }

  return {
    subscriber: result.subscriber as DomainSubscriber,
    auditEvents: result.auditEvents as DomainAuditEvent[],
    engagementEvents: result.engagementEvents as DomainEngagementEvent[],
    logEntries: result.logEntries ?? [],
  };
}

async function persistDomainResult(
  contextData: DeliveryContext,
  result: { subscriber: DomainSubscriber; auditEvents: DomainAuditEvent[]; engagementEvents: DomainEngagementEvent[] }
): Promise<void> {
  const mergedSubscriber = mergeSubscriberItem(contextData.subscriberItem, result.subscriber);
  await putSubscriberItem(contextData.subscribersTable, mergedSubscriber);

  if (result.auditEvents.length > 0) {
    await putAuditEvents(
      contextData.auditEventsTable,
      result.auditEvents,
      contextData.subscriberId
    );
  }

  if (result.engagementEvents.length > 0) {
    const ttlDays = await getEngagementTtlDays(contextData.environment);
    await putEngagementEvents(
      contextData.engagementEventsTable,
      result.engagementEvents,
      contextData.subscriberId,
      ttlDays
    );
  }
}

function resolveEventTimestamp(event: SESEvent): number {
  const candidates = [
    event.delivery?.timestamp,
    event.bounce?.timestamp,
    event.complaint?.timestamp,
    event.mail.timestamp,
  ];

  for (const candidate of candidates) {
    if (candidate) {
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }

  return Date.now();
}

function getTagValue(tags: Record<string, string[]>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = tags[key];
    if (value && value.length > 0) {
      return value[0];
    }
  }
  return undefined;
}

function mapBounceType(bounceType: string | undefined): 'HARD' | 'SOFT' | null {
  if (!bounceType) {
    return null;
  }
  if (bounceType === 'Permanent') {
    return 'HARD';
  }
  if (bounceType === 'Transient' || bounceType === 'Undetermined') {
    return 'SOFT';
  }
  return null;
}

async function getDeliveryItem(
  tableName: string,
  deliveryId: string
): Promise<Record<string, any> | null> {
  const response = await dynamo
    .get({
      TableName: tableName,
      Key: { deliveryId },
    })
    .promise();

  return response.Item ?? null;
}

async function getSubscriberItem(
  tableName: string,
  subscriberId: string
): Promise<Record<string, any> | null> {
  const response = await dynamo
    .get({
      TableName: tableName,
      Key: { subscriberId },
    })
    .promise();

  return response.Item ?? null;
}

async function updateDeliveryRecord(
  contextData: DeliveryContext,
  fields: {
    status: DeliveryStatus;
    sesMessageId: string;
    sentAt?: number;
    deliveredAt?: number;
    bouncedAt?: number;
    complainedAt?: number;
    rejectedAt?: number;
    bounceReason?: string;
    attemptCount?: number;
    lastAttemptAt?: number;
  }
): Promise<void> {
  const updates: Record<string, any> = {
    status: fields.status,
    updatedAt: contextData.eventTimestamp,
    sesMessageId: fields.sesMessageId,
    campaignId: contextData.campaignId,
    subscriberId: contextData.subscriberId,
    sentAt: fields.sentAt,
    deliveredAt: fields.deliveredAt,
    bouncedAt: fields.bouncedAt,
    complainedAt: fields.complainedAt,
    rejectedAt: fields.rejectedAt,
    bounceReason: fields.bounceReason,
    attemptCount: fields.attemptCount,
    lastAttemptAt: fields.lastAttemptAt,
  };

  const { updateExpression, expressionAttributeNames, expressionAttributeValues } =
    buildUpdateExpression(updates, contextData.eventTimestamp);

  await dynamo
    .update({
      TableName: contextData.deliveriesTable,
      Key: { deliveryId: contextData.deliveryId },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    })
    .promise();
}

function buildUpdateExpression(
  fields: Record<string, any>,
  createdAt: number
): {
  updateExpression: string;
  expressionAttributeNames: Record<string, string>;
  expressionAttributeValues: Record<string, any>;
} {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  const expressionAttributeNames: Record<string, string> = {
    '#createdAt': 'createdAt',
  };
  const expressionAttributeValues: Record<string, any> = {
    ':createdAt': createdAt,
  };

  const assignments = ['#createdAt = if_not_exists(#createdAt, :createdAt)'];

  entries.forEach(([key, value], index) => {
    const nameKey = `#f${index}`;
    const valueKey = `:v${index}`;
    expressionAttributeNames[nameKey] = key;
    expressionAttributeValues[valueKey] = value;
    assignments.push(`${nameKey} = ${valueKey}`);
  });

  return {
    updateExpression: `SET ${assignments.join(', ')}`,
    expressionAttributeNames,
    expressionAttributeValues,
  };
}

function parseSubscriberItem(item: Record<string, any>): DomainSubscriber | null {
  if (!item || !item.subscriberId) {
    return null;
  }

  if (!item.state) {
    return null;
  }

  const tokens = item.tokens ?? {};
  const confirmationToken = tokens.confirmation ?? null;
  const subscriberToken =
    tokens.subscriber ?? (item.unsubscribeToken ? { hash: item.unsubscribeToken } : { hash: '' });

  const parseDate = (value: any): Date | null => {
    if (!value) {
      return null;
    }
    if (value instanceof Date) {
      return value;
    }
    if (typeof value === 'number') {
      return new Date(value);
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed);
  };

  return {
    id: item.subscriberId,
    state: item.state,
    email: item.email ?? null,
    emailNormalized: item.emailNormalized ?? null,
    hashedEmail: item.hashedEmail ?? null,
    bounceCount: item.bounceCount ?? 0,
    lastBounceAt: parseDate(item.lastBounceAt),
    tokens: {
      confirmation: confirmationToken
        ? {
            hash: confirmationToken.hash,
            issuedAt: parseDate(confirmationToken.issuedAt) ?? new Date(0),
            expiresAt: parseDate(confirmationToken.expiresAt) ?? new Date(0),
            usedAt: parseDate(confirmationToken.usedAt),
          }
        : null,
      subscriber: {
        hash: subscriberToken.hash,
        rotatedAt: parseDate(subscriberToken.rotatedAt) ?? new Date(0),
      },
    },
    createdAt: parseDate(item.createdAt) ?? new Date(0),
    updatedAt: parseDate(item.updatedAt) ?? new Date(0),
    confirmedAt: parseDate(item.confirmedAt),
    unsubscribedAt: parseDate(item.unsubscribedAt),
    suppressedAt: parseDate(item.suppressedAt),
  };
}

function mergeSubscriberItem(existing: Record<string, any>, subscriber: DomainSubscriber): Record<string, any> {
  const toMillis = (value: Date | null): number | null => {
    if (!value) {
      return null;
    }
    return value.getTime();
  };

  const hasSubscriberToken = Boolean(subscriber.tokens.subscriber.hash);
  const existingTokens = existing.tokens ?? null;

  const mergedTokens = hasSubscriberToken
    ? {
        confirmation: subscriber.tokens.confirmation
          ? {
              hash: subscriber.tokens.confirmation.hash,
              issuedAt: toMillis(subscriber.tokens.confirmation.issuedAt ?? null),
              expiresAt: toMillis(subscriber.tokens.confirmation.expiresAt ?? null),
              usedAt: toMillis(subscriber.tokens.confirmation.usedAt ?? null),
            }
          : null,
        subscriber: {
          hash: subscriber.tokens.subscriber.hash,
          rotatedAt: toMillis(subscriber.tokens.subscriber.rotatedAt ?? null),
        },
      }
    : existingTokens ?? {
        confirmation: null,
        subscriber: {
          hash: '',
          rotatedAt: null,
        },
      };

  return {
    ...existing,
    subscriberId: subscriber.id,
    state: subscriber.state,
    email: subscriber.email ?? null,
    emailNormalized: subscriber.emailNormalized ?? null,
    hashedEmail: subscriber.hashedEmail ?? null,
    bounceCount: subscriber.bounceCount,
    lastBounceAt: toMillis(subscriber.lastBounceAt),
    createdAt: toMillis(subscriber.createdAt),
    updatedAt: toMillis(subscriber.updatedAt),
    confirmedAt: toMillis(subscriber.confirmedAt),
    unsubscribedAt: toMillis(subscriber.unsubscribedAt),
    suppressedAt: toMillis(subscriber.suppressedAt),
    tokens: mergedTokens,
  };
}

async function putSubscriberItem(tableName: string, item: Record<string, any>): Promise<void> {
  await dynamo
    .put({
      TableName: tableName,
      Item: item,
    })
    .promise();
}

async function putAuditEvents(
  tableName: string,
  events: DomainAuditEvent[],
  fallbackSubscriberId: string
): Promise<void> {
  await Promise.all(
    events.map(event => {
      const subscriberId =
        (event.details?.subscriberId as string | undefined) ?? fallbackSubscriberId;
      const item = {
        eventId: event.id,
        subscriberId,
        eventType: event.type,
        timestamp: event.occurredAt.getTime(),
        metadata: event.details ?? {},
        actorType: event.actorType,
        entityType: event.entityType,
        entityId: event.entityId,
      };

      return dynamo
        .put({
          TableName: tableName,
          Item: item,
        })
        .promise();
    })
  );
}

async function putEngagementEvents(
  tableName: string,
  events: DomainEngagementEvent[],
  subscriberId: string,
  ttlDays: number
): Promise<void> {
  const ttlSeconds = ttlDays * 24 * 60 * 60;

  await Promise.all(
    events.map(event => {
      const timestampMs = event.occurredAt.getTime();
      const item = {
        eventId: event.id,
        subscriberId,
        campaignId: event.campaignId,
        deliveryId: event.deliveryId,
        eventType: event.type,
        timestamp: timestampMs,
        expiresAt: Math.floor(timestampMs / 1000) + ttlSeconds,
      };

      return dynamo
        .put({
          TableName: tableName,
          Item: item,
        })
        .promise();
    })
  );
}

async function getEmailHashSecret(environment: string): Promise<string> {
  // IAM NOTE: Requires secretsmanager:GetSecretValue on /{env}/email/email-hash-hmac-secret
  if (cachedEmailHashSecret) {
    return cachedEmailHashSecret;
  }

  const secretId = `/${environment}/email/email-hash-hmac-secret`;
  const response = await secretsManager.getSecretValue({ SecretId: secretId }).promise();
  const secret =
    response.SecretString ??
    (response.SecretBinary
      ? Buffer.from(response.SecretBinary as AWS.SecretsManager.SecretBinaryType, 'base64').toString('utf-8')
      : '');

  if (!secret) {
    throw new Error(`Missing email hash secret value for ${secretId}`);
  }

  cachedEmailHashSecret = secret;
  return secret;
}

async function getEngagementTtlDays(environment: string): Promise<number> {
  // IAM NOTE: Requires ssm:GetParameter on /email/{env}/retention/engagement-ttl-days
  if (cachedEngagementTtlDays !== null) {
    return cachedEngagementTtlDays;
  }

  const parameterName = `/email/${environment}/retention/engagement-ttl-days`;
  const response = await ssm.getParameter({ Name: parameterName }).promise();
  const value = Number(response.Parameter?.Value ?? '0');

  if (!value || Number.isNaN(value) || value <= 0) {
    throw new Error(`Invalid engagement TTL days from ${parameterName}`);
  }

  cachedEngagementTtlDays = value;
  return value;
}

const SIGNING_CERT_CACHE = new Map<string, string>();

async function verifySnsSignature(message: SNSMessage): Promise<void> {
  const signingCertUrl = validateSigningCertUrl(message.SigningCertURL);
  const certPem = await fetchSigningCert(signingCertUrl);
  const stringToSign = buildStringToSign(message);
  const signature = Buffer.from(message.Signature, 'base64');

  let algorithm: string;
  if (message.SignatureVersion === '1') {
    algorithm = 'RSA-SHA1';
  } else if (message.SignatureVersion === '2') {
    algorithm = 'RSA-SHA256';
  } else {
    throw new Error(`Unsupported SNS signature version: ${message.SignatureVersion}`);
  }

  const verifier = crypto.createVerify(algorithm);
  verifier.update(stringToSign);
  verifier.end();

  const isValid = verifier.verify(certPem, signature);
  if (!isValid) {
    throw new Error('SNS signature verification failed');
  }
}

function validateSigningCertUrl(signingCertUrl: string): string {
  let url: URL;
  try {
    url = new URL(signingCertUrl);
  } catch {
    throw new Error('Invalid SNS SigningCertURL');
  }

  if (url.protocol !== 'https:') {
    throw new Error('SNS SigningCertURL must use https');
  }

  if (url.username || url.password) {
    throw new Error('SNS SigningCertURL must not include credentials');
  }

  if (url.port && url.port !== '443') {
    throw new Error('SNS SigningCertURL must use port 443');
  }

  if (!url.hostname.startsWith('sns.') || !url.hostname.endsWith('.amazonaws.com')) {
    throw new Error('SNS SigningCertURL must be an Amazon SNS endpoint');
  }

  if (!url.pathname.endsWith('.pem')) {
    throw new Error('SNS SigningCertURL must reference a PEM certificate');
  }

  return url.toString();
}

async function fetchSigningCert(signingCertUrl: string): Promise<string> {
  const cached = SIGNING_CERT_CACHE.get(signingCertUrl);
  if (cached) {
    return cached;
  }

  const pem = await new Promise<string>((resolve, reject) => {
    const request = https.get(signingCertUrl, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`SNS certificate fetch failed with status ${response.statusCode}`));
        response.resume();
        return;
      }

      response.setEncoding('utf8');
      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => {
        resolve(data);
      });
    });

    request.setTimeout(5000);
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy(new Error('SNS certificate fetch timed out'));
    });
  });

  SIGNING_CERT_CACHE.set(signingCertUrl, pem);
  return pem;
}

function buildStringToSign(message: SNSMessage): string {
  const lines: string[] = [];

  const addField = (name: string, value: string) => {
    lines.push(`${name}\n${value}`);
  };

  const requireField = (name: string, value?: string) => {
    if (!value) {
      throw new Error(`Missing SNS field: ${name}`);
    }
    addField(name, value);
  };

  if (message.Type === 'Notification') {
    requireField('Message', message.Message);
    requireField('MessageId', message.MessageId);
    if (message.Subject) {
      addField('Subject', message.Subject);
    }
    requireField('Timestamp', message.Timestamp);
    requireField('TopicArn', message.TopicArn);
    requireField('Type', message.Type);
    return lines.join('\n');
  }

  if (message.Type === 'SubscriptionConfirmation' || message.Type === 'UnsubscribeConfirmation') {
    requireField('Message', message.Message);
    requireField('MessageId', message.MessageId);
    requireField('SubscribeURL', message.SubscribeURL);
    requireField('Timestamp', message.Timestamp);
    requireField('Token', message.Token);
    requireField('TopicArn', message.TopicArn);
    requireField('Type', message.Type);
    return lines.join('\n');
  }

  throw new Error(`Unsupported SNS message type: ${message.Type}`);
}
