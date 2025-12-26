# Handover: ponton.io_email_service

This repository contains the email domain logic only. It is intentionally infrastructure-agnostic and is designed to be wired into the `email.ponton.io` infra repo (API Gateway, Lambda, DynamoDB, SES/SNS/SQS, Secrets Manager, etc).

## Purpose and boundaries
- Owns subscriber lifecycle behavior, token logic, tracking behavior, SES event handling behavior, audit events, and retention/hashing rules.
- Does not include any AWS wiring, IAM, database schemas, or network configuration.
- Treats the infrastructure layer as the security perimeter; all SES/SNS signatures must be verified before input reaches this code.

## Source-of-truth docs
- `README.md` - Canonical behavior summary and usage examples.
- `PLATFORM_INVARIANTS.md` - Non-negotiable invariants across the platform.
- `MIGRATION.md` - Infra migration guide (notably click URL validation).
- `SECURITY_FIXES_SUMMARY.md` - Security fixes and tests overview.
- `plans.md` - Original scope and definition of done.

## Critical invariants (do not violate)
- All identifiers are ULIDs. Email is never an identifier.
- Suppression over deletion. UNSUBSCRIBED and SUPPRESSED are terminal.
- BOUNCED is non-terminal and recoverable. Never treat BOUNCED as SUPPRESSED.
- Plaintext email exists only for PENDING, SUBSCRIBED, and BOUNCED.
- On UNSUBSCRIBED or SUPPRESSED: remove plaintext email, compute hashedEmail (HMAC-SHA256), emit EMAIL_HASHED.
- Audit events must be emitted for all state changes.
- Logs must be structured JSON entries with required fields (see `src/domain/logging.ts`).

## Domain model (key fields)
Subscriber: `id`, `state`, `email`, `emailNormalized`, `hashedEmail`, `bounceCount`, `lastBounceAt`, `tokens`, `createdAt`, `updatedAt`, `confirmedAt`, `unsubscribedAt`, `suppressedAt`.

States: PENDING -> SUBSCRIBED/BOUNCED/UNSUBSCRIBED/SUPPRESSED, SUBSCRIBED -> BOUNCED/UNSUBSCRIBED/SUPPRESSED, BOUNCED -> SUBSCRIBED/UNSUBSCRIBED/SUPPRESSED. UNSUBSCRIBED and SUPPRESSED are terminal.

## Module map (entry points)
- `src/domain/subscription.ts` - subscribe, confirm, unsubscribe, suppress flows.
- `src/domain/bounce.ts` - hard/soft bounce handling, retry timing helper, recovery.
- `src/domain/ses.ts` - SES delivery/bounce/complaint handling and engagement events.
- `src/domain/tracking.ts` - click/open tracking handlers with URL validation.
- `src/domain/retention.ts` - plaintext removal + hashing on terminal transitions.
- `src/domain/tokens.ts` - token issue, hash, validation, timing-safe verification.
- `src/domain/email.ts` - email normalization with IDN/punycode handling.
- `src/domain/audit.ts` and `src/domain/logging.ts` - audit events + structured logs.
- `src/domain/ids.ts` - ULID helpers.

## Core workflows (what infra must wire)
1) Subscribe
- Call `requestSubscription` with email + requestId.
- Persist subscriber + append audit events + emit logs.
- Send confirmation token (never log).

2) Confirm
- Call `confirmSubscription` with subscriber + confirmation token.
- On success: state transitions to SUBSCRIBED, confirmation token is marked used, subscriber token is rotated.
- Persist changes + append audit + logs.

3) Unsubscribe (token-based)
- Infra looks up subscriber candidates by token hash then calls `unsubscribeByToken`.
- Idempotent for already-UNSUBSCRIBED; SUPPRESSED rejects.
- Applies retention (plaintext removed, hashedEmail computed, EMAIL_HASHED emitted).

4) Suppress
- `suppressSubscriber` with reason BOUNCE, COMPLAINT, or ADMIN.
- Always triggers retention logic and emits EMAIL_HASHED on first transition.

5) SES events
- Use `handleSesEvent` for DELIVERY, BOUNCE (HARD/SOFT), COMPLAINT.
- Delivery emits engagement + audit; if subscriber is BOUNCED it recovers to SUBSCRIBED.
- Hard bounce updates bounceCount and may suppress at threshold (3).
- Soft bounce emits structured logs only (no state change).
- Complaint suppresses and emits EMAIL_HASHED.

6) Tracking
- `trackClick` validates ULIDs, validates URL with allowlists, and returns a 302 response.
- `trackOpen` returns 204 when open tracking is disabled; otherwise emits engagement + audit and returns the tracking pixel.

## Security and validation responsibilities
- Infrastructure must verify SES/SNS message signatures before calling domain functions.
- Click tracking requires `urlValidationConfig` with allowed protocols and domains.
- Token comparison is timing-safe; token hashes are stored, never raw tokens.
- Email normalization uses NFKC + punycode conversion to prevent homograph attacks.

## Audit events and logging
- Audit events are append-only; engagement events and audit events are separate.
- Required log fields: timestamp, level, requestId, actorType, action, entityType, entityId, outcome.
- Use `createJsonLogWriter` to emit JSON log lines.

## Retention and hashing
- Apply `applyEmailRetention` on UNSUBSCRIBED or SUPPRESSED.
- Always emit EMAIL_HASHED the first time plaintext is removed.
- Plaintext email should never exist for terminal states.

## Environment variables
- `EMAIL_TOKEN_HMAC_SECRET` - token hashing and verification.
- `EMAIL_HASH_HMAC_SECRET` - email hashing on retention.

## Testing
- Unit tests live in `test/` with Vitest.
- Commands: `npm test`, `npm run test:run`, `npm run typecheck`.

## Infra build checklist for email.ponton.io
- Implement persistence for Subscriber, AuditEvent, EngagementEvent, Delivery, Campaign records.
- Perform SES/SNS signature verification before calling `handleSesEvent`.
- Map API endpoints to domain functions (subscribe, confirm, unsubscribe, track click/open).
- Provide URL allowlist config per campaign to `trackClick`.
- Ensure logs are emitted as JSON and shipped to your logging sink.
- Ensure all state changes append audit events and emit logs.
- Enforce ULID validation for all identifiers at the edge.
