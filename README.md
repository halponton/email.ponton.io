# email.ponton.io - AWS Infrastructure

AWS CDK infrastructure for the email.ponton.io newsletter platform.

This repository owns AWS infrastructure and wiring per **PLATFORM_INVARIANTS.md** section 1.

## Repository Responsibilities

Per platform invariants, this repository owns:

- API Gateway routes (public and admin)
- Lambda wiring and environment configuration
- DynamoDB tables and GSIs
- SNS/SQS pipelines for SES events
- SES identities and configuration
- Secrets Manager and SSM parameters
- Cognito (admin auth)
- Route53 and ACM
- Observability and retention wiring

This repository **must not** contain:
- Domain behaviour logic (lives in `ponton.io_email_service`)
- UI code (lives in `newsletter.ponton.io`)

## Architecture

### Environments

Per **PLATFORM_INVARIANTS.md** section 3:
- **Two environments only**: `dev` and `prod`
- Single AWS account
- SES sandbox mode in dev
- All resources environment-scoped (prefixed with `dev-` or `prod-`)
- Environment-scoped domains: prod uses `api.email.ponton.io`, dev uses `api-dev.email.ponton.io`

### Current Implementation Status

**Milestone 1: Domains and API Gateway** ✅ Complete
- ACM certificates for environment-scoped API domains:
  - Dev: `api-dev.email.ponton.io`
  - Prod: `api.email.ponton.io`
- API Gateway HTTP API with custom domain
- Route53 alias records
- Health check endpoint at `/v1/health`
- Placeholder routes returning 501 Not Implemented
- Admin route authorization (placeholder blocking all access until Milestone 5)

**Milestone 2: DynamoDB Tables and GSIs** ✅ Complete
- 5 DynamoDB tables with all GSIs:
  - Subscribers (4 GSIs: EmailHashIndex, ConfirmTokenIndex, UnsubscribeTokenIndex, StateIndex)
  - AuditEvents (1 GSI: SubscriberEventsIndex)
  - EngagementEvents (2 GSIs: SubscriberEngagementIndex, CampaignEngagementIndex) with 6-month TTL
  - Campaigns (1 GSI: StatusIndex)
  - Deliveries (3 GSIs: CampaignDeliveriesIndex, SubscriberDeliveriesIndex, StatusIndex)
- Customer Managed Keys (CMK) for encryption at rest (Subscribers, AuditEvents, Campaigns, Deliveries)
- Point-in-Time Recovery enabled for prod tables
- Deletion protection enabled for prod tables
- IAM permissions for handler functions (placeholders currently have no DynamoDB access; permissions added with real handlers)
- Table-name environment variables for handler functions (placeholders currently omit these; added with real handlers)

**Milestone 3: Secrets Manager and SSM** ✅ Complete
- AWS Secrets Manager for HMAC secrets (token generation, email hashing)
- SSM Parameter Store for non-secret configuration (SES, API, tracking, retention)
- Dedicated CMK for Secrets Manager encryption
- Environment-scoped naming (/{env}/email/* for secrets, /email/{env}/* for parameters)
- RemovalPolicy.RETAIN for prod secrets/parameters
- Secrets generated automatically at deployment time
- 7 SSM parameters for SES config, API config, tracking config, and retention config

**Future Milestones:**
- Milestone 4: SES configuration
- Milestone 5: Cognito for admin APIs
- Milestone 6: Observability and retention jobs

### API Routes

#### Public API (v1)

| Method | Path | Status | Description |
|--------|------|--------|-------------|
| GET | `/v1/health` | ✅ Implemented | Health check endpoint |
| POST | `/v1/subscribe` | 🚧 Placeholder | Subscribe to newsletter |
| GET | `/v1/confirm` | 🚧 Placeholder | Confirm subscription via token |
| POST | `/v1/unsubscribe` | 🚧 Placeholder | Unsubscribe from newsletter |
| GET | `/v1/track/open/{token}` | 🚧 Placeholder | Track email opens |
| GET | `/v1/track/click/{token}` | 🚧 Placeholder | Track link clicks |

#### Admin API

| Method | Path | Status | Description |
|--------|------|--------|-------------|
| POST | `/admin/campaigns` | 🔒 Blocked | Create campaign |
| GET | `/admin/campaigns/{id}` | 🔒 Blocked | Get campaign details |
| POST | `/admin/campaigns/{id}/send` | 🔒 Blocked | Send campaign |
| GET | `/admin/subscribers` | 🔒 Blocked | List subscribers |
| POST | `/admin/subscribers/{id}/suppress` | 🔒 Blocked | Suppress subscriber |

🚧 = Returns 501 Not Implemented (infrastructure in place, handler pending)
🔒 = Returns 401 Unauthorized (admin authentication not yet configured - Milestone 5)
Admin routes are blocked by a deny-all Lambda authorizer (simple response), so API Gateway returns 401 without a JSON body.

## Prerequisites

- **Node.js**: 20.x or later
- **AWS CLI**: Configured with credentials
- **AWS CDK**: 2.125.0 or later
- **TypeScript**: 5.3.x
- **AWS Account**: Single account with Route53 hosted zone for `ponton.io`

### AWS Permissions Required

The deploying IAM user/role needs permissions for:
- CloudFormation (create/update/delete stacks)
- ACM (certificate management)
- API Gateway v2 (HTTP APIs)
- Lambda (function management)
- Route53 (DNS records)
- IAM (role creation for Lambda)
- CloudWatch Logs (log group management)
- DynamoDB (table and GSI management)
- KMS (key creation and management for encryption)
- Secrets Manager (secret creation and management)
- SSM Parameter Store (parameter creation and management)

## Installation

```bash
# Install dependencies
npm install

# Bootstrap CDK (first time only, per environment)
npx cdk bootstrap --context environment=dev

# Verify TypeScript compilation
npm run build
```

## Configuration

Environment configuration is in `lib/config/environments.ts`:

```typescript
// Dev environment
{
  env: 'dev',
  region: 'eu-west-2',
  apiDomain: 'api-dev.email.ponton.io',
  sesSandbox: true,
  hostedZoneName: 'ponton.io',
  enableDetailedMonitoring: false,
  dynamodb: {
    enablePointInTimeRecovery: false,  // Cost optimization
    enableDeletionProtection: false,   // Development flexibility
  },
  secrets: {
    retainOnDelete: false,             // Clean deletion for dev
  },
}

// Prod environment
{
  env: 'prod',
  region: 'eu-west-2',
  apiDomain: 'api.email.ponton.io',
  sesSandbox: false,
  hostedZoneName: 'ponton.io',
  enableDetailedMonitoring: true,
  dynamodb: {
    enablePointInTimeRecovery: true,   // Data protection
    enableDeletionProtection: true,    // Prevent accidental deletion
  },
  secrets: {
    retainOnDelete: true,              // Prevent accidental secret deletion
  },
}
```

## Development Workflow

### Synthesize CloudFormation Templates

```bash
# Synthesize dev environment
npm run synth:dev

# Synthesize prod environment
npm run synth:prod
```

### View Changes (Diff)

```bash
# Compare local changes with deployed dev stack
npm run diff:dev

# Compare local changes with deployed prod stack
npm run diff:prod
```

### Deploy Infrastructure

```bash
# Deploy to dev environment
npm run deploy:dev

# Deploy to prod environment (requires approval for IAM changes)
npm run deploy:prod
```

### Stack Outputs

After deployment, important values are exported:

```bash
# Dev environment
aws cloudformation describe-stacks \
  --stack-name dev-email-certificate \
  --query 'Stacks[0].Outputs'

aws cloudformation describe-stacks \
  --stack-name dev-email-api-gateway \
  --query 'Stacks[0].Outputs'
```

Key outputs:
- `CertificateArn`: ACM certificate ARN
- `ApiUrl`: API Gateway endpoint URL
- `CustomDomainUrl`: Custom domain URL (https://api-dev.email.ponton.io or https://api.email.ponton.io)
- `HealthCheckUrl`: Health check endpoint URL
- `SubscribersTableName`, `SubscribersTableArn`: Subscribers table details
- `AuditEventsTableName`, `AuditEventsTableArn`: AuditEvents table details
- `EngagementEventsTableName`, `EngagementEventsTableArn`: EngagementEvents table details
- `CampaignsTableName`, `CampaignsTableArn`: Campaigns table details
- `DeliveriesTableName`, `DeliveriesTableArn`: Deliveries table details
- `EncryptionKeyId`, `EncryptionKeyArn`: KMS key for DynamoDB encryption
- `TokenHmacSecretArn`, `TokenHmacSecretName`: Token HMAC secret
- `EmailHashHmacSecretArn`, `EmailHashHmacSecretName`: Email hash HMAC secret
- `SesVerifiedDomainParameter`, `SesFromEmailParameter`, `SesFromNameParameter`: SES configuration parameters
- `ApiBaseUrlParameter`, `ClickRedirectBaseUrlParameter`, `OpenPixelBaseUrlParameter`: API and tracking parameters
- `EngagementTtlDaysParameter`: Engagement events TTL configuration

## Testing

### Infrastructure Unit Tests

Run CDK assertions tests for DynamoDB table configuration:

```bash
npm test
```

These tests validate table counts, GSIs, TTL configuration, deletion protection, and PITR settings.

### Health Check Endpoint

After deployment, test the health check:

```bash
# Dev environment - using custom domain (requires DNS propagation)
curl https://api-dev.email.ponton.io/v1/health

# Prod environment - using custom domain (requires DNS propagation)
curl https://api.email.ponton.io/v1/health

# Using API Gateway URL (immediate, works for both environments)
curl https://{api-id}.execute-api.eu-west-2.amazonaws.com/v1/health
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2025-12-26T12:00:00.000Z",
  "environment": "dev",
  "service": "email.ponton.io",
  "version": "0.1.0"
}
```

### Placeholder Routes

Public API routes (except /v1/health) return 501 Not Implemented:

```bash
curl -X POST https://api-dev.email.ponton.io/v1/subscribe

# Response:
# {
#   "error": "Not Implemented",
#   "message": "Endpoint POST /v1/subscribe is not yet implemented...",
#   "timestamp": "2025-12-26T12:00:00.000Z"
# }
```

### Admin Routes

All admin routes return 401 Unauthorized (authentication not yet configured):

```bash
curl -X GET https://api-dev.email.ponton.io/admin/campaigns

# Response: 401 Unauthorized
# Admin routes are blocked until Cognito implementation in Milestone 5
```

## Project Structure

```
email.ponton.io/
├── README.md                     # This file
├── PLATFORM_INVARIANTS.md        # Platform-wide rules (source of truth)
├── plans.md                      # Milestone plan
├── agents.md                     # Agent guidelines
├── package.json                  # NPM dependencies
├── tsconfig.json                 # TypeScript configuration
├── cdk.json                      # CDK configuration
├── .gitignore                    # Git ignore rules
│
├── bin/
│   └── email-infra.ts           # CDK app entry point
│
├── lib/
│   ├── config/
│   │   └── environments.ts      # Environment configuration (dev/prod)
│   │
│   ├── stacks/
│   │   ├── certificate-stack.ts # ACM certificate stack
│   │   ├── dynamodb-stack.ts    # DynamoDB tables stack
│   │   ├── secrets-stack.ts     # Secrets Manager and SSM parameters stack
│   │   └── api-gateway-stack.ts # API Gateway and routes stack
│   │
│   ├── constructs/
│   │   ├── lambda-function.ts   # Standardized Lambda construct
│   │   ├── api-routes.ts        # API Gateway routes construct
│   │   ├── dynamodb-tables.ts   # DynamoDB tables construct
│   │   ├── secrets.ts           # Secrets Manager construct
│   │   └── ssm-parameters.ts    # SSM Parameter Store construct
│   │
│   └── handlers/
│       ├── health.ts            # Health check handler
│       ├── not-implemented.ts   # Placeholder handler (501)
│       └── admin-authorizer.ts  # Placeholder admin authorizer (401)
│
└── ponton.io_email_service/     # Domain logic (separate repo)
```

## Stack Dependencies

```
dev-email-certificate ───────┐
dev-email-dynamodb ──────────┼──> dev-email-api-gateway
dev-email-secrets ───────────┘
```

Stack dependencies:
- **API Gateway Stack** depends on:
  - Certificate stack (for ACM certificate and Route53 hosted zone)
  - DynamoDB stack (for table references and IAM permissions)
  - Secrets stack (for secrets and parameters access)

Certificate, DynamoDB, and Secrets stacks can be deployed in parallel.
API Gateway stack must be deployed last (depends on all others).

## Environment Variables

Lambda functions receive standard environment variables:

- `ENVIRONMENT`: `dev` or `prod`
- `REGION`: AWS region (eu-west-2)
- `LOG_LEVEL`: `DEBUG` (dev) or `INFO` (prod)

Planned DynamoDB table name variables (for handler functions; placeholder Lambdas do not include these yet):

- `SUBSCRIBERS_TABLE`: Subscribers table name
- `AUDIT_EVENTS_TABLE`: AuditEvents table name
- `ENGAGEMENT_EVENTS_TABLE`: EngagementEvents table name
- `CAMPAIGNS_TABLE`: Campaigns table name
- `DELIVERIES_TABLE`: Deliveries table name

## DynamoDB Tables

### Data Model

The platform uses 5 DynamoDB tables aligned with **PLATFORM_INVARIANTS.md** data retention classes:

**Business Records (Retained Indefinitely):**

1. **Subscribers** - Subscriber lifecycle and PII
   - Primary Key: `subscriberId` (ULID)
   - GSIs: EmailHashIndex, ConfirmTokenIndex, UnsubscribeTokenIndex, StateIndex
   - Encryption: Customer Managed Key (CMK)
   - PITR: Enabled in prod
   - Critical: Plaintext email removed on transition to UNSUBSCRIBED/SUPPRESSED per platform invariants section 10

2. **AuditEvents** - Immutable audit trail
   - Primary Key: `eventId` (ULID)
   - GSI: SubscriberEventsIndex
   - Encryption: Customer Managed Key (CMK)
   - PITR: Enabled in prod

3. **Campaigns** - Campaign metadata and content
   - Primary Key: `campaignId` (ULID)
   - GSI: StatusIndex
   - Encryption: Customer Managed Key (CMK)
   - PITR: Enabled in prod

4. **Deliveries** - Individual delivery records
   - Primary Key: `deliveryId` (ULID)
   - GSIs: CampaignDeliveriesIndex, SubscriberDeliveriesIndex, StatusIndex
   - Encryption: Customer Managed Key (CMK)
   - PITR: Enabled in prod

**Operational Telemetry (6-Month Retention):**

5. **EngagementEvents** - Click/open tracking events
   - Primary Key: `eventId` (ULID)
   - GSIs: SubscriberEngagementIndex, CampaignEngagementIndex
   - Encryption: AWS Managed Key
   - TTL: Enabled on `expiresAt` attribute (6 months)
   - PITR: Disabled (operational data)
   - Deletion protection: Enabled in prod; disabled in dev

### Security Architecture

**Encryption at Rest:**
- Subscribers, AuditEvents, Campaigns, Deliveries: Customer Managed Key (CMK) with automatic key rotation
- EngagementEvents: AWS Managed Key (operational telemetry, not business records)

**GSI Security - NO Plaintext PII:**
- Email lookups use `emailNormalizedHash` (HMAC-SHA256) - NOT plaintext email
- Token GSIs (ConfirmTokenIndex, UnsubscribeTokenIndex) use KEYS_ONLY projection
- State-based GSIs use KEYS_ONLY projection to prevent PII exposure in scans

**Data Protection:**
- Point-in-Time Recovery (PITR) enabled for prod business records
- Deletion protection enabled for prod tables
- Dev tables: PITR and deletion protection disabled for cost optimization and flexibility

**Email Hashing Strategy:**
- The domain layer (ponton.io_email_service) is responsible for computing `emailNormalizedHash`
- Hash algorithm: HMAC-SHA256 with secret key (prevents rainbow table attacks)
- Hash is deterministic for duplicate prevention but requires secret key
- Infrastructure layer defines schema; domain layer owns hashing logic

## Secrets Management

### Overview

Per **PLATFORM_INVARIANTS.md** section 4:
- No hardcoded secrets, ever
- Secrets live in AWS Secrets Manager
- Non-secret configuration lives in SSM Parameter Store
- Distinct secrets and parameters per environment

### Secrets (AWS Secrets Manager)

**Token HMAC Secret** (`/{env}/email/token-hmac-secret`):
- For generating and validating secure tokens (confirm, unsubscribe)

**Email Hash HMAC Secret** (`/{env}/email/email-hash-hmac-secret`):
- For deterministic email hashing (duplicate prevention)

Features:
- Dedicated CMK encryption for Secrets Manager
- CloudTrail logging enabled
- RemovalPolicy.RETAIN for prod
- Secrets are generated automatically at deployment time

### SSM Parameters (AWS Systems Manager Parameter Store)

**SES Configuration:**
- `/email/{env}/ses/verified-domain`: SES verified domain (email.ponton.io)
- `/email/{env}/ses/from-email`: Default from email address
- `/email/{env}/ses/from-name`: Default from display name

**API Configuration:**
- `/email/{env}/api/base-url`: API base URL for generating links

**Tracking Configuration:**
- `/email/{env}/tracking/click-redirect-base-url`: Base URL for click tracking
- `/email/{env}/tracking/open-pixel-base-url`: Base URL for open tracking

**Retention Configuration:**
- `/email/{env}/retention/engagement-ttl-days`: Engagement events TTL (180 days)

### Secret Verification and Rotation

```bash
# Dev environment - token HMAC secret
aws secretsmanager get-secret-value \
  --secret-id /dev/email/token-hmac-secret \
  --region eu-west-2 \
  --query 'SecretString' \
  --output text

# Dev environment - email hash HMAC secret
aws secretsmanager get-secret-value \
  --secret-id /dev/email/email-hash-hmac-secret \
  --region eu-west-2 \
  --query 'SecretString' \
  --output text
```

Rotate secrets as needed:

```bash
TOKEN_SECRET=$(openssl rand -base64 32)
EMAIL_SECRET=$(openssl rand -base64 32)

aws secretsmanager put-secret-value \
  --secret-id /dev/email/token-hmac-secret \
  --secret-string "$TOKEN_SECRET" \
  --region eu-west-2

aws secretsmanager put-secret-value \
  --secret-id /dev/email/email-hash-hmac-secret \
  --secret-string "$EMAIL_SECRET" \
  --region eu-west-2
```

Security requirements:
- Each secret MUST be at least 32 bytes (256 bits) of cryptographically secure random data
- Dev and prod MUST use different secret values
- Do NOT commit secrets to version control
- Rotate secrets periodically (recommended: annually)

### Updating SSM Parameters

SSM parameters can be updated without redeploying the stack:

```bash
# Update SES from email (dev)
aws ssm put-parameter \
  --name /email/dev/ses/from-email \
  --value "newsletter-dev@email.ponton.io" \
  --type String \
  --overwrite \
  --region eu-west-2

# Update engagement TTL days (prod)
aws ssm put-parameter \
  --name /email/prod/retention/engagement-ttl-days \
  --value "180" \
  --type String \
  --overwrite \
  --region eu-west-2
```

Note: Lambda functions cache parameters on cold start, so changes may take several minutes to propagate.

## Security Considerations

Per **PLATFORM_INVARIANTS.md** section 16:

### Infrastructure Layer Responsibilities

This infrastructure layer **MUST**:
- Validate all SES event signatures before passing to domain layer
- Verify SNS message signatures using AWS SDK
- Enforce IAM policies and API Gateway authorization
- Sanitize and validate all external inputs
- Act as the security perimeter

### No Secrets in Code

Per **PLATFORM_INVARIANTS.md** section 4:
- No hardcoded secrets, ever
- Secrets live in AWS Secrets Manager
- Non-secret configuration lives in SSM Parameter Store
- `.env` files are local-only and never committed

### Least Privilege IAM

All Lambda functions have minimal IAM permissions:
- CloudWatch Logs write access only
- Additional permissions added per function as needed

### AWS SDK Usage

Lambda handlers should use AWS SDK v3. The Node.js 20 runtime includes v3, and this repo does not assume v2 is available.

## Monitoring and Logs

### CloudWatch Logs

Lambda function logs are retained for **180 days** (6 months) per **PLATFORM_INVARIANTS.md** section 11.

Log groups (dev environment):
- `/aws/lambda/dev-email-api-health`
- `/aws/lambda/dev-email-api-not-implemented`
- `/aws/lambda/dev-email-api-admin-authorizer`

Log retention:
- **Dev**: 180 days, DESTROY on stack deletion
- **Prod**: 180 days, RETAIN on stack deletion (prevents accidental log loss)

### X-Ray Tracing

- **Dev**: Disabled (cost optimization)
- **Prod**: Enabled (detailed monitoring)

## Cost Optimization

- **Lambda architecture**: ARM64 (Graviton2) for ~20% cost savings
- **Lambda memory**: 128-256 MB (minimal for placeholder functions)
- **API Gateway**: HTTP API (cheaper than REST API)
- **Log retention**: 180 days (not indefinite)

## Troubleshooting

### DNS Propagation

After first deployment, DNS records may take 5-15 minutes to propagate. Use the API Gateway URL for immediate testing.

### Certificate Validation

ACM certificates are validated via DNS automatically. The certificate stack waits for validation to complete (typically 5-10 minutes).

### Route53 Hosted Zone Not Found

Ensure the Route53 hosted zone for `ponton.io` exists before deployment:

```bash
aws route53 list-hosted-zones --query 'HostedZones[?Name==`ponton.io.`]'
```

### Stack Deployment Failures

Check CloudFormation events for detailed error messages:

```bash
aws cloudformation describe-stack-events \
  --stack-name dev-email-certificate \
  --max-items 20
```

## Cleanup

To delete all infrastructure (warning: irreversible):

```bash
# Delete dev environment
cdk destroy --all --context environment=dev

# Delete prod environment
cdk destroy --all --context environment=prod
```

**Note**: This deletes all AWS resources but preserves Route53 hosted zone.

## Next Steps

After Milestone 3 completion:

1. **Milestone 4**: Set up SES configuration
   - Verify `email.ponton.io` domain
   - Configure SNS topics for bounce/complaint handling
   - Set up configuration sets

2. **Milestone 5**: Implement Cognito
   - Admin user pool
   - API Gateway JWT authorizers

3. **Milestone 6**: Observability and retention
   - CloudWatch dashboards
   - Monitoring alarms for table metrics

## Contributing

This repository follows strict guidelines per `agents.md`:

**Agents must never**:
- Run git or CI/CD commands
- Modify IAM directly
- Deploy infrastructure
- Introduce new resources without permission

**Agents must**:
- Update README.md after changes
- Preserve least privilege
- Respect dev/prod separation

## Documentation

- **PLATFORM_INVARIANTS.md**: Platform-wide rules (source of truth)
- **plans.md**: Milestone roadmap
- **agents.md**: Agent development guidelines
- **DEPLOYMENT_GUIDE_MILESTONE3.md**: Milestone 3 deployment steps and verification
- **README.md**: This file (infrastructure setup and deployment)

## License

UNLICENSED - Private project

## Contact

For questions about platform architecture, refer to `PLATFORM_INVARIANTS.md` as the source of truth.
