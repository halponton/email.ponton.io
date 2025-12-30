import { SQSEvent, SQSRecord, Context } from 'aws-lambda';
import * as crypto from 'crypto';
import * as https from 'https';

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
 * - No email addresses logged (PII protection)
 * - Log delivery IDs, event types, timestamps only
 * - Log retention: 180 days per platform invariants
 *
 * IMPORTANT - Infrastructure Wiring Only:
 * This is a placeholder handler. Production implementation will:
 * 1. Parse SNS envelope and extract SES event
 * 2. Validate event structure
 * 3. Call domain layer (ponton.io_email_service) for business logic
 * 4. Update DynamoDB tables (Deliveries, AuditEvents, Subscribers)
 * 5. Return batch item failures for retry
 *
 * The domain layer owns:
 * - Bounce handling logic (update subscriber state)
 * - Complaint handling logic (suppress subscriber)
 * - Delivery tracking (update delivery record)
 * - Audit event creation
 *
 * This handler only wires infrastructure to domain layer.
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
    console.log('SES Event Handler invoked', {
      environment,
      recordCount: event.Records.length,
      requestId: context.requestId,
    });
  }

  const batchItemFailures: BatchItemFailure[] = [];

  // Process each SQS record (each contains an SNS message with SES event)
  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (error) {
      // Log error without exposing PII
      console.error('Failed to process SES event', {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : 'Unknown error',
        requestId: context.requestId,
      });

      // Add to batch item failures for retry
      batchItemFailures.push({
        itemIdentifier: record.messageId,
      });
    }
  }

  if (batchItemFailures.length > 0) {
    console.warn('Partial batch failure', {
      failedCount: batchItemFailures.length,
      totalCount: event.Records.length,
      requestId: context.requestId,
    });
  }

  // Return failed items for SQS retry
  // Successfully processed items are automatically deleted from queue
  return { batchItemFailures };
}

/**
 * Process a single SQS record containing SNS message with SES event
 *
 * @param record - SQS record
 */
async function processRecord(record: SQSRecord): Promise<void> {
  const logLevel = process.env.LOG_LEVEL || 'INFO';

  // Parse SNS message from SQS record body
  const snsMessage: SNSMessage = JSON.parse(record.body);

  // Verify SNS signature before trusting payload per PLATFORM_INVARIANTS.md
  await verifySnsSignature(snsMessage);

  // Parse SES event from SNS message
  const sesEvent: SESEvent = JSON.parse(snsMessage.Message);

  if (logLevel === 'DEBUG') {
    // Log event type and metadata (no email addresses per PII protection)
    console.log('Processing SES event', {
      eventType: sesEvent.eventType,
      messageId: sesEvent.mail.messageId,
      timestamp: sesEvent.mail.timestamp,
      snsMessageId: snsMessage.MessageId,
    });
  }

  // PLACEHOLDER: Call domain layer to process event
  // Production implementation will:
  // 1. Extract delivery ID from mail.tags (set when email was sent)
  // 2. Call domain service to handle event based on type
  // 3. Update DynamoDB tables (Deliveries, AuditEvents, Subscribers)

  switch (sesEvent.eventType) {
    case 'Send':
      await handleSend(sesEvent);
      break;
    case 'Delivery':
      await handleDelivery(sesEvent);
      break;
    case 'Bounce':
      await handleBounce(sesEvent);
      break;
    case 'Complaint':
      await handleComplaint(sesEvent);
      break;
    case 'Reject':
      await handleReject(sesEvent);
      break;
    default:
      console.warn('Unknown SES event type', {
        eventType: (sesEvent as any).eventType,
      });
  }
}

/**
 * Handle SEND event (email accepted by SES)
 *
 * PLACEHOLDER: Production implementation will:
 * - Update Deliveries table: status = SENT, sentAt = timestamp
 * - Create AuditEvent: EMAIL_SENT
 */
async function handleSend(event: SESEvent): Promise<void> {
  const logLevel = process.env.LOG_LEVEL || 'INFO';

  if (logLevel === 'DEBUG') {
    console.log('Handling SEND event', {
      messageId: event.mail.messageId,
      timestamp: event.mail.timestamp,
    });
  }

  // TODO: Call domain layer to update Deliveries table
  // Domain layer will extract deliveryId from event.mail.tags
}

/**
 * Handle DELIVERY event (email delivered successfully)
 *
 * PLACEHOLDER: Production implementation will:
 * - Update Deliveries table: status = DELIVERED, deliveredAt = timestamp
 * - Create AuditEvent: EMAIL_DELIVERED
 * - Create EngagementEvent: DELIVERY
 */
async function handleDelivery(event: SESEvent): Promise<void> {
  const logLevel = process.env.LOG_LEVEL || 'INFO';

  if (logLevel === 'DEBUG') {
    console.log('Handling DELIVERY event', {
      messageId: event.mail.messageId,
      timestamp: event.delivery?.timestamp,
      processingTime: event.delivery?.processingTimeMillis,
    });
  }

  // TODO: Call domain layer to update Deliveries table
}

/**
 * Handle BOUNCE event (email bounced)
 *
 * PLACEHOLDER: Production implementation will:
 * - Update Deliveries table: status = BOUNCED, bouncedAt = timestamp, bounceReason
 * - Update Subscribers table: increment bounceCount, set lastBounceAt
 * - If hard bounce: Update Subscribers state = BOUNCED
 * - Create AuditEvent: EMAIL_BOUNCED
 * - Create EngagementEvent: BOUNCE
 *
 * Per PLATFORM_INVARIANTS.md section 10:
 * - Hard bounce → BOUNCED state → email hashed and removed
 */
async function handleBounce(event: SESEvent): Promise<void> {
  const logLevel = process.env.LOG_LEVEL || 'INFO';

  if (logLevel === 'DEBUG') {
    console.log('Handling BOUNCE event', {
      messageId: event.mail.messageId,
      bounceType: event.bounce?.bounceType,
      bounceSubType: event.bounce?.bounceSubType,
      recipientCount: event.bounce?.bouncedRecipients.length,
    });
  }

  // TODO: Call domain layer to update Deliveries and Subscribers tables
  // Domain layer determines if hard bounce should transition to BOUNCED state
}

/**
 * Handle COMPLAINT event (recipient marked as spam)
 *
 * PLACEHOLDER: Production implementation will:
 * - Update Deliveries table: status = COMPLAINED
 * - Update Subscribers table: state = SUPPRESSED
 * - Create AuditEvent: EMAIL_COMPLAINED
 * - Create EngagementEvent: COMPLAINT
 *
 * Per PLATFORM_INVARIANTS.md section 10:
 * - Complaint → SUPPRESSED state → email hashed and removed
 */
async function handleComplaint(event: SESEvent): Promise<void> {
  const logLevel = process.env.LOG_LEVEL || 'INFO';

  if (logLevel === 'DEBUG') {
    console.log('Handling COMPLAINT event', {
      messageId: event.mail.messageId,
      complaintFeedbackType: event.complaint?.complaintFeedbackType,
      recipientCount: event.complaint?.complainedRecipients.length,
    });
  }

  // TODO: Call domain layer to update Deliveries and Subscribers tables
  // Complaint always transitions subscriber to SUPPRESSED state
}

/**
 * Handle REJECT event (SES rejected email)
 *
 * PLACEHOLDER: Production implementation will:
 * - Update Deliveries table: status = FAILED, bounceReason = reject reason
 * - Create AuditEvent: EMAIL_REJECTED
 */
async function handleReject(event: SESEvent): Promise<void> {
  const logLevel = process.env.LOG_LEVEL || 'INFO';

  if (logLevel === 'DEBUG') {
    console.log('Handling REJECT event', {
      messageId: event.mail.messageId,
      reason: event.reject?.reason,
    });
  }

  // TODO: Call domain layer to update Deliveries table
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
