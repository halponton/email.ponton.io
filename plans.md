# plans.md — email.ponton.io

## Goal
Wire email behaviour to AWS safely.

## Milestones
- ✅ Domains and API Gateway
- ✅ DynamoDB tables and GSIs
- ✅ Secrets Manager and SSM
- ✅ SES configuration
- ✅ Cognito for admin APIs
- ✅ Observability and retention jobs

## Milestone 6: Observability and Retention Jobs (Complete)

Implemented Phase 1 (MVP) and Phase 2 (Production Hardening) from architecture plan.

### Observability Stack Components:
1. **CloudWatch Dashboard** - Comprehensive metrics visualization
   - API Gateway metrics (requests, latency, errors)
   - Lambda metrics (invocations, errors, duration, throttles)
   - SES metrics (sends, deliveries, bounces, complaints)
   - SQS metrics (queue depth, DLQ messages)
   - DynamoDB metrics (read/write capacity, throttles)

2. **CloudWatch Alarms** - Critical operational alerts
   - DLQ Depth (SES event processing failures)
   - Lambda Error Rate (application errors)
   - API 5xx Errors (server errors)
   - SES Bounce Rate (deliverability issues)
   - SES Complaint Rate (spam complaints)
   - System Health (composite alarm)

3. **SNS Topic** - Alarm notifications via email
   - Email subscriptions per environment
   - Requires manual confirmation after deployment

4. **Log Sanitization** - PII protection (CRITICAL)
   - Utility: `lib/utils/log-sanitization.ts`
   - NEVER logs: email, firstName, tokens, secrets
   - ONLY logs: ULIDs, action verbs, outcome status
   - Used throughout all Lambda handlers

5. **API Gateway Access Logging**
   - JSON-formatted logs for all requests
   - 180-day retention per platform invariants
   - Authorization headers excluded (JWT protection)

6. **Lambda Log Retention**
   - All Lambda functions: 180-day retention
   - Automatic enforcement via CDK

7. **CloudWatch Custom Metrics**
   - SES events (namespace: email.ponton.io/{env})
   - Dimensioned by event type
   - Published from ses-event-handler

### Retention Verification:
- ✅ DynamoDB TTL enabled on EngagementEvents table (6-month retention)
- ✅ All log groups configured with 180-day retention
- ✅ Automatic deletion after retention period

### Security Implementation:
- ✅ Log sanitization prevents PII exposure
- ✅ CloudWatch metrics use least privilege IAM
- ✅ SNS topic restricted to CloudWatch alarms
- ✅ Access logs exclude Authorization headers

### What Retention Does:
- Purges raw engagement events after 6 months (TTL)
- Enforces CloudWatch log retention (180 days)
- Automatic deletion (no manual jobs required)

### What Retention Does NOT Do:
- Modify subscriber records
- Modify campaign metadata
- Modify delivery records
- Modify audit events

## Definition of done
- All resources environment-scoped
- SES events ingested
- README.md fully updated
