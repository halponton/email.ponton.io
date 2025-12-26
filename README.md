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

### Current Implementation Status

**Milestone 1: Domains and API Gateway** ✅ (Current)
- ACM certificate for `api.email.ponton.io`
- API Gateway HTTP API with custom domain
- Route53 alias record
- Health check endpoint at `/v1/health`
- Placeholder routes returning 501 Not Implemented

**Future Milestones:**
- Milestone 2: DynamoDB tables and GSIs
- Milestone 3: Secrets Manager and SSM
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
| POST | `/admin/campaigns` | 🚧 Placeholder | Create campaign |
| GET | `/admin/campaigns/{id}` | 🚧 Placeholder | Get campaign details |
| POST | `/admin/campaigns/{id}/send` | 🚧 Placeholder | Send campaign |
| GET | `/admin/subscribers` | 🚧 Placeholder | List subscribers |
| POST | `/admin/subscribers/{id}/suppress` | 🚧 Placeholder | Suppress subscriber |

🚧 = Returns 501 Not Implemented (infrastructure in place, handler pending)

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
  region: 'us-east-1',
  domain: 'email.ponton.io',
  apiDomain: 'api.email.ponton.io',
  sesSandbox: true,
  logRetentionDays: 180,
  hostedZoneName: 'ponton.io',
}

// Prod environment
{
  env: 'prod',
  region: 'us-east-1',
  domain: 'email.ponton.io',
  apiDomain: 'api.email.ponton.io',
  sesSandbox: false,
  logRetentionDays: 180,
  hostedZoneName: 'ponton.io',
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
- `CustomDomainUrl`: Custom domain URL (https://api.email.ponton.io)
- `HealthCheckUrl`: Health check endpoint URL

## Testing

### Health Check Endpoint

After deployment, test the health check:

```bash
# Using custom domain (requires DNS propagation)
curl https://api.email.ponton.io/v1/health

# Using API Gateway URL (immediate)
curl https://{api-id}.execute-api.us-east-1.amazonaws.com/v1/health
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

All other routes return 501 Not Implemented:

```bash
curl -X POST https://api.email.ponton.io/v1/subscribe

# Response:
# {
#   "error": "Not Implemented",
#   "message": "Endpoint POST /v1/subscribe is not yet implemented...",
#   "timestamp": "2025-12-26T12:00:00.000Z"
# }
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
│   │   └── api-gateway-stack.ts # API Gateway and routes stack
│   │
│   ├── constructs/
│   │   ├── lambda-function.ts   # Standardized Lambda construct
│   │   └── api-routes.ts        # API Gateway routes construct
│   │
│   └── handlers/
│       ├── health.ts            # Health check handler
│       └── not-implemented.ts   # Placeholder handler (501)
│
└── ponton.io_email_service/     # Domain logic (separate repo)
```

## Stack Dependencies

```
dev-email-certificate
  └─> dev-email-api-gateway
```

The certificate stack must be deployed first as the API Gateway stack depends on the ACM certificate.

## Environment Variables

Lambda functions receive standard environment variables:

- `ENVIRONMENT`: `dev` or `prod`
- `REGION`: AWS region (us-east-1)
- `LOG_LEVEL`: `DEBUG` (dev) or `INFO` (prod)

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
- Secrets live in AWS Secrets Manager (future milestone)
- Non-secret configuration lives in SSM Parameter Store (future milestone)
- `.env` files are local-only and never committed

### Least Privilege IAM

All Lambda functions have minimal IAM permissions:
- CloudWatch Logs write access only
- Additional permissions added per function as needed

## Monitoring and Logs

### CloudWatch Logs

Lambda function logs are retained for **180 days** (6 months) per **PLATFORM_INVARIANTS.md** section 11.

Log groups:
- `/aws/lambda/dev-email-api-health`
- `/aws/lambda/dev-email-api-not-implemented`

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

After Milestone 1 completion:

1. **Milestone 2**: Implement DynamoDB tables and GSIs
   - Subscribers table
   - Campaigns table
   - Delivery records table
   - Engagement events table

2. **Milestone 3**: Configure Secrets Manager and SSM
   - HMAC signing keys
   - SES configuration parameters

3. **Milestone 4**: Set up SES configuration
   - Verify `email.ponton.io` domain
   - Configure SNS topics for bounce/complaint handling
   - Set up configuration sets

4. **Milestone 5**: Implement Cognito
   - Admin user pool
   - API Gateway JWT authorizers

5. **Milestone 6**: Observability and retention
   - CloudWatch dashboards
   - Engagement event cleanup Lambda (6-month TTL)

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
- **README.md**: This file (infrastructure setup and deployment)

## License

UNLICENSED - Private project

## Contact

For questions about platform architecture, refer to `PLATFORM_INVARIANTS.md` as the source of truth.
