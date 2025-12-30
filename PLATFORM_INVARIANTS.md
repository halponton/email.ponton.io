# ponton.io Newsletter Platform Invariants

This document is the source of truth for platform-wide rules. Repo-level docs must not contradict it.

## 1. Repositories and responsibilities

### ponton.io_email_service
Owns domain behaviour:
- Subscriber lifecycle (subscribe / confirm / unsubscribe / suppress)
- Token generation and validation
- Email rendering and link rewriting
- Click and open tracking behaviour
- SES event handling behaviour
- Audit and event emission semantics
- Retention behaviour, including email hashing

Must not contain:
- IAM configuration
- API Gateway configuration
- SES identities or event destinations
- DNS / ACM / Route53
- UI code

### email.ponton.io
Owns AWS infrastructure and wiring:
- API Gateway routes (public and admin)
- Lambda wiring and environment configuration
- DynamoDB tables and GSIs
- SNS/SQS pipelines for SES events
- SES identities and configuration
- Secrets Manager and SSM parameters
- Cognito (admin auth)
- Route53 and ACM
- Observability and retention wiring

Must not contain:
- Domain behaviour logic
- UI code

### mailer.ponton.io
Owns the admin UI:
- Shadcn UI dashboard
- Cognito authentication and role gating
- Campaign tooling UX
- Analytics UX
- Subscriber lookup and suppression UX

Must not contain:
- Email delivery logic
- Subscriber lifecycle logic

## 2. Identifier strategy
- All primary identifiers are ULIDs.
- ULIDs are opaque and stable.
- Email addresses must never be identifiers.

## 3. Environments
- Exactly two environments: dev and prod.
- Single AWS account.
- SES sandbox in dev.
- Distinct secrets and parameters per environment.
- Environment-scoped domains: prod uses the canonical API domain, dev uses a prefixed subdomain
  (e.g., prod `api.email.ponton.io`, dev `api-dev.email.ponton.io`).

## 4. Secrets and configuration
- No hardcoded secrets, ever.
- Secrets live in AWS Secrets Manager.
- Non-secret configuration lives in SSM Parameter Store.
- .env files are local-only and never committed.

## 5. Authentication
- Humans authenticate via Cognito.
- Services use IAM or API keys stored in Secrets Manager.

## 6. APIs and versioning
- Public endpoints are versioned.
- Admin APIs are unversioned initially but stable.

## 7. PII policy
Allowed PII:
- firstName
- email (plaintext only within retention window)

## 8. Subscriber states

The allowed subscriber states are:

- PENDING        — email submitted, awaiting confirmation
- SUBSCRIBED     — confirmed and eligible to receive email
- BOUNCED        — delivery temporarily unsafe, retry policy active
- UNSUBSCRIBED   — user opted out (terminal)
- SUPPRESSED     — permanently blocked (terminal)

## 9. Suppression vs deletion
- Subscribers are never deleted.
- Terminal states are UNSUBSCRIBED and SUPPRESSED.


## 10 Plaintext email retention and hashing

Plaintext email retention is state-based.

Plaintext email is retained only while the subscriber is in:
- PENDING
- SUBSCRIBED
- BOUNCED

Plaintext email is removed immediately, and hashedEmail is stored, on
transition to either terminal state:
- UNSUBSCRIBED
- SUPPRESSED

Plaintext email must never exist for terminal subscribers.

- On transition to UNSUBSCRIBED or SUPPRESSED:
  - Plaintext email is removed immediately.
  - hashedEmail is computed and stored using HMAC-SHA256.
  - An EMAIL_HASHED audit event is emitted.

Plaintext email must never exist for UNSUBSCRIBED or SUPPRESSED subscribers.

Reintroduction of plaintext email requires a fresh subscribe flow.

## 11. Data retention classes

The platform distinguishes between business records and operational telemetry.

Retained indefinitely:
- Subscriber records (without plaintext email post-unsubscribe)
- Audit events
- Campaign metadata
- Delivery records
- Aggregated campaign statistics

Retained for 6 months only:
- Raw engagement events (clicks, opens, delivery events)
- Application logs and debug telemetry

Operational data expiry must not affect historical campaign metrics.

## 12. Development order
1. ponton.io_email_service
2. email.ponton.io
3. mailer.ponton.io

## 13. Documentation discipline
- README.md is canonical in every repo.
- Any change requires README.md updates.

## 14. Bounced state semantics

BOUNCED represents a temporary delivery failure caused by infrastructure,
mailbox, or DNS issues. It is not a terminal state.

While in BOUNCED:
- Plaintext email may be retained.
- Delivery retries are allowed per the retry policy.
- Successful delivery transitions the subscriber back to SUBSCRIBED.

## 15. Bounce retry policy (invariant)

Hard bounces trigger the BOUNCED state.

Subscribers in BOUNCED are retried up to 3 attempts per campaign

The delivery should be attempted 3 times based on the following states:
- Initial Attempt
- After 24 hours from initial attempt
- After 48 hours from the second attempt (72 hours from initial attempt)

After sustained failure (ie. attempt 3), the subscriber is transitioned to SUPPRESSED.

## 16. Security and Trust Boundaries

### Repository Responsibility Separation

The platform maintains strict separation between domain logic and infrastructure security:

**ponton.io_email_service (domain layer)**:
- Contains pure business logic
- TRUSTS that all inputs have been validated by infrastructure layer
- Does NOT perform cryptographic signature verification of AWS events
- Does NOT validate AWS credentials or IAM policies
- MUST document trust assumptions clearly

**email.ponton.io (infrastructure layer)**:
- MUST validate all SES event signatures before passing to domain layer
- MUST verify SNS message signatures using AWS SDK
- MUST enforce IAM policies and API Gateway authorization
- MUST sanitize and validate all external inputs
- Acts as the security perimeter

### SES Event Verification

**CRITICAL INVARIANT**: SES event signature verification MUST occur in the infrastructure layer.

The domain layer (`ponton.io_email_service`) TRUSTS that:
- All SES events have valid cryptographic signatures
- SNS message signatures have been verified
- Event payloads have not been tampered with
- Events originated from AWS SES

Infrastructure implementers MUST:
- Validate SNS message signatures per AWS documentation
- Use SNS subscription confirmation to establish trust
- Reject events with invalid signatures before domain processing
- See: https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html

### Domain Layer Security Responsibilities

While the domain layer trusts infrastructure validation, it MUST:
- Validate business-level inputs (ULID format, state transitions, etc.)
- Prevent open redirect attacks via URL validation in click tracking
- Use timing-safe comparison for token verification
- Normalize emails to prevent homograph attacks (IDN/punycode)
- Never log secrets or sensitive tokens
- Maintain audit trail of all state changes

This separation allows:
- Domain logic to remain infrastructure-agnostic and testable
- Infrastructure layer to evolve security controls independently
- Clear accountability for security responsibilities
- Simplified testing (domain tests don't need AWS credentials)
