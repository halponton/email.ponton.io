# Deployment Guide - Milestone 3: Secrets Manager and SSM Integration

**Date**: 2025-12-29
**Milestone**: 3 - Secrets Manager and SSM Integration
**Status**: Ready for Deployment

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Pre-Deployment Checklist](#pre-deployment-checklist)
4. [Deployment Steps](#deployment-steps)
5. [Post-Deployment Configuration](#post-deployment-configuration)
6. [Verification](#verification)
7. [Troubleshooting](#troubleshooting)
8. [Rollback Procedures](#rollback-procedures)
9. [Security Considerations](#security-considerations)

---

## Overview

### What This Deployment Adds

Milestone 3 introduces secure secrets management and configuration storage:

**AWS Secrets Manager**:
- HMAC secret for token generation/verification
- HMAC secret for email hashing
- Secrets are generated automatically at deployment time

**SSM Parameter Store** (7 parameters):
- SES configuration (verified domain, from email, from name)
- API configuration (base URL)
- Tracking configuration (click redirect URL, open pixel URL)
- Retention configuration (engagement TTL)

### Architecture Changes

**New Stack**: `{env}-email-secrets`
- Creates 2 Secrets Manager secrets
- Creates a dedicated CMK for Secrets Manager
- Creates 7 SSM parameters
- Depends on: none (dedicated CMK; can deploy in parallel with DynamoDB)
- Required by: `{env}-email-api-gateway`

**Updated Stack**: `{env}-email-api-gateway`
- Now receives secrets and parameters references
- No IAM grants added yet (placeholder functions don't need access)

### Deployment Time Estimate

- Dev environment: ~5 minutes
- Total: ~5 minutes for dev environment

**NOTE**: This guide covers dev deployment only. Production deployment will be performed after all milestones are complete and tested in dev.

---

## Prerequisites

### 1. AWS Permissions

Your AWS credentials (or GitHub Actions OIDC role) must have:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SecretsAndParameters",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:CreateSecret",
        "secretsmanager:DescribeSecret",
        "secretsmanager:TagResource",
        "ssm:PutParameter",
        "ssm:AddTagsToResource",
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath"
      ],
      "Resource": [
        "arn:aws:secretsmanager:eu-west-2:*:secret:/*/email/token-hmac-secret-*",
        "arn:aws:secretsmanager:eu-west-2:*:secret:/*/email/email-hash-hmac-secret-*",
        "arn:aws:ssm:eu-west-2:*:parameter/email/*/*"
      ]
    },
    {
      "Sid": "SecretsManagerCmk",
      "Effect": "Allow",
      "Action": [
        "kms:CreateKey",
        "kms:CreateAlias",
        "kms:DeleteAlias",
        "kms:DescribeKey",
        "kms:GetKeyPolicy",
        "kms:PutKeyPolicy",
        "kms:EnableKeyRotation",
        "kms:DisableKeyRotation",
        "kms:ScheduleKeyDeletion",
        "kms:CancelKeyDeletion",
        "kms:TagResource",
        "kms:UntagResource",
        "kms:ListAliases",
        "kms:ListResourceTags"
      ],
      "Resource": "*"
    }
  ]
}
```

If you plan to rotate secrets manually, add:
- `secretsmanager:PutSecretValue` and `secretsmanager:GetSecretValue` on the two secret ARNs

### 2. Environment Setup

Ensure you have:
- AWS CLI v2 installed and configured
- Node.js v20+ installed
- CDK CLI installed (`npm install -g aws-cdk`)
- Repository cloned and dependencies installed (`npm install`)

### 3. Existing Infrastructure

Milestone 2 must be deployed:
- `{env}-email-certificate` stack
- `{env}-email-dynamodb` stack
- `{env}-email-api-gateway` stack

Verify existing stacks:
```bash
aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query 'StackSummaries[?starts_with(StackName, `dev-email`) || starts_with(StackName, `prod-email`)].StackName' \
  --region eu-west-2
```

Expected output should include:
- `dev-email-certificate`
- `dev-email-dynamodb`
- `dev-email-api-gateway`

### 4. Optional: Tools for Secret Rotation

Install OpenSSL if you plan to rotate secrets manually:
```bash
openssl version
# Expected: OpenSSL 3.x or higher
```

For Windows, use Git Bash or WSL.

---

## Pre-Deployment Checklist

### Code Verification

- [ ] All tests passing: `npm test`
  ```bash
  npm test
  # Expected: Test Suites: 2 passed, Tests: 14 passed
  ```

- [ ] TypeScript compilation clean: `npm run build`
  ```bash
  npm run build
  # Expected: No errors
  ```

- [ ] CDK synthesis successful (dev only for now):
  ```bash
  npm run synth:dev
  # Expected: Successfully synthesized to cdk.out
  ```
  Note: Run `npm run synth:prod` when you're ready for prod.

### CloudFormation Template Review

- [ ] Review synthesized template (dev):
  ```bash
  cat cdk.out/dev-email-secrets.template.json | jq '.Resources | keys'
  ```
  Note: Review the prod template later when you're ready for prod.

- [ ] Verify expected resources (should see 11 resources):
  - 2 Secrets Manager Secrets
  - 1 KMS Key
  - 1 KMS Alias
  - 7 SSM Parameters

### Security Review

- [ ] Verify no hardcoded secrets:
  ```bash
  rg -n "\\bunsafePlainText\\b" lib/constructs/secrets.ts
  # Expected: No matches

  rg -n "\\bSecretString\\b" lib/constructs/secrets.ts
  # Expected: No matches

  rg -n "BEGIN RSA" lib/ test/
  # Expected: No matches (no embedded keys)
  ```

- [ ] Verify removal policies in synthesized templates:
  ```bash
  # Dev: Should be "Delete"
  jq '.Resources[].DeletionPolicy' cdk.out/dev-email-secrets.template.json | sort -u
  ```
  Note: Check prod removal policies later after running `npm run synth:prod`.

---

## Deployment Steps

**IMPORTANT**: This deployment is for the **dev environment only**. Production deployment will be performed later after all milestones are complete.

### Step 1: Deploy to Dev Environment

#### 1.1 Set AWS Region
```bash
export AWS_REGION=eu-west-2
export AWS_DEFAULT_REGION=eu-west-2
```

#### 1.2 Review Deployment Plan
```bash
npx cdk diff dev-email-secrets --context environment=dev
npx cdk diff dev-email-api-gateway --context environment=dev
```

Review the output carefully. You should see:
- **New Resources**: 11 resources to be created
  - `SecretsTokenHmacSecret...` (AWS::SecretsManager::Secret)
  - `SecretsEmailHashHmacSecret...` (AWS::SecretsManager::Secret)
  - `SecretsEncryptionKey...` (AWS::KMS::Key)
  - `SecretsEncryptionKeyAlias...` (AWS::KMS::Alias)
  - 7 SSM parameters (AWS::SSM::Parameter)
- **Updated Resources**: `dev-email-api-gateway` stack (props added, no functional changes)

#### 1.3 Deploy Dev Secrets Stack
```bash
npx cdk deploy dev-email-secrets --context environment=dev
```

Expected output:
```
✅  dev-email-secrets

Outputs:
 dev-email-secrets.TokenHmacSecretArn = arn:aws:secretsmanager:eu-west-2:...:secret:/dev/email/token-hmac-secret-...
 dev-email-secrets.TokenHmacSecretName = /dev/email/token-hmac-secret
 dev-email-secrets.EmailHashHmacSecretArn = arn:aws:secretsmanager:eu-west-2:...:secret:/dev/email/email-hash-hmac-secret-...
 dev-email-secrets.EmailHashHmacSecretName = /dev/email/email-hash-hmac-secret
 dev-email-secrets.SesVerifiedDomainParameter = /email/dev/ses/verified-domain
 dev-email-secrets.SesFromEmailParameter = /email/dev/ses/from-email
 ... (7 total parameters)

Stack ARN:
arn:aws:cloudformation:eu-west-2:...:stack/dev-email-secrets/...
```

#### 1.4 Deploy Updated API Gateway Stack
```bash
npx cdk deploy dev-email-api-gateway --context environment=dev
```

This updates the API Gateway stack to receive secrets/parameters props. No functional changes occur yet.

#### 1.5 Verify Dev Deployment
```bash
# Check secrets were created
aws secretsmanager describe-secret \
  --secret-id /dev/email/token-hmac-secret \
  --region eu-west-2

aws secretsmanager describe-secret \
  --secret-id /dev/email/email-hash-hmac-secret \
  --region eu-west-2

# Check parameters were created
aws ssm get-parameters-by-path \
  --path /email/dev \
  --recursive \
  --region eu-west-2 \
  --query 'Parameters[].Name'
```

Expected: 7 parameter names listed.

---

### Step 2: Optional - Rotate Dev Secrets

Secrets are generated automatically at deployment time. No manual population is required.

If you need to rotate secrets in dev (e.g., for testing), update each secret value:

```bash
# Generate 256-bit random secrets (32 bytes, base64 encoded)
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

# Clear bash history of secrets
unset TOKEN_SECRET
unset EMAIL_SECRET
history -c
```

---

### Step 3: Deploy to Prod Environment (SKIP FOR NOW)

**SKIP THIS STEP**: Production deployment will be performed after all milestones are complete.

**When you do deploy to prod later**, follow these steps:

#### 3.1 Review Prod Deployment Plan
```bash
npx cdk diff prod-email-secrets --context environment=prod
npx cdk diff prod-email-api-gateway --context environment=prod
```

#### 3.2 Deploy Prod Secrets Stack
```bash
npx cdk deploy prod-email-secrets --context environment=prod --require-approval broadening
```

Expected output similar to dev, but with `prod` prefixes.

#### 3.3 Deploy Updated Prod API Gateway Stack
```bash
npx cdk deploy prod-email-api-gateway --context environment=prod --require-approval broadening
```

#### 3.4 Verify Prod Deployment
```bash
# Check secrets were created
aws secretsmanager describe-secret \
  --secret-id /prod/email/token-hmac-secret \
  --region eu-west-2

aws secretsmanager describe-secret \
  --secret-id /prod/email/email-hash-hmac-secret \
  --region eu-west-2

# Check parameters were created
aws ssm get-parameters-by-path \
  --path /email/prod \
  --recursive \
  --region eu-west-2 \
  --query 'Parameters[].Name'
```

---

### Step 4: Optional - Rotate Prod Secrets (SKIP FOR NOW)

**SKIP THIS STEP**: Production deployment will be performed later.

Secrets are generated automatically at deployment time and will already be distinct per environment.
If you need to rotate prod secrets later, use unique values (do not reuse dev secrets):

```bash
PROD_TOKEN_SECRET=$(openssl rand -base64 32)
PROD_EMAIL_SECRET=$(openssl rand -base64 32)

aws secretsmanager put-secret-value \
  --secret-id /prod/email/token-hmac-secret \
  --secret-string "$PROD_TOKEN_SECRET" \
  --region eu-west-2

aws secretsmanager put-secret-value \
  --secret-id /prod/email/email-hash-hmac-secret \
  --secret-string "$PROD_EMAIL_SECRET" \
  --region eu-west-2

# Do not retrieve prod secret values to verify. Trust CloudTrail.
unset PROD_TOKEN_SECRET
unset PROD_EMAIL_SECRET
history -c
```

---

## Post-Deployment Configuration

### Optional: Update SSM Parameter Values

If you need to customize parameter values (e.g., different from-email address):

```bash
# Example: Update SES from-email for dev
aws ssm put-parameter \
  --name /email/dev/ses/from-email \
  --value "custom-newsletter@email.ponton.io" \
  --type String \
  --overwrite \
  --region eu-west-2

# Example: Update API base URL for prod
aws ssm put-parameter \
  --name /email/prod/api/base-url \
  --value "https://api.email.ponton.io" \
  --type String \
  --overwrite \
  --region eu-west-2
```

### CloudTrail Verification

Verify secret operations are logged:

```bash
# Check CloudTrail for CreateSecret events (deployment)
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=CreateSecret \
  --max-results 5 \
  --region eu-west-2 \
  --query 'Events[].CloudTrailEvent' \
  --output text | jq .
```

Expected: Recent events for dev/prod secret creation.

If you rotated secrets manually, look for PutSecretValue events:
```bash
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=PutSecretValue \
  --max-results 5 \
  --region eu-west-2 \
  --query 'Events[].CloudTrailEvent' \
  --output text | jq .
```

---

## Verification

### Infrastructure Verification

#### 1. Verify Stack Outputs
```bash
# Dev environment
aws cloudformation describe-stacks \
  --stack-name dev-email-secrets \
  --region eu-west-2 \
  --query 'Stacks[0].Outputs'

# Prod environment
aws cloudformation describe-stacks \
  --stack-name prod-email-secrets \
  --region eu-west-2 \
  --query 'Stacks[0].Outputs'
```

Expected: 11 outputs per environment (4 secret outputs + 7 parameter names).

#### 2. Verify Stack Dependencies
```bash
# API Gateway should import secrets outputs
aws cloudformation list-imports \
  --export-name dev-TokenHmacSecretArn \
  --region eu-west-2 \
  --query 'Imports'

aws cloudformation list-imports \
  --export-name dev-EmailHashHmacSecretArn \
  --region eu-west-2 \
  --query 'Imports'
```
Expected: `dev-email-api-gateway` listed in both imports.

#### 3. Verify Resource Tags
```bash
# Check secret tags
aws secretsmanager describe-secret \
  --secret-id /dev/email/token-hmac-secret \
  --region eu-west-2 \
  --query 'Tags'

aws secretsmanager describe-secret \
  --secret-id /dev/email/email-hash-hmac-secret \
  --region eu-west-2 \
  --query 'Tags'

# Expected tags:
# - Environment: dev
# - ManagedBy: CDK
# - Project: email.ponton.io
# - SecretType: TokenHmac (token secret)
# - SecretType: EmailHashHmac (email hash secret)
```

### Secret Verification

#### 1. Verify Secret Existence
```bash
aws secretsmanager describe-secret \
  --secret-id /dev/email/token-hmac-secret \
  --region eu-west-2 \
  --query 'Name'

aws secretsmanager describe-secret \
  --secret-id /dev/email/email-hash-hmac-secret \
  --region eu-west-2 \
  --query 'Name'
```

Expected: Names match the provided secret IDs.

#### 2. Verify Secret Version
```bash
# Verify AWSCURRENT version exists
aws secretsmanager describe-secret \
  --secret-id /dev/email/token-hmac-secret \
  --region eu-west-2 \
  --query 'VersionIdsToStages'

aws secretsmanager describe-secret \
  --secret-id /dev/email/email-hash-hmac-secret \
  --region eu-west-2 \
  --query 'VersionIdsToStages'
```

Expected: One version with stage "AWSCURRENT".

#### 3. Verify Encryption
```bash
# Verify secrets use the dedicated Secrets Manager CMK
aws secretsmanager describe-secret \
  --secret-id /dev/email/token-hmac-secret \
  --region eu-west-2 \
  --query 'KmsKeyId'
```

Expected: KMS key ARN for the dedicated Secrets Manager CMK.

### Parameter Verification

#### 1. Verify All Parameters Exist
```bash
# Dev environment
aws ssm get-parameters \
  --names \
    /email/dev/ses/verified-domain \
    /email/dev/ses/from-email \
    /email/dev/ses/from-name \
    /email/dev/api/base-url \
    /email/dev/tracking/click-redirect-base-url \
    /email/dev/tracking/open-pixel-base-url \
    /email/dev/retention/engagement-ttl-days \
  --region eu-west-2 \
  --query 'Parameters[].Name'

# Expected: All 7 parameter names returned
```

#### 2. Verify Parameter Values
```bash
# Dev environment - check key parameter values
aws ssm get-parameter \
  --name /email/dev/ses/verified-domain \
  --region eu-west-2 \
  --query 'Parameter.Value' \
  --output text
# Expected: email.ponton.io

aws ssm get-parameter \
  --name /email/dev/retention/engagement-ttl-days \
  --region eu-west-2 \
  --query 'Parameter.Value' \
  --output text
# Expected: 180
```

### Integration Verification

#### 1. Verify API Gateway Stack Update
```bash
# Check that API Gateway stack was updated
aws cloudformation describe-stack-events \
  --stack-name dev-email-api-gateway \
  --region eu-west-2 \
  --max-items 10 \
  --query 'StackEvents[?ResourceType==`AWS::CloudFormation::Stack`].[Timestamp,ResourceStatus,ResourceStatusReason]' \
  --output table
```

Look for recent `UPDATE_COMPLETE` event.

#### 2. Verify No Lambda Errors
```bash
# Check that Lambda functions still work (placeholder health check)
aws lambda list-functions \
  --region eu-west-2 \
  --query 'Functions[?starts_with(FunctionName, `dev-email`)].FunctionName'
```

All functions should still exist and be in Active state.

---

## Troubleshooting

### Issue: "Secret already exists" Error

**Symptom**:
```
The operation failed because the secret /dev/email/token-hmac-secret already exists.
```

**Cause**: A secret was created in a previous deployment attempt.

**Solution**:
```bash
# Option 1: Delete and recreate (dev only)
aws secretsmanager delete-secret \
  --secret-id /dev/email/token-hmac-secret \
  --force-delete-without-recovery \
  --region eu-west-2

aws secretsmanager delete-secret \
  --secret-id /dev/email/email-hash-hmac-secret \
  --force-delete-without-recovery \
  --region eu-west-2

# Then redeploy
npm run deploy:dev -- dev-email-secrets
```

**For Prod**: DO NOT force delete. Use recovery instead:
```bash
# Restore deleted secret
aws secretsmanager restore-secret \
  --secret-id /prod/email/token-hmac-secret \
  --region eu-west-2

aws secretsmanager restore-secret \
  --secret-id /prod/email/email-hash-hmac-secret \
  --region eu-west-2
```

### Issue: "Parameter already exists" Error

**Symptom**:
```
The parameter /email/dev/ses/from-email already exists.
```

**Cause**: Parameter exists from previous deployment.

**Solution**:
```bash
# Delete parameter (dev only)
aws ssm delete-parameter \
  --name /email/dev/ses/from-email \
  --region eu-west-2

# Or update with overwrite flag
aws ssm put-parameter \
  --name /email/dev/ses/from-email \
  --value "newsletter-dev@email.ponton.io" \
  --type String \
  --overwrite \
  --region eu-west-2
```

### Issue: "KMS Key Not Found"

**Symptom**:
```
The specified KMS key does not exist or you do not have access to it.
```

**Cause**: Secrets Manager CMK not created yet or key was scheduled for deletion.

**Solution**:
```bash
# Verify Secrets stack exists
aws cloudformation describe-stacks \
  --stack-name dev-email-secrets \
  --region eu-west-2

# If missing, deploy the Secrets stack
npm run deploy:dev -- dev-email-secrets
```

### Issue: Stack Dependency Violation

**Symptom**:
```
Export dev-email-secrets:ExportsOutputRefTokenHmacSecretArn... cannot be deleted as it is in use by dev-email-api-gateway
```

**Cause**: Trying to delete the Secrets stack while API Gateway depends on it.

**Solution**:
```bash
# Delete in correct order (reverse of creation)
aws cloudformation delete-stack --stack-name dev-email-api-gateway --region eu-west-2
aws cloudformation wait stack-delete-complete --stack-name dev-email-api-gateway --region eu-west-2

aws cloudformation delete-stack --stack-name dev-email-secrets --region eu-west-2
aws cloudformation wait stack-delete-complete --stack-name dev-email-secrets --region eu-west-2
```

### Issue: Permission Denied Errors

**Symptom**:
```
User: arn:aws:iam::...:user/... is not authorized to perform: secretsmanager:CreateSecret
```

**Cause**: IAM user/role lacks required permissions.

**Solution**: Add permissions from [Prerequisites](#1-aws-permissions) section to your IAM user/role.

---

## Rollback Procedures

### Rollback Decision Tree

**Should you rollback?**
- **YES** if: CloudFormation deployment failed, secrets compromised, critical production issue
- **NO** if: Minor parameter value issue (just update the parameter)

### Dev Environment Rollback

Safe to perform at any time:

```bash
# 1. Delete Secrets stack (removes secret and parameters)
aws cloudformation delete-stack \
  --stack-name dev-email-secrets \
  --region eu-west-2

# 2. Wait for deletion
aws cloudformation wait stack-delete-complete \
  --stack-name dev-email-secrets \
  --region eu-west-2

# 3. Rollback API Gateway stack (if it was updated)
aws cloudformation update-stack \
  --stack-name dev-email-api-gateway \
  --use-previous-template \
  --capabilities CAPABILITY_NAMED_IAM \
  --region eu-west-2

# Or redeploy from previous git commit
git checkout <previous-commit>
npx cdk deploy dev-email-api-gateway --context environment=dev
git checkout main
```

### Prod Environment Rollback

**CAUTION**: Prod secrets use `RemovalPolicy: RETAIN`.

```bash
# 1. DO NOT delete stack (would orphan secrets)
# Instead, rollback API Gateway first
git checkout <previous-commit>
npx cdk deploy prod-email-api-gateway --context environment=prod --require-approval broadening
git checkout main

# 2. If you must rollback Secrets stack:
# WARNING: This marks secret for deletion but retains it for 7+ days
aws cloudformation delete-stack \
  --stack-name prod-email-secrets \
  --region eu-west-2

# 3. Verify secret was retained (not deleted)
aws secretsmanager describe-secret \
  --secret-id /prod/email/token-hmac-secret \
  --region eu-west-2 \
  --query 'DeletionDate'

aws secretsmanager describe-secret \
  --secret-id /prod/email/email-hash-hmac-secret \
  --region eu-west-2 \
  --query 'DeletionDate'

# If DeletionDate is set, cancel deletion:
aws secretsmanager restore-secret \
  --secret-id /prod/email/token-hmac-secret \
  --region eu-west-2

aws secretsmanager restore-secret \
  --secret-id /prod/email/email-hash-hmac-secret \
  --region eu-west-2
```

### Secret Rotation (Emergency)

If secrets are compromised:

```bash
# 1. Generate new secrets immediately
NEW_TOKEN_SECRET=$(openssl rand -base64 32)
NEW_EMAIL_SECRET=$(openssl rand -base64 32)

# 2. Update secret value
aws secretsmanager put-secret-value \
  --secret-id /prod/email/token-hmac-secret \
  --secret-string "$NEW_TOKEN_SECRET" \
  --region eu-west-2

aws secretsmanager put-secret-value \
  --secret-id /prod/email/email-hash-hmac-secret \
  --secret-string "$NEW_EMAIL_SECRET" \
  --region eu-west-2

# 3. Restart all Lambda functions (if they cache secrets)
# This will happen automatically on next cold start

# 4. Document incident in security log
```

---

## Security Considerations

### Secret Rotation Schedule

**Recommendation**:
- **HMAC Secrets**: Rotate annually minimum (quarterly for high security posture)
- **After Incident**: Rotate immediately if compromise suspected

**Rotation Process**:
1. Generate new secret values
2. Update both secrets in Secrets Manager
3. Allow Lambda cold starts to pick up new values
4. Monitor error rates for 24 hours

### Access Control

**Who should have access**:
- **Dev Secrets**: Development team (read access)
- **Prod Secrets**: Operations team only (read access), security team (write access)

**Audit Access**:
```bash
# Check who accessed secrets in last 7 days
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue \
  --start-time $(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%S) \
  --region eu-west-2 \
  --query 'Events[].[EventTime,Username,CloudTrailEvent]' \
  --output text
```

### Backup and Disaster Recovery

**Secrets Backup**:
- Secrets Manager automatically versions secrets
- Each `PutSecretValue` creates a new version
- Previous versions retained (no automatic expiration)

**Recovery**:
```bash
# List all secret versions
aws secretsmanager list-secret-version-ids \
  --secret-id /prod/email/token-hmac-secret \
  --region eu-west-2

aws secretsmanager list-secret-version-ids \
  --secret-id /prod/email/email-hash-hmac-secret \
  --region eu-west-2

# Recover specific version
aws secretsmanager get-secret-value \
  --secret-id /prod/email/token-hmac-secret \
  --version-id <version-id> \
  --region eu-west-2

aws secretsmanager get-secret-value \
  --secret-id /prod/email/email-hash-hmac-secret \
  --version-id <version-id> \
  --region eu-west-2
```

**Parameter Backup**:
SSM parameters should be documented in disaster recovery runbook. Parameters contain non-secret configuration and can be recreated from documentation.

### Monitoring and Alerting

**Set up alerts for**:
1. Unauthorized secret access attempts
2. Secret deletion events
3. Unusual number of secret retrievals
4. Parameter modifications

```bash
# Example: CloudWatch alarm for secret access (requires CloudWatch Logs)
# This is a placeholder - implement in future milestones
```

---

## Post-Deployment Checklist

After completing dev deployment:

- [ ] Dev secrets stack deployed successfully
- [ ] Dev secrets created (auto-generated values)
- [ ] Dev parameters verified (all 7 exist)
- [ ] CloudFormation outputs documented
- [ ] Stack dependencies verified
- [ ] CloudTrail events show secret creation (and rotation if performed)
- [ ] Deployment documented in team wiki/runbook
- [ ] Team notified of new secrets infrastructure

**For prod deployment later**:
- [ ] Prod secrets stack deployed successfully
- [ ] Prod secrets created (auto-generated values distinct from dev)
- [ ] Prod parameters verified (all 7 exist)
- [ ] Monitoring/alerting configured

---

## Success Criteria

Dev deployment is successful when:

1. ✅ `dev-email-secrets` stack shows `CREATE_COMPLETE` or `UPDATE_COMPLETE`
2. ✅ Dev secrets created with AWSCURRENT versions
3. ✅ All 7 SSM parameters exist in dev environment
4. ✅ `dev-email-api-gateway` stack updated successfully
5. ✅ No CloudFormation errors or rollbacks
6. ✅ CloudTrail logs show secret creation (and rotation if performed)
7. ✅ Team has access to secrets metadata for validation

**Prod deployment criteria (for later)**:
- Same as above but for prod environment
- Prod secrets remain distinct from dev secrets

---

## Next Steps

After Milestone 3 deployment:

1. **Document Secret ARNs**: Update team wiki with secret ARNs for reference
2. **Update CI/CD**: Ensure GitHub Actions can deploy secrets stack
3. **Plan Milestone 4**: SES integration will use the SSM parameters created here
4. **Security Review**: Schedule quarterly secret rotation review

---

## Support and Contacts

**For deployment issues**:
- Check [Troubleshooting](#troubleshooting) section
- Review CloudFormation events in AWS Console
- Check CloudTrail logs for detailed error messages

**For security concerns**:
- Rotate secrets immediately if compromise suspected
- Contact security team before proceeding with prod rollback
- Document all security incidents

---

**End of Deployment Guide**
