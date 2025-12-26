# ponton.io_email_service

Domain logic for the ponton.io email platform: subscriber lifecycle, token handling, audit/log emission, and retention behavior. This repository intentionally excludes any AWS wiring or infrastructure code.

## Scope
- Subscriber lifecycle: subscribe, confirm, unsubscribe, suppress
- Bounce handling and recovery
- Token generation and validation
- Rendering and tracking behavior
- SES event handling behavior
- Audit event emission (append-only)
- Structured, actionable logging
- Retention and hashing behavior

## Invariants
- ULID identifiers everywhere
- Suppression over deletion
- Plaintext email exists only for PENDING, SUBSCRIBED, and BOUNCED subscribers
- On UNSUBSCRIBED or SUPPRESSED, plaintext email is removed and EMAIL_HASHED is emitted
- Hashed email is computed only on terminal transitions using HMAC-SHA256(normalizedEmail)
- Tokens stored hashed only and never logged
- Unsubscribe and suppression flows are idempotent and never re-emit EMAIL_HASHED
- UNSUBSCRIBED and SUPPRESSED are terminal states with no allowed transitions
- Campaign and delivery records retained indefinitely
- Raw events and application logs retained for 6 months

## Unsubscribe flow
- Handler: `unsubscribeByToken`
- Input: long-lived subscriber token
- Token must be non-empty base64url, be valid, and match exactly one subscriber
- Allowed transitions: SUBSCRIBED → UNSUBSCRIBED, PENDING → UNSUBSCRIBED, BOUNCED → UNSUBSCRIBED
- Idempotency: already UNSUBSCRIBED returns success with no new audit events
- SUPPRESSED rejects unsubscribe (logs only)
- On first transition to UNSUBSCRIBED: remove plaintext email, compute hashedEmail, emit UNSUBSCRIBED and EMAIL_HASHED

## SES event handling
- SES events are authoritative for delivery success, hard bounces, soft bounces, and complaints
- Invalid or missing identifiers are logged with errorCode and do not emit audit or engagement events
- Delivery emits EMAIL_DELIVERED engagement + audit events; if subscriber is BOUNCED, recover to SUBSCRIBED, reset bounceCount, clear lastBounceAt, and emit BOUNCE_RECOVERED
- Hard bounce emits EMAIL_BOUNCED engagement + audit events; SUBSCRIBED or PENDING transitions to BOUNCED, BOUNCED increments bounceCount and updates lastBounceAt
- Soft bounce emits structured logs only (no state change, no audit or engagement events)
- Complaints emit EMAIL_COMPLAINT engagement + audit events; any non-terminal state transitions to SUPPRESSED with SUPPRESSED_COMPLAINT and EMAIL_HASHED
- Engagement events are business signals; audit events are append-only processing records and always separate

## Bounce handling
- State set: PENDING, SUBSCRIBED, BOUNCED, UNSUBSCRIBED, SUPPRESSED
- Hard bounce on delivery moves SUBSCRIBED → BOUNCED and increments bounceCount
- Hard bounce on confirmation email moves PENDING → BOUNCED and increments bounceCount
- Hard bounces increment bounceCount while BOUNCED
- Successful delivery while BOUNCED moves BOUNCED → SUBSCRIBED, resets bounceCount to 0, and clears lastBounceAt
- When bounceCount reaches 3 in a row, subscriber is SUPPRESSED with SUPPRESSED_BOUNCE and EMAIL_HASHED
- Bounce attempts are tracked by attemptNumber only (no campaign context)
- Retry schedule: attempt 1 → +24h from initial send, attempt 2 → +48h from attempt 2 (72h from initial), attempt 3 → no retry
- Soft bounces emit structured logs only (no state change, no audit event)
- Subscriber tracks bounceCount and lastBounceAt for bounce state
- Bounce recovery records the SES delivery confirmation ID in the BOUNCE_RECOVERED audit event

## Tracking handlers
- Handlers are designed for GET tracking endpoints (routing lives in the infra repo).
- `trackClick`: validates campaignId/deliveryId ULIDs and destination URL, emits EMAIL_CLICKED engagement + audit events, logs, and returns a 302 redirect to the destination URL (no-cache).
  - **URL validation required**: Must provide `urlValidationConfig` with `allowedProtocols` (Set), `allowedDomains` (Set), and `allowSubdomains` (boolean)
  - Invalid URLs return 400 Bad Request with specific error codes: `INVALID_PROTOCOL`, `INVALID_DOMAIN`, or `MALFORMED_URL`
- `trackOpen`: gated by openTrackingEnabled. If enabled, validates ULIDs, emits EMAIL_OPENED engagement + audit events, logs, and returns a 1x1 GIF pixel (no-cache). If disabled, returns 204 No Content with logs only.
- Open tracking disabled path short-circuits without identifier validation.
- Invalid identifiers return 400 Bad Request with logs only (errorCode = INVALID_IDENTIFIER, retryable = false).
- Engagement events are business signals; audit events record processing and reference engagementEventId.
- Tracking is observational only and does not mutate subscriber state, retention, or hashing.

## Environment variables
- EMAIL_TOKEN_HMAC_SECRET: HMAC secret for token hashing
- EMAIL_HASH_HMAC_SECRET: HMAC secret for email hashing

## Security

### Trust Boundaries and SES Event Verification

**CRITICAL**: This repository contains domain logic only. Infrastructure-level security validations MUST be performed in the infrastructure layer (`email.ponton.io` repository) before events reach this domain layer.

#### SES Event Signature Verification
- **SES signature verification is NOT performed in this domain layer**
- Signature verification MUST happen in the infrastructure layer (Lambda handler, API Gateway, or SNS subscription)
- The domain layer TRUSTS that all SES events have been cryptographically verified before being passed to domain functions
- Infrastructure implementers MUST validate SES message signatures using AWS SDK or SNS subscription confirmation
- See: https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html

#### Click Tracking URL Validation
- Click tracking includes open redirect prevention via URL validation
- `trackClick` requires a `urlValidationConfig` parameter with:
  - `allowedProtocols`: Set of allowed URL schemes (e.g., `new Set(['https:'])`)
  - `allowedDomains`: Set of allowed destination domains (e.g., `new Set(['example.com'])`)
  - `allowSubdomains`: Boolean to allow/disallow subdomains of allowed domains
- Dangerous schemes (`javascript:`, `data:`, `file:`, `vbscript:`, `about:`) are always rejected
- Invalid URLs return 400 with specific error codes for observability
- Infrastructure layer should populate `allowedDomains` from campaign configuration

#### Token Security
- All tokens use timing-safe comparison via `crypto.timingSafeEqual` to prevent timing attacks
- Tokens are stored as HMAC-SHA256 hashes, never in plaintext
- Token verification is constant-time regardless of validity

#### Email Normalization and IDN Handling
- Email normalization converts internationalized domain names (IDN) to punycode
- Prevents homograph attacks (e.g., Cyrillic 'а' in 'аpple.com')
- Local-part: NFKC normalization + lowercase
- Domain: Automatic punycode conversion via URL constructor + lowercase
- Normalization is idempotent and deterministic

## Domain modules
- `src/domain/email.ts`: email normalization (trim, lowercase, NFKC, IDN/punycode)
- `src/domain/tokens.ts`: token generation, hashing, timing-safe verification
- `src/domain/subscription.ts`: subscribe, confirm, unsubscribe (token-based), suppress workflows
- `src/domain/retention.ts`: plaintext email removal and hashing on UNSUBSCRIBED or SUPPRESSED
- `src/domain/bounce.ts`: bounce handling and retry schedule helpers
- `src/domain/engagement.ts`: engagement event types shared across tracking and SES handlers
- `src/domain/ses.ts`: SES delivery, bounce, and complaint event handling
- `src/domain/tracking.ts`: click/open tracking handlers with URL validation
- `src/domain/audit.ts`: audit event types and append-only emitter
- `src/domain/logging.ts`: structured JSON log helpers

## Logs
All logs are JSON (one object per line) and must include:
- timestamp (ISO-8601 UTC)
- level (debug | info | warn | error)
- requestId
- actorType (SYSTEM | SUBSCRIBER | ADMIN)
- action (short verb, e.g. "subscribe.requested")
- entityType (Subscriber | Campaign | Delivery | Event)
- entityId (ULID)
- outcome (success | failure)

Optional fields: errorCode, retryable, latencyMs.

## Audit events (allow-list)
Subscriber lifecycle:
- SUBSCRIBE_REQUESTED
- SUBSCRIBE_CONFIRMED
- SUBSCRIBER_BOUNCED
- BOUNCE_RECOVERED
- UNSUBSCRIBED
- SUPPRESSED_BOUNCE
- SUPPRESSED_COMPLAINT
- SUPPRESSED_ADMIN

Engagement:
- EMAIL_DELIVERED
- EMAIL_BOUNCED
- EMAIL_COMPLAINT
- EMAIL_CLICKED
- EMAIL_OPENED

System / retention:
- EMAIL_HASHED

## Usage
```ts
import {
  requestSubscription,
  confirmSubscription,
  unsubscribeByToken,
  suppressSubscriber
} from './src/domain/subscription.js';
import { handleHardBounce, handleSoftBounce, recordBounceRecovery } from './src/domain/bounce.js';
import { handleSesEvent } from './src/domain/ses.js';

const subscribe = requestSubscription({
  email: 'user@example.com',
  requestId: 'req-123',
  tokenHmacSecret: process.env.EMAIL_TOKEN_HMAC_SECRET ?? ''
});

// Persist subscribe.subscriber and append subscribe.auditEvents
// Send subscribe.confirmationToken to the user (never log it)

const confirm = confirmSubscription({
  subscriber: subscribe.subscriber,
  confirmationToken: subscribe.confirmationToken,
  requestId: 'req-124',
  tokenHmacSecret: process.env.EMAIL_TOKEN_HMAC_SECRET ?? ''
});

if (confirm.ok) {
  // Persist confirm.subscriber, append confirm.auditEvents, emit confirm.logEntries
}

const unsubscribe = unsubscribeByToken({
  subscriberToken: confirm.ok ? confirm.subscriberToken : subscribe.subscriberToken,
  // subscribers should be the result of a token-hash lookup
  subscribers: confirm.ok ? [confirm.subscriber] : [subscribe.subscriber],
  requestId: 'req-125',
  tokenHmacSecret: process.env.EMAIL_TOKEN_HMAC_SECRET ?? '',
  emailHashHmacSecret: process.env.EMAIL_HASH_HMAC_SECRET ?? ''
});

const suppression = suppressSubscriber({
  subscriber: confirm.ok ? confirm.subscriber : subscribe.subscriber,
  reason: 'BOUNCE',
  requestId: 'req-126',
  emailHashHmacSecret: process.env.EMAIL_HASH_HMAC_SECRET ?? ''
});

const hardBounce = handleHardBounce({
  subscriber: confirm.ok ? confirm.subscriber : subscribe.subscriber,
  attemptNumber: 1,
  requestId: 'req-127',
  emailHashHmacSecret: process.env.EMAIL_HASH_HMAC_SECRET ?? ''
});

const softBounce = handleSoftBounce({
  subscriber: confirm.ok ? confirm.subscriber : subscribe.subscriber,
  attemptNumber: 1,
  requestId: 'req-128',
  emailHashHmacSecret: process.env.EMAIL_HASH_HMAC_SECRET ?? ''
});

const recovery = recordBounceRecovery({
  subscriber: confirm.ok ? confirm.subscriber : subscribe.subscriber,
  deliveryId: '01HZXZ3Q6E7B2Q2Y7N5H2G0K3P',
  requestId: 'req-129'
});

const sesDelivery = handleSesEvent({
  eventType: 'DELIVERY',
  subscriber: confirm.ok ? confirm.subscriber : subscribe.subscriber,
  campaignId: '01HZXZ3Q6E7B2Q2Y7N5H2G0K3Q',
  deliveryId: '01HZXZ3Q6E7B2Q2Y7N5H2G0K3R',
  requestId: 'req-130',
  emailHashHmacSecret: process.env.EMAIL_HASH_HMAC_SECRET ?? ''
});

// Click tracking with URL validation (prevents open redirects)
import { trackClick } from './src/domain/tracking.js';

const clickResult = trackClick({
  campaignId: '01HZXZ3Q6E7B2Q2Y7N5H2G0K3A',
  deliveryId: '01HZXZ3Q6E7B2Q2Y7N5H2G0K3B',
  destinationUrl: 'https://example.com/product',
  urlValidationConfig: {
    allowedProtocols: new Set(['https:']), // Only allow HTTPS
    allowedDomains: new Set(['example.com', 'trusted.com']), // Allowed domains
    allowSubdomains: true // Allow www.example.com, etc.
  },
  requestId: 'req-click-1'
});

if (clickResult.ok) {
  // Redirect with 302 to destinationUrl
  // Emit clickResult.engagementEvents and clickResult.auditEvents
} else {
  // Log clickResult.logEntries with specific error code
  // Return 400 Bad Request
}
```

## Handover
See `handover.md` for a full project synopsis and an infrastructure integration checklist for the `email.ponton.io` repo.

## Breaking Changes

**For detailed migration guidance, see [MIGRATION.md](./MIGRATION.md)**.

### URL Validation Configuration (v2.0.0)
The `trackClick` function now requires URL validation configuration to prevent open redirect attacks:

**Before:**
```ts
trackClick({
  campaignId,
  deliveryId,
  destinationUrl,
  requestId
});
```

**After:**
```ts
trackClick({
  campaignId,
  deliveryId,
  destinationUrl,
  urlValidationConfig: {
    allowedProtocols: new Set(['https:']),
    allowedDomains: new Set(['example.com']),
    allowSubdomains: true
  },
  requestId
});
```

The configuration uses `Set<string>` for O(1) lookup performance and explicit control over allowed protocols and domains.

## Tests
- `npm test`
- `npm run typecheck`
- Bounce tests cover invalid-state handling (including recovery), consecutive bounce counts, and lastBounceAt tracking.
- SES event tests cover delivery recovery, hard bounce escalation, complaint suppression, soft bounce logging, and idempotent repeats.
- Tracking tests cover click/open handlers, invalid identifiers, and open-tracking gating.

## Repository hygiene
`.gitignore` excludes dependencies, build artifacts, test output, logs, and local environment files.

## Review guidance
`CLAUDE.md` describes the code review scope for Claude.
