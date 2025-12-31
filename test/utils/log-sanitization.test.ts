/**
 * Tests for log sanitization utility
 *
 * CRITICAL SECURITY REQUIREMENT: This utility prevents PII from being logged.
 * Test coverage must be comprehensive to ensure no PII leaks.
 *
 * Per Milestone 6 security requirements:
 * - Minimum 90% code coverage
 * - Test all PII field types (email, firstName, tokens)
 * - Test nested objects and arrays
 * - Test edge cases (null, undefined, malformed data)
 */

import {
  sanitizeForLogging,
  sanitizeSubscriber,
  sanitizeSESEvent,
  createLogContext,
  isValidULID,
  sanitizeULID,
} from '../../lib/utils/log-sanitization';

describe('Log Sanitization Utility', () => {
  describe('sanitizeForLogging', () => {
    it('should redact email field', () => {
      const input = { email: 'user@example.com', name: 'John' };
      const result = sanitizeForLogging(input);
      expect(result.email).toBe('[REDACTED]');
      expect(result.name).toBe('John');
    });

    it('should redact firstName field', () => {
      const input = { firstName: 'John', lastName: 'Doe' };
      const result = sanitizeForLogging(input);
      expect(result.firstName).toBe('[REDACTED]');
      expect(result.lastName).toBe('Doe');
    });

    it('should redact confirmToken field', () => {
      const input = { confirmToken: 'abc123', subscriberId: '01ARZ' };
      const result = sanitizeForLogging(input);
      expect(result.confirmToken).toBe('[REDACTED]');
      expect(result.subscriberId).toBe('01ARZ');
    });

    it('should redact unsubscribeToken field', () => {
      const input = { unsubscribeToken: 'xyz789', state: 'SUBSCRIBED' };
      const result = sanitizeForLogging(input);
      expect(result.unsubscribeToken).toBe('[REDACTED]');
      expect(result.state).toBe('SUBSCRIBED');
    });

    it('should redact emailNormalizedHash field', () => {
      const input = { emailNormalizedHash: 'hash123', subscriberId: '01ARZ' };
      const result = sanitizeForLogging(input);
      expect(result.emailNormalizedHash).toBe('[REDACTED]');
      expect(result.subscriberId).toBe('01ARZ');
    });

    it('should redact generic token field', () => {
      const input = { token: 'secret123', id: '123' };
      const result = sanitizeForLogging(input);
      expect(result.token).toBe('[REDACTED]');
      expect(result.id).toBe('123');
    });

    it('should redact secret field', () => {
      const input = { secret: 'topsecret', apiKey: 'public' };
      const result = sanitizeForLogging(input);
      expect(result.secret).toBe('[REDACTED]');
      expect(result.apiKey).toBe('public');
    });

    it('should redact password field', () => {
      const input = { password: 'password123', username: 'admin' };
      const result = sanitizeForLogging(input);
      expect(result.password).toBe('[REDACTED]');
      expect(result.username).toBe('admin');
    });

    it('should redact authorization header (lowercase)', () => {
      const input = { authorization: 'Bearer token123', method: 'GET' };
      const result = sanitizeForLogging(input);
      expect(result.authorization).toBe('[REDACTED]');
      expect(result.method).toBe('GET');
    });

    it('should redact Authorization header (uppercase)', () => {
      const input = { Authorization: 'Bearer token123', method: 'GET' };
      const result = sanitizeForLogging(input);
      expect(result.Authorization).toBe('[REDACTED]');
      expect(result.method).toBe('GET');
    });

    it('should redact cookie field (lowercase)', () => {
      const input = { cookie: 'session=abc', path: '/api' };
      const result = sanitizeForLogging(input);
      expect(result.cookie).toBe('[REDACTED]');
      expect(result.path).toBe('/api');
    });

    it('should redact Cookie field (uppercase)', () => {
      const input = { Cookie: 'session=abc', path: '/api' };
      const result = sanitizeForLogging(input);
      expect(result.Cookie).toBe('[REDACTED]');
      expect(result.path).toBe('/api');
    });

    it('should handle nested objects', () => {
      const input = {
        subscriberId: '01ARZ',
        details: {
          email: 'user@example.com',
          firstName: 'John',
          state: 'SUBSCRIBED',
        },
      };
      const result = sanitizeForLogging(input);
      expect(result.subscriberId).toBe('01ARZ');
      expect(result.details.email).toBe('[REDACTED]');
      expect(result.details.firstName).toBe('[REDACTED]');
      expect(result.details.state).toBe('SUBSCRIBED');
    });

    it('should handle deeply nested objects', () => {
      const input = {
        level1: {
          level2: {
            level3: {
              email: 'user@example.com',
              id: '123',
            },
          },
        },
      };
      const result = sanitizeForLogging(input);
      expect(result.level1.level2.level3.email).toBe('[REDACTED]');
      expect(result.level1.level2.level3.id).toBe('123');
    });

    it('should handle arrays of objects', () => {
      const input = {
        subscribers: [
          { email: 'user1@example.com', subscriberId: '01ARZ1' },
          { email: 'user2@example.com', subscriberId: '01ARZ2' },
        ],
      };
      const result = sanitizeForLogging(input);
      expect(result.subscribers[0].email).toBe('[REDACTED]');
      expect(result.subscribers[0].subscriberId).toBe('01ARZ1');
      expect(result.subscribers[1].email).toBe('[REDACTED]');
      expect(result.subscribers[1].subscriberId).toBe('01ARZ2');
    });

    it('should handle arrays of primitives', () => {
      const input = { ids: ['01ARZ1', '01ARZ2', '01ARZ3'] };
      const result = sanitizeForLogging(input);
      expect(result.ids).toEqual(['01ARZ1', '01ARZ2', '01ARZ3']);
    });

    it('should handle null values', () => {
      const result = sanitizeForLogging(null);
      expect(result).toBeNull();
    });

    it('should handle undefined values', () => {
      const result = sanitizeForLogging(undefined);
      expect(result).toBeUndefined();
    });

    it('should handle primitive values', () => {
      expect(sanitizeForLogging('string')).toBe('string');
      expect(sanitizeForLogging(123)).toBe(123);
      expect(sanitizeForLogging(true)).toBe(true);
    });

    it('should handle empty objects', () => {
      const result = sanitizeForLogging({});
      expect(result).toEqual({});
    });

    it('should handle empty arrays', () => {
      const result = sanitizeForLogging([]);
      expect(result).toEqual([]);
    });

    it('should handle objects with null/undefined properties', () => {
      const input = { email: 'user@example.com', name: null, age: undefined };
      const result = sanitizeForLogging(input);
      expect(result.email).toBe('[REDACTED]');
      expect(result.name).toBeNull();
      expect(result.age).toBeUndefined();
    });

    it('should handle multiple PII fields in same object', () => {
      const input = {
        email: 'user@example.com',
        firstName: 'John',
        confirmToken: 'token123',
        unsubscribeToken: 'token456',
        subscriberId: '01ARZ',
      };
      const result = sanitizeForLogging(input);
      expect(result.email).toBe('[REDACTED]');
      expect(result.firstName).toBe('[REDACTED]');
      expect(result.confirmToken).toBe('[REDACTED]');
      expect(result.unsubscribeToken).toBe('[REDACTED]');
      expect(result.subscriberId).toBe('01ARZ');
    });
  });

  describe('sanitizeSubscriber', () => {
    it('should return only safe fields from subscriber', () => {
      const subscriber = {
        subscriberId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        email: 'user@example.com',
        firstName: 'John',
        emailNormalizedHash: 'hash123',
        confirmToken: 'token123',
        unsubscribeToken: 'token456',
        state: 'SUBSCRIBED',
        createdAt: 1234567890,
        updatedAt: 1234567899,
        confirmedAt: 1234567895,
        bounceCount: 0,
        lastBounceAt: null,
      };

      const result = sanitizeSubscriber(subscriber);

      expect(result.subscriberId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
      expect(result.state).toBe('SUBSCRIBED');
      expect(result.createdAt).toBe(1234567890);
      expect(result.updatedAt).toBe(1234567899);
      expect(result.confirmedAt).toBe(1234567895);
      expect(result.bounceCount).toBe(0);
      expect(result.lastBounceAt).toBeNull();

      // Should NOT include PII fields
      expect(result.email).toBeUndefined();
      expect(result.firstName).toBeUndefined();
      expect(result.emailNormalizedHash).toBeUndefined();
      expect(result.confirmToken).toBeUndefined();
      expect(result.unsubscribeToken).toBeUndefined();
    });

    it('should handle null subscriber', () => {
      const result = sanitizeSubscriber(null);
      expect(result).toBeNull();
    });

    it('should handle undefined subscriber', () => {
      const result = sanitizeSubscriber(undefined);
      expect(result).toBeUndefined();
    });

    it('should handle subscriber with missing optional fields', () => {
      const subscriber = {
        subscriberId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        state: 'SUBSCRIBED',
        createdAt: 1234567890,
      };

      const result = sanitizeSubscriber(subscriber);

      expect(result.subscriberId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
      expect(result.state).toBe('SUBSCRIBED');
      expect(result.createdAt).toBe(1234567890);
      expect(result.updatedAt).toBeUndefined();
      expect(result.confirmedAt).toBeUndefined();
    });
  });

  describe('sanitizeSESEvent', () => {
    it('should sanitize Send event', () => {
      const sesEvent = {
        eventType: 'Send',
        mail: {
          timestamp: '2023-01-01T00:00:00.000Z',
          messageId: 'msg-123',
          source: 'noreply@email.ponton.io',
          destination: ['user@example.com'],
          tags: { deliveryId: ['01ARZ'], campaignId: ['01CAM'] },
        },
      };

      const result = sanitizeSESEvent(sesEvent);

      expect(result.eventType).toBe('Send');
      expect(result.mail.timestamp).toBe('2023-01-01T00:00:00.000Z');
      expect(result.mail.messageId).toBe('msg-123');
      expect(result.mail.source).toBe('noreply@email.ponton.io');
      expect(result.mail.recipientCount).toBe(1);
      expect(result.mail.tags).toEqual({ deliveryId: ['01ARZ'], campaignId: ['01CAM'] });

      // Should NOT include destination emails
      expect(result.mail.destination).toBeUndefined();
    });

    it('should sanitize Delivery event', () => {
      const sesEvent = {
        eventType: 'Delivery',
        mail: {
          timestamp: '2023-01-01T00:00:00.000Z',
          messageId: 'msg-123',
          source: 'noreply@email.ponton.io',
          destination: ['user@example.com'],
        },
        delivery: {
          timestamp: '2023-01-01T00:00:05.000Z',
          processingTimeMillis: 5000,
          recipients: ['user@example.com'],
          smtpResponse: '250 2.0.0 OK',
        },
      };

      const result = sanitizeSESEvent(sesEvent);

      expect(result.eventType).toBe('Delivery');
      expect(result.delivery.timestamp).toBe('2023-01-01T00:00:05.000Z');
      expect(result.delivery.processingTimeMillis).toBe(5000);
      expect(result.delivery.recipientCount).toBe(1);
      expect(result.delivery.smtpResponse).toBe('250 2.0.0 OK');

      // Should NOT include recipient emails
      expect(result.delivery.recipients).toBeUndefined();
    });

    it('should sanitize SMTP response containing email', () => {
      const sesEvent = {
        eventType: 'Delivery',
        mail: {
          timestamp: '2023-01-01T00:00:00.000Z',
          messageId: 'msg-123',
          source: 'noreply@email.ponton.io',
          destination: ['user@example.com'],
        },
        delivery: {
          timestamp: '2023-01-01T00:00:05.000Z',
          processingTimeMillis: 5000,
          recipients: ['user@example.com'],
          smtpResponse: '250 2.0.0 OK user@example.com accepted',
        },
      };

      const result = sanitizeSESEvent(sesEvent);

      expect(result.delivery.smtpResponse).toBe('250 2.0.0 OK [EMAIL_REDACTED] accepted');
    });

    it('should sanitize Bounce event', () => {
      const sesEvent = {
        eventType: 'Bounce',
        mail: {
          timestamp: '2023-01-01T00:00:00.000Z',
          messageId: 'msg-123',
          source: 'noreply@email.ponton.io',
          destination: ['user@example.com'],
        },
        bounce: {
          bounceType: 'Permanent',
          bounceSubType: 'General',
          timestamp: '2023-01-01T00:00:05.000Z',
          bouncedRecipients: [
            {
              emailAddress: 'user@example.com',
              status: '5.1.1',
              diagnosticCode: 'smtp; 550 5.1.1 user unknown',
            },
          ],
        },
      };

      const result = sanitizeSESEvent(sesEvent);

      expect(result.eventType).toBe('Bounce');
      expect(result.bounce.bounceType).toBe('Permanent');
      expect(result.bounce.bounceSubType).toBe('General');
      expect(result.bounce.timestamp).toBe('2023-01-01T00:00:05.000Z');
      expect(result.bounce.recipientCount).toBe(1);
      expect(result.bounce.diagnosticCode).toBe('smtp; 550 5.1.1 user unknown');

      // Should NOT include bouncedRecipients
      expect(result.bounce.bouncedRecipients).toBeUndefined();
    });

    it('should sanitize diagnostic code containing email', () => {
      const sesEvent = {
        eventType: 'Bounce',
        mail: {
          timestamp: '2023-01-01T00:00:00.000Z',
          messageId: 'msg-123',
          source: 'noreply@email.ponton.io',
          destination: ['user@example.com'],
        },
        bounce: {
          bounceType: 'Permanent',
          bounceSubType: 'General',
          timestamp: '2023-01-01T00:00:05.000Z',
          bouncedRecipients: [
            {
              emailAddress: 'user@example.com',
              diagnosticCode: 'smtp; 550 5.1.1 <user@example.com>: Recipient address rejected',
            },
          ],
        },
      };

      const result = sanitizeSESEvent(sesEvent);

      expect(result.bounce.diagnosticCode).toBe(
        'smtp; 550 5.1.1 <[EMAIL_REDACTED]>: Recipient address rejected'
      );
    });

    it('should sanitize Complaint event', () => {
      const sesEvent = {
        eventType: 'Complaint',
        mail: {
          timestamp: '2023-01-01T00:00:00.000Z',
          messageId: 'msg-123',
          source: 'noreply@email.ponton.io',
          destination: ['user@example.com'],
        },
        complaint: {
          complainedRecipients: [{ emailAddress: 'user@example.com' }],
          timestamp: '2023-01-01T00:00:05.000Z',
          complaintFeedbackType: 'abuse',
        },
      };

      const result = sanitizeSESEvent(sesEvent);

      expect(result.eventType).toBe('Complaint');
      expect(result.complaint.complaintFeedbackType).toBe('abuse');
      expect(result.complaint.timestamp).toBe('2023-01-01T00:00:05.000Z');
      expect(result.complaint.recipientCount).toBe(1);

      // Should NOT include complainedRecipients
      expect(result.complaint.complainedRecipients).toBeUndefined();
    });

    it('should sanitize Reject event', () => {
      const sesEvent = {
        eventType: 'Reject',
        mail: {
          timestamp: '2023-01-01T00:00:00.000Z',
          messageId: 'msg-123',
          source: 'noreply@email.ponton.io',
          destination: ['user@example.com'],
        },
        reject: {
          reason: 'Bad content',
        },
      };

      const result = sanitizeSESEvent(sesEvent);

      expect(result.eventType).toBe('Reject');
      expect(result.reject.reason).toBe('Bad content');
    });

    it('should handle null SES event', () => {
      const result = sanitizeSESEvent(null);
      expect(result).toBeNull();
    });

    it('should handle undefined SES event', () => {
      const result = sanitizeSESEvent(undefined);
      expect(result).toBeUndefined();
    });

    it('should handle SES event with missing optional fields', () => {
      const sesEvent = {
        eventType: 'Send',
        mail: {
          timestamp: '2023-01-01T00:00:00.000Z',
          messageId: 'msg-123',
          source: 'noreply@email.ponton.io',
        },
      };

      const result = sanitizeSESEvent(sesEvent);

      expect(result.eventType).toBe('Send');
      expect(result.mail.recipientCount).toBe(0);
    });
  });

  describe('createLogContext', () => {
    beforeEach(() => {
      // Mock environment variable
      process.env.ENVIRONMENT = 'test';
    });

    afterEach(() => {
      delete process.env.ENVIRONMENT;
    });

    it('should create log context with requestId', () => {
      const requestId = 'req-123';
      const result = createLogContext(requestId);

      expect(result.requestId).toBe('req-123');
      expect(result.environment).toBe('test');
      expect(result.timestamp).toBeDefined();
      expect(typeof result.timestamp).toBe('string');
    });

    it('should include additional fields', () => {
      const requestId = 'req-123';
      const additionalFields = { action: 'subscribe', status: 'success' };
      const result = createLogContext(requestId, additionalFields);

      expect(result.requestId).toBe('req-123');
      expect(result.action).toBe('subscribe');
      expect(result.status).toBe('success');
    });

    it('should sanitize additional fields', () => {
      const requestId = 'req-123';
      const additionalFields = { email: 'user@example.com', subscriberId: '01ARZ' };
      const result = createLogContext(requestId, additionalFields);

      expect(result.email).toBe('[REDACTED]');
      expect(result.subscriberId).toBe('01ARZ');
    });

    it('should default environment to unknown if not set', () => {
      delete process.env.ENVIRONMENT;
      const requestId = 'req-123';
      const result = createLogContext(requestId);

      expect(result.environment).toBe('unknown');
    });

    it('should handle empty additional fields', () => {
      const requestId = 'req-123';
      const result = createLogContext(requestId, {});

      expect(result.requestId).toBe('req-123');
      expect(result.environment).toBe('test');
      expect(result.timestamp).toBeDefined();
    });
  });

  describe('isValidULID', () => {
    it('should validate correct ULID format', () => {
      expect(isValidULID('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
      expect(isValidULID('01BX5ZZKBKACTAV9WEVGEMMVRZ')).toBe(true);
      expect(isValidULID('01DRJZ3KTJM0SN7GJXRW0BCJY0')).toBe(true);
    });

    it('should reject invalid ULID format', () => {
      expect(isValidULID('invalid')).toBe(false);
      expect(isValidULID('01ARZ3NDEKTSV4RRFFQ69G5FA')).toBe(false); // Too short
      expect(isValidULID('01ARZ3NDEKTSV4RRFFQ69G5FAVX')).toBe(false); // Too long
      expect(isValidULID('81ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(false); // Invalid first char
      expect(isValidULID('01ARZ3NDEKTSV4RRFFQ69G5F@V')).toBe(false); // Invalid char
    });

    it('should reject non-string values', () => {
      expect(isValidULID(null as any)).toBe(false);
      expect(isValidULID(undefined as any)).toBe(false);
      expect(isValidULID(123 as any)).toBe(false);
      expect(isValidULID({} as any)).toBe(false);
    });

    it('should reject empty string', () => {
      expect(isValidULID('')).toBe(false);
    });

    it('should reject ULIDs with lowercase letters', () => {
      expect(isValidULID('01arz3ndektsv4rrffq69g5fav')).toBe(false);
    });
  });

  describe('sanitizeULID', () => {
    it('should return valid ULID unchanged', () => {
      const ulid = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
      expect(sanitizeULID(ulid)).toBe(ulid);
    });

    it('should return [INVALID_ULID] for invalid ULID', () => {
      expect(sanitizeULID('invalid')).toBe('[INVALID_ULID]');
      expect(sanitizeULID('01ARZ3NDEKTSV4RRFFQ69G5FA')).toBe('[INVALID_ULID]');
      expect(sanitizeULID('81ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('[INVALID_ULID]');
    });

    it('should accept custom field name for error context', () => {
      // This test verifies the fieldName parameter is used in warning
      // We can't easily test console.warn output, but we verify it doesn't throw
      expect(() => sanitizeULID('invalid', 'subscriberId')).not.toThrow();
      expect(sanitizeULID('invalid', 'subscriberId')).toBe('[INVALID_ULID]');
    });

    it('should handle null/undefined gracefully', () => {
      expect(sanitizeULID(null as any)).toBe('[INVALID_ULID]');
      expect(sanitizeULID(undefined as any)).toBe('[INVALID_ULID]');
    });
  });
});
