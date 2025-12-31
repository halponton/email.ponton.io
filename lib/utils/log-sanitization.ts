/**
 * Log Sanitization Utility
 *
 * Prevents PII from being logged to CloudWatch Logs.
 *
 * Per PLATFORM_INVARIANTS.md section 7 and Milestone 6 security requirements:
 * - NEVER log: email, firstName, tokens, secrets
 * - ONLY log: ULIDs, action verbs, outcome status, timestamps
 *
 * This utility provides helper functions for safe logging throughout the application.
 *
 * CRITICAL SECURITY REQUIREMENT:
 * All Lambda handlers MUST use these utilities instead of logging raw objects.
 * Direct console.log of event data or DynamoDB records risks PII exposure.
 *
 * Usage Example:
 * ```typescript
 * import { sanitizeForLogging, sanitizeSubscriber, sanitizeSESEvent } from '@utils/log-sanitization';
 *
 * // Safe logging of subscriber data
 * console.log('Processing subscriber', sanitizeSubscriber(subscriber));
 *
 * // Safe logging of SES event
 * console.log('Received SES event', sanitizeSESEvent(sesEvent));
 *
 * // Safe logging of arbitrary objects (removes all PII keys)
 * console.log('Request context', sanitizeForLogging(context));
 * ```
 *
 * Defense in Depth:
 * - This utility is the FIRST line of defense (code-level sanitization)
 * - CloudWatch Logs Insights queries should also filter sensitive data
 * - IAM policies should restrict log access to authorized personnel only
 * - Log retention policies enforce automatic deletion after 180 days
 */

/**
 * List of PII field names that must NEVER appear in logs
 *
 * These keys are removed from all objects before logging.
 * Add new sensitive fields here as the application evolves.
 */
const PII_KEYS = [
  'email',
  'firstName',
  'confirmToken',
  'unsubscribeToken',
  'emailNormalizedHash', // Hash is not PII but may aid correlation attacks
  'token', // Generic token field
  'secret', // Any secret value
  'password', // Should never exist but defensive
  'authorization', // Authorization headers
  'Authorization', // Case-sensitive variant
  'cookie', // Session cookies
  'Cookie', // Case-sensitive variant
];

/**
 * Sanitize an object for safe logging by removing all PII fields
 *
 * This function recursively removes all PII keys from an object,
 * making it safe to log to CloudWatch.
 *
 * @param obj - Object to sanitize
 * @returns Sanitized object with PII fields removed
 *
 * @example
 * ```typescript
 * const subscriber = { subscriberId: '01ARZ...', email: 'user@example.com', state: 'SUBSCRIBED' };
 * console.log(sanitizeForLogging(subscriber));
 * // Output: { subscriberId: '01ARZ...', state: 'SUBSCRIBED' }
 * ```
 */
export function sanitizeForLogging(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeForLogging);
  }

  const sanitized: Record<string, any> = {};

  for (const [key, value] of Object.entries(obj)) {
    // Skip PII keys entirely
    if (PII_KEYS.includes(key)) {
      sanitized[key] = '[REDACTED]';
      continue;
    }

    // Recursively sanitize nested objects
    if (value && typeof value === 'object') {
      sanitized[key] = sanitizeForLogging(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Sanitize subscriber record for safe logging
 *
 * Returns only non-PII fields that are safe to log.
 * Per platform invariants: NEVER log email or firstName.
 *
 * @param subscriber - Subscriber record from DynamoDB
 * @returns Sanitized subscriber object
 *
 * @example
 * ```typescript
 * console.log('Subscriber updated', sanitizeSubscriber(subscriber));
 * // Output: { subscriberId: '01ARZ...', state: 'SUBSCRIBED', createdAt: 1234567890 }
 * ```
 */
export function sanitizeSubscriber(subscriber: any): any {
  if (!subscriber) {
    return subscriber;
  }

  return {
    subscriberId: subscriber.subscriberId,
    state: subscriber.state,
    createdAt: subscriber.createdAt,
    updatedAt: subscriber.updatedAt,
    confirmedAt: subscriber.confirmedAt,
    bounceCount: subscriber.bounceCount,
    lastBounceAt: subscriber.lastBounceAt,
    // NEVER include: email, firstName, emailNormalizedHash, confirmToken, unsubscribeToken
  };
}

/**
 * Sanitize SES event for safe logging
 *
 * Returns only event metadata without email addresses.
 * Per security requirements: NEVER log recipient email addresses.
 *
 * @param sesEvent - SES event from SNS
 * @returns Sanitized SES event object
 *
 * @example
 * ```typescript
 * console.log('Processing SES event', sanitizeSESEvent(sesEvent));
 * // Output: { eventType: 'Delivery', messageId: 'abc123', timestamp: '...' }
 * ```
 */
export function sanitizeSESEvent(sesEvent: any): any {
  if (!sesEvent) {
    return sesEvent;
  }

  const sanitized: Record<string, any> = {
    eventType: sesEvent.eventType,
  };

  // Safe mail metadata (NO destination emails)
  if (sesEvent.mail) {
    sanitized.mail = {
      timestamp: sesEvent.mail.timestamp,
      messageId: sesEvent.mail.messageId,
      // source is the FROM address (our verified domain, not PII)
      source: sesEvent.mail.source,
      // NEVER log destination (recipient emails are PII)
      recipientCount: sesEvent.mail.destination?.length || 0,
      // Safe to log tags (contains deliveryId, campaignId)
      tags: sesEvent.mail.tags,
    };
  }

  // Delivery metadata
  if (sesEvent.delivery) {
    sanitized.delivery = {
      timestamp: sesEvent.delivery.timestamp,
      processingTimeMillis: sesEvent.delivery.processingTimeMillis,
      recipientCount: sesEvent.delivery.recipients?.length || 0,
      // smtpResponse may contain PII in rare cases, so sanitize
      smtpResponse: sanitizeSmtpResponse(sesEvent.delivery.smtpResponse),
    };
  }

  // Bounce metadata
  if (sesEvent.bounce) {
    sanitized.bounce = {
      bounceType: sesEvent.bounce.bounceType,
      bounceSubType: sesEvent.bounce.bounceSubType,
      timestamp: sesEvent.bounce.timestamp,
      recipientCount: sesEvent.bounce.bouncedRecipients?.length || 0,
      // diagnosticCode may contain email addresses, so sanitize
      diagnosticCode: sanitizeDiagnosticCode(
        sesEvent.bounce.bouncedRecipients?.[0]?.diagnosticCode
      ),
    };
  }

  // Complaint metadata
  if (sesEvent.complaint) {
    sanitized.complaint = {
      complaintFeedbackType: sesEvent.complaint.complaintFeedbackType,
      timestamp: sesEvent.complaint.timestamp,
      recipientCount: sesEvent.complaint.complainedRecipients?.length || 0,
    };
  }

  // Reject metadata
  if (sesEvent.reject) {
    sanitized.reject = {
      reason: sesEvent.reject.reason,
    };
  }

  return sanitized;
}

/**
 * Sanitize SMTP response string
 *
 * SMTP responses may contain email addresses in rare cases.
 * This function removes email patterns while preserving diagnostic info.
 *
 * @param smtpResponse - Raw SMTP response string
 * @returns Sanitized SMTP response
 */
function sanitizeSmtpResponse(smtpResponse?: string): string | undefined {
  if (!smtpResponse) {
    return smtpResponse;
  }

  // Remove email patterns (basic regex to catch common formats)
  // This is defensive - SMTP responses rarely contain emails
  return smtpResponse.replace(/[\w.-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[EMAIL_REDACTED]');
}

/**
 * Sanitize diagnostic code string
 *
 * Diagnostic codes may contain email addresses in bounce messages.
 * This function removes email patterns while preserving diagnostic info.
 *
 * @param diagnosticCode - Raw diagnostic code string
 * @returns Sanitized diagnostic code
 */
function sanitizeDiagnosticCode(diagnosticCode?: string): string | undefined {
  if (!diagnosticCode) {
    return diagnosticCode;
  }

  // Remove email patterns from diagnostic codes
  return diagnosticCode.replace(/[\w.-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[EMAIL_REDACTED]');
}

/**
 * Create a safe log context object with common fields
 *
 * Helper to create consistent log context across all Lambda functions.
 * Automatically includes requestId and environment.
 *
 * @param requestId - AWS request ID from Lambda context
 * @param additionalFields - Additional safe fields to include
 * @returns Safe log context object
 *
 * @example
 * ```typescript
 * console.log('Processing request', createLogContext(context.awsRequestId, {
 *   action: 'subscribe',
 *   status: 'success',
 * }));
 * ```
 */
export function createLogContext(
  requestId: string,
  additionalFields: Record<string, any> = {}
): Record<string, any> {
  return {
    requestId,
    environment: process.env.ENVIRONMENT || 'unknown',
    timestamp: new Date().toISOString(),
    ...sanitizeForLogging(additionalFields),
  };
}

/**
 * Validate that a ULID is properly formatted
 *
 * Used for defensive logging - ensures we only log valid ULIDs.
 * Invalid ULIDs may indicate data corruption or injection attempts.
 *
 * @param ulid - ULID string to validate
 * @returns true if ULID is valid format
 */
export function isValidULID(ulid: string): boolean {
  if (!ulid || typeof ulid !== 'string') {
    return false;
  }

  // ULID format: 26 characters, Crockford Base32
  // Regex: [0-7][0-9A-HJKMNP-TV-Z]{25}
  const ulidRegex = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
  return ulidRegex.test(ulid);
}

/**
 * Sanitize ULID for logging
 *
 * Validates ULID format before logging to prevent injection attacks.
 * Returns '[INVALID_ULID]' if format is invalid.
 *
 * @param ulid - ULID to sanitize
 * @param fieldName - Field name for error context
 * @returns Valid ULID or '[INVALID_ULID]'
 */
export function sanitizeULID(ulid: string, fieldName: string = 'id'): string {
  if (!isValidULID(ulid)) {
    console.warn(`Invalid ULID format for ${fieldName}`, { provided: ulid?.substring(0, 8) });
    return '[INVALID_ULID]';
  }
  return ulid;
}
