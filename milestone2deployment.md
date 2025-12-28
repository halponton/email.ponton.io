# Milestone 2 Deployment Guide

**Project:** email.ponton.io
**Milestone:** 2 - DynamoDB Tables and GSIs
**Version:** 1.0
**Date:** 2025-12-28

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [IAM Policies Required](#iam-policies-required)
3. [Pre-Deployment Verification](#pre-deployment-verification)
4. [Deployment Commands](#deployment-commands)
5. [Post-Deployment Verification](#post-deployment-verification)
6. [Testing Procedures](#testing-procedures)
7. [Rollback Procedures](#rollback-procedures)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required Tools

```bash
# Verify Node.js version
node --version  # Should be >= 20.x

# Verify npm version
npm --version   # Should be >= 10.x

# Verify AWS CLI
aws --version   # Should be >= 2.x

# Verify CDK CLI
npx cdk --version  # Should be >= 2.125.0
```

### AWS Account Setup

- AWS Account ID: `[YOUR_ACCOUNT_ID]`
- Region: `eu-west-2` (London)
- Environment: `dev` or `prod`

### Existing Infrastructure

Milestone 2 depends on:
- ✅ **Milestone 1 deployed** (API Gateway Stack)
- ✅ Certificate Stack deployed (ACM certificate for domain)

Verify existing stacks:
```bash
aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query 'StackSummaries[?contains(StackName, `email`)].StackName' \
  --region eu-west-2
```

Expected output should include:
- `dev-email-certificate` (or `prod-email-certificate`)
- `dev-email-api-gateway` (or `prod-email-api-gateway`)

---

## IAM Policies Required

### Option 1: Administrator Access (Simplest)

If your AWS CLI user has `AdministratorAccess`, you can skip to [Deployment Commands](#deployment-commands).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "*",
      "Resource": "*"
    }
  ]
}
```

### Option 2: Least Privilege Policies (Recommended for Production)

Create a custom IAM policy for CDK deployment with minimal required permissions.

#### Policy 1: CDK Bootstrap and CloudFormation

**Policy Name:** `EmailPlatformCDKDeploymentPolicy`

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudFormationFullAccess",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResources",
        "cloudformation:GetTemplate",
        "cloudformation:ValidateTemplate",
        "cloudformation:CreateChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:ListStacks",
        "cloudformation:GetTemplateSummary"
      ],
      "Resource": [
        "arn:aws:cloudformation:eu-west-2:*:stack/dev-email-*/*",
        "arn:aws:cloudformation:eu-west-2:*:stack/prod-email-*/*",
        "arn:aws:cloudformation:eu-west-2:*:stack/CDKToolkit/*"
      ]
    },
    {
      "Sid": "S3CDKAssetsAccess",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:GetBucketPolicy"
      ],
      "Resource": [
        "arn:aws:s3:::cdk-*-assets-*-eu-west-2",
        "arn:aws:s3:::cdk-*-assets-*-eu-west-2/*"
      ]
    },
    {
      "Sid": "SSMParameterAccess",
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:PutParameter"
      ],
      "Resource": [
        "arn:aws:ssm:eu-west-2:*:parameter/cdk-bootstrap/*"
      ]
    },
    {
      "Sid": "ECRRepositoryAccess",
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload"
      ],
      "Resource": "*"
    }
  ]
}
```

#### Policy 2: DynamoDB and KMS Permissions

**Policy Name:** `EmailPlatformDynamoDBDeploymentPolicy`

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DynamoDBTableManagement",
      "Effect": "Allow",
      "Action": [
        "dynamodb:CreateTable",
        "dynamodb:UpdateTable",
        "dynamodb:DeleteTable",
        "dynamodb:DescribeTable",
        "dynamodb:DescribeContinuousBackups",
        "dynamodb:UpdateContinuousBackups",
        "dynamodb:DescribeTimeToLive",
        "dynamodb:UpdateTimeToLive",
        "dynamodb:TagResource",
        "dynamodb:UntagResource",
        "dynamodb:ListTagsOfResource"
      ],
      "Resource": [
        "arn:aws:dynamodb:eu-west-2:*:table/dev-email-*",
        "arn:aws:dynamodb:eu-west-2:*:table/prod-email-*"
      ]
    },
    {
      "Sid": "KMSKeyManagement",
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
        "kms:GetKeyRotationStatus",
        "kms:ScheduleKeyDeletion",
        "kms:CancelKeyDeletion",
        "kms:TagResource",
        "kms:UntagResource",
        "kms:ListResourceTags",
        "kms:ListAliases"
      ],
      "Resource": "*"
    }
  ]
}
```

#### Policy 3: Lambda and IAM Permissions

**Policy Name:** `EmailPlatformLambdaDeploymentPolicy`

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LambdaFunctionManagement",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateFunction",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:DeleteFunction",
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:ListFunctions",
        "lambda:AddPermission",
        "lambda:RemovePermission",
        "lambda:TagResource",
        "lambda:UntagResource",
        "lambda:ListTags",
        "lambda:PublishVersion"
      ],
      "Resource": [
        "arn:aws:lambda:eu-west-2:*:function:dev-email-*",
        "arn:aws:lambda:eu-west-2:*:function:prod-email-*"
      ]
    },
    {
      "Sid": "IAMRoleManagement",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:PassRole",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetRolePolicy",
        "iam:TagRole",
        "iam:UntagRole"
      ],
      "Resource": [
        "arn:aws:iam::*:role/dev-email-*",
        "arn:aws:iam::*:role/prod-email-*"
      ]
    },
    {
      "Sid": "IAMPolicyManagement",
      "Effect": "Allow",
      "Action": [
        "iam:CreatePolicy",
        "iam:DeletePolicy",
        "iam:GetPolicy",
        "iam:GetPolicyVersion",
        "iam:ListPolicyVersions",
        "iam:CreatePolicyVersion",
        "iam:DeletePolicyVersion"
      ],
      "Resource": [
        "arn:aws:iam::*:policy/dev-email-*",
        "arn:aws:iam::*:policy/prod-email-*"
      ]
    }
  ]
}
```

#### Policy 4: API Gateway Permissions (for stack updates)

**Policy Name:** `EmailPlatformAPIGatewayDeploymentPolicy`

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "APIGatewayManagement",
      "Effect": "Allow",
      "Action": [
        "apigateway:GET",
        "apigateway:POST",
        "apigateway:PUT",
        "apigateway:PATCH",
        "apigateway:DELETE",
        "apigateway:UpdateRestApiPolicy"
      ],
      "Resource": [
        "arn:aws:apigateway:eu-west-2::/apis",
        "arn:aws:apigateway:eu-west-2::/apis/*"
      ]
    }
  ]
}
```

### Attaching Policies to AWS CLI User

```bash
# Get your AWS CLI user ARN
aws sts get-caller-identity

# Attach policies (replace USER_NAME with your IAM user)
aws iam attach-user-policy \
  --user-name USER_NAME \
  --policy-arn arn:aws:iam::ACCOUNT_ID:policy/EmailPlatformCDKDeploymentPolicy

aws iam attach-user-policy \
  --user-name USER_NAME \
  --policy-arn arn:aws:iam::ACCOUNT_ID:policy/EmailPlatformDynamoDBDeploymentPolicy

aws iam attach-user-policy \
  --user-name USER_NAME \
  --policy-arn arn:aws:iam::ACCOUNT_ID:policy/EmailPlatformLambdaDeploymentPolicy

aws iam attach-user-policy \
  --user-name USER_NAME \
  --policy-arn arn:aws:iam::ACCOUNT_ID:policy/EmailPlatformAPIGatewayDeploymentPolicy
```

---

## Pre-Deployment Verification

### 1. Code Compilation Check

```bash
# Ensure you're in the project root
cd /Users/halponton/Development/email.ponton.io

# Install dependencies
npm install

# Compile TypeScript
npm run build

# Expected output: No errors
```

### 2. CDK Synthesis Check

```bash
# Synthesize dev environment
npx cdk synth --context environment=dev

# Expected output: CloudFormation templates generated in cdk.out/
# Look for:
# - dev-email-certificate.template.json
# - dev-email-dynamodb.template.json
# - dev-email-api-gateway.template.json
```

### 3. Security Audit

```bash
# Check for vulnerabilities
npm audit

# Expected output: 0 vulnerabilities
```

### 4. AWS Credentials Verification

```bash
# Verify AWS credentials are configured
aws sts get-caller-identity --region eu-west-2

# Expected output:
# {
#     "UserId": "AIDAI...",
#     "Account": "123456789012",
#     "Arn": "arn:aws:iam::123456789012:user/your-user"
# }
```

### 5. CDK Bootstrap Check

```bash
# Verify CDK is bootstrapped in eu-west-2
aws cloudformation describe-stacks \
  --stack-name CDKToolkit \
  --region eu-west-2 \
  --query 'Stacks[0].StackStatus'

# Expected output: "CREATE_COMPLETE" or "UPDATE_COMPLETE"
# If stack doesn't exist, run:
# npx cdk bootstrap aws://ACCOUNT_ID/eu-west-2
```

---

## Deployment Commands

### Development Environment Deployment

#### Step 1: Deploy DynamoDB Stack

```bash
# Deploy DynamoDB tables and KMS key
npx cdk deploy dev-email-dynamodb \
  --context environment=dev \
  --require-approval never \
  --region eu-west-2

# Expected output:
# ✅  dev-email-dynamodb
#
# Outputs:
# dev-email-dynamodb.SubscribersTableName = dev-email-subscribers
# dev-email-dynamodb.SubscribersTableArn = arn:aws:dynamodb:eu-west-2:...
# dev-email-dynamodb.AuditEventsTableName = dev-email-audit-events
# dev-email-dynamodb.EngagementEventsTableName = dev-email-engagement-events
# dev-email-dynamodb.CampaignsTableName = dev-email-campaigns
# dev-email-dynamodb.DeliveriesTableName = dev-email-deliveries
# dev-email-dynamodb.EncryptionKeyArn = arn:aws:kms:eu-west-2:...
#
# Stack ARN:
# arn:aws:cloudformation:eu-west-2:...:stack/dev-email-dynamodb/...
```

**Deployment Time:** ~2-3 minutes

#### Step 2: Deploy API Gateway Stack (Update)

The API Gateway stack needs to be updated to include Lambda permissions for the new DynamoDB tables.

```bash
# Update API Gateway stack with DynamoDB table references
npx cdk deploy dev-email-api-gateway \
  --context environment=dev \
  --require-approval never \
  --region eu-west-2

# Expected output:
# ✅  dev-email-api-gateway
#
# Outputs:
# dev-email-api-gateway.ApiEndpoint = https://api-dev.email.ponton.io
# dev-email-api-gateway.HealthEndpoint = https://api-dev.email.ponton.io/health
#
# Stack ARN:
# arn:aws:cloudformation:eu-west-2:...:stack/dev-email-api-gateway/...
```

**Deployment Time:** ~1-2 minutes (stack update, not full deploy)

#### Step 3: Verify Stack Dependencies

```bash
# List all email platform stacks in correct dependency order
aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query 'StackSummaries[?contains(StackName, `dev-email`)].{Name:StackName, Status:StackStatus, Created:CreationTime}' \
  --region eu-west-2 \
  --output table
```

Expected order:
1. `dev-email-certificate` (Milestone 0)
2. `dev-email-dynamodb` (Milestone 2 - NEW)
3. `dev-email-api-gateway` (Milestone 1 - UPDATED)

### Production Environment Deployment

**⚠️ IMPORTANT:** Only deploy to production after thorough testing in dev.

```bash
# 1. Deploy DynamoDB stack to prod
npx cdk deploy prod-email-dynamodb \
  --context environment=prod \
  --require-approval broadening \
  --region eu-west-2

# 2. Update API Gateway stack for prod
npx cdk deploy prod-email-api-gateway \
  --context environment=prod \
  --require-approval broadening \
  --region eu-west-2
```

**Key Differences in Prod:**
- Point-in-Time Recovery enabled on all business tables
- Deletion protection enabled on all tables
- KMS key has `RemovalPolicy.RETAIN` (not deleted on stack deletion)
- Requires explicit approval for security-impacting changes

---

## Post-Deployment Verification

### 1. Verify DynamoDB Tables Created

```bash
# List all email platform tables
aws dynamodb list-tables \
  --region eu-west-2 \
  --query 'TableNames[?starts_with(@, `dev-email-`)]' \
  --output json

# Expected output:
# [
#     "dev-email-audit-events",
#     "dev-email-campaigns",
#     "dev-email-deliveries",
#     "dev-email-engagement-events",
#     "dev-email-subscribers"
# ]
```

### 2. Verify Table Configurations

#### Subscribers Table

```bash
aws dynamodb describe-table \
  --table-name dev-email-subscribers \
  --region eu-west-2 \
  --query '{TableName:Table.TableName, Status:Table.TableStatus, BillingMode:Table.BillingModeSummary.BillingMode, GSIs:Table.GlobalSecondaryIndexes[].IndexName, Encryption:Table.SSEDescription.SSEType, PITR:Table.ContinuousBackups.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus}'

# Expected output:
# {
#     "TableName": "dev-email-subscribers",
#     "Status": "ACTIVE",
#     "BillingMode": "PAY_PER_REQUEST",
#     "GSIs": [
#         "EmailHashIndex",
#         "ConfirmTokenIndex",
#         "UnsubscribeTokenIndex",
#         "StateIndex"
#     ],
#     "Encryption": "KMS",
#     "PITR": "DISABLED"  (dev) or "ENABLED" (prod)
# }
```

#### AuditEvents Table

```bash
aws dynamodb describe-table \
  --table-name dev-email-audit-events \
  --region eu-west-2 \
  --query '{TableName:Table.TableName, GSIs:Table.GlobalSecondaryIndexes[].{Name:IndexName, ProjectionType:Projection.ProjectionType, Attributes:Projection.NonKeyAttributes}, Encryption:Table.SSEDescription.SSEType}'

# Expected output:
# {
#     "TableName": "dev-email-audit-events",
#     "GSIs": [
#         {
#             "Name": "SubscriberEventsIndex",
#             "ProjectionType": "INCLUDE",
#             "Attributes": [
#                 "eventType",
#                 "actorType"
#             ]
#         }
#     ],
#     "Encryption": "KMS"
# }
```

**✅ CRITICAL:** Verify `ProjectionType` is `INCLUDE`, not `ALL` (security fix from review).

#### EngagementEvents Table

```bash
aws dynamodb describe-table \
  --table-name dev-email-engagement-events \
  --region eu-west-2 \
  --query '{TableName:Table.TableName, TTL:Table.TimeToLiveDescription, Encryption:Table.SSEDescription.SSEType}'

# Expected output:
# {
#     "TableName": "dev-email-engagement-events",
#     "TTL": {
#         "TimeToLiveStatus": "ENABLED",
#         "AttributeName": "expiresAt"
#     },
#     "Encryption": "DEFAULT"  (AWS-managed, not CMK)
# }
```

**✅ CRITICAL:** Verify TTL is `ENABLED` on `expiresAt` attribute.

### 3. Verify KMS Key Configuration

```bash
# Get KMS key ARN from CloudFormation outputs
KEY_ARN=$(aws cloudformation describe-stacks \
  --stack-name dev-email-dynamodb \
  --region eu-west-2 \
  --query 'Stacks[0].Outputs[?OutputKey==`EncryptionKeyArn`].OutputValue' \
  --output text)

# Verify key rotation is enabled
aws kms get-key-rotation-status \
  --key-id $KEY_ARN \
  --region eu-west-2

# Expected output:
# {
#     "KeyRotationEnabled": true
# }

# Verify key policy includes DynamoDB service principal
aws kms get-key-policy \
  --key-id $KEY_ARN \
  --policy-name default \
  --region eu-west-2 \
  --query 'Policy' \
  --output text | jq '.Statement[] | select(.Sid == "Allow DynamoDB to use the key")'

# Expected output should include:
# {
#   "Sid": "Allow DynamoDB to use the key",
#   "Effect": "Allow",
#   "Principal": {
#     "Service": "dynamodb.amazonaws.com"
#   },
#   "Action": [
#     "kms:Decrypt",
#     "kms:Encrypt",
#     ...
#   ],
#   "Condition": {
#     "StringEquals": {
#       "kms:ViaService": "dynamodb.eu-west-2.amazonaws.com",
#       ...
#     }
#   }
# }
```

### 4. Verify Lambda Function IAM Permissions

```bash
# Get notImplementedFunction role name
ROLE_NAME=$(aws lambda get-function \
  --function-name dev-email-api-not-implemented \
  --region eu-west-2 \
  --query 'Configuration.Role' \
  --output text | awk -F/ '{print $NF}')

# List attached policies (should only see CloudWatch Logs, NOT DynamoDB)
aws iam list-attached-role-policies \
  --role-name $ROLE_NAME \
  --region eu-west-2

# Expected output:
# {
#     "AttachedPolicies": [
#         {
#             "PolicyName": "AWSLambdaBasicExecutionRole",
#             "PolicyArn": "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
#         }
#     ]
# }

# List inline policies (should be EMPTY)
aws iam list-role-policies \
  --role-name $ROLE_NAME \
  --region eu-west-2

# Expected output:
# {
#     "PolicyNames": []
# }
```

**✅ CRITICAL:** Verify notImplementedFunction has NO DynamoDB permissions (security fix).

### 5. Verify Lambda Function Environment Variables

```bash
# Check notImplementedFunction environment variables
aws lambda get-function-configuration \
  --function-name dev-email-api-not-implemented \
  --region eu-west-2 \
  --query 'Environment.Variables'

# Expected output (NO table names):
# {
#     "ENVIRONMENT": "dev",
#     "REGION": "eu-west-2",
#     "LOG_LEVEL": "info"
# }
```

**✅ CRITICAL:** Verify NO table name environment variables are present (security fix).

---

## Testing Procedures

### Test 1: Health Endpoint Accessibility

```bash
# Test health endpoint
curl -i https://api-dev.email.ponton.io/health

# Expected response:
# HTTP/2 200
# content-type: application/json
# cache-control: no-cache, no-store, must-revalidate
# x-environment: dev
#
# {
#   "status": "healthy",
#   "timestamp": "2025-12-28T...",
#   "service": "email.ponton.io",
#   "version": "0.1.0"
# }
```

**✅ PASS:** Status code 200, JSON response with correct structure

### Test 2: Not Implemented Endpoints

```bash
# Test subscribe endpoint (not yet implemented)
curl -i -X POST https://api-dev.email.ponton.io/v1/subscribe \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}'

# Expected response:
# HTTP/2 501
# content-type: application/json
#
# {
#   "error": "Not Implemented",
#   "message": "This endpoint is not yet implemented. Check back in future milestones."
# }
```

**✅ PASS:** Status code 501, correct error message

### Test 3: Admin Endpoint Authorization

```bash
# Test admin endpoint without authorization (should be blocked)
curl -i https://api-dev.email.ponton.io/admin/campaigns

# Expected response:
# HTTP/2 401
# content-type: application/json
#
# {
#   "message": "Unauthorized"
# }
```

**✅ PASS:** Status code 401 (deny-all authorizer working correctly)

### Test 4: DynamoDB Table Write Test (Manual)

Test writing to Subscribers table to verify encryption and GSIs:

```bash
# Insert a test subscriber record
aws dynamodb put-item \
  --table-name dev-email-subscribers \
  --region eu-west-2 \
  --item '{
    "subscriberId": {"S": "01JGTEST000000000000000000"},
    "email": {"S": "test@example.com"},
    "emailNormalized": {"S": "test@example.com"},
    "emailNormalizedHash": {"S": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
    "state": {"S": "PENDING"},
    "createdAt": {"N": "1735401600000"},
    "updatedAt": {"N": "1735401600000"}
  }'

# Expected output:
# (no output = success)

# Query the record back
aws dynamodb get-item \
  --table-name dev-email-subscribers \
  --region eu-west-2 \
  --key '{"subscriberId": {"S": "01JGTEST000000000000000000"}}'

# Expected output: The item you just inserted

# Test GSI query (EmailHashIndex)
aws dynamodb query \
  --table-name dev-email-subscribers \
  --region eu-west-2 \
  --index-name EmailHashIndex \
  --key-condition-expression "emailNormalizedHash = :hash" \
  --expression-attribute-values '{":hash":{"S":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}}'

# Expected output: The item retrieved via GSI

# Clean up test data
aws dynamodb delete-item \
  --table-name dev-email-subscribers \
  --region eu-west-2 \
  --key '{"subscriberId": {"S": "01JGTEST000000000000000000"}}'
```

**✅ PASS:** Item written, retrieved via base table, retrieved via GSI, deleted successfully

### Test 5: TTL Test (EngagementEvents)

Test TTL configuration:

```bash
# Insert engagement event with TTL set to 1 hour from now (for testing)
CURRENT_EPOCH=$(date +%s)
EXPIRES_AT=$((CURRENT_EPOCH + 3600))  # 1 hour from now

aws dynamodb put-item \
  --table-name dev-email-engagement-events \
  --region eu-west-2 \
  --item '{
    "eventId": {"S": "01JGTEST000000000000000001"},
    "subscriberId": {"S": "01JGTEST000000000000000000"},
    "campaignId": {"S": "01JGTEST000000000000000002"},
    "deliveryId": {"S": "01JGTEST000000000000000003"},
    "eventType": {"S": "OPEN"},
    "timestamp": {"N": "'"$((CURRENT_EPOCH * 1000))"'"},
    "expiresAt": {"N": "'"$EXPIRES_AT"'"}
  }'

# Verify TTL attribute is set correctly
aws dynamodb get-item \
  --table-name dev-email-engagement-events \
  --region eu-west-2 \
  --key '{"eventId": {"S": "01JGTEST000000000000000001"}}' \
  --query 'Item.expiresAt.N'

# Expected output: Unix timestamp (seconds) approximately 3600 seconds from now
```

**✅ PASS:** TTL attribute present and in correct format (seconds, not milliseconds)

**Note:** TTL deletion happens within 48 hours of expiration. The item won't be deleted immediately.

### Test 6: CloudWatch Logs Verification

```bash
# Check Lambda function logs
aws logs tail /aws/lambda/dev-email-api-not-implemented \
  --region eu-west-2 \
  --follow

# Make a request to trigger logging
curl https://api-dev.email.ponton.io/v1/subscribe

# Expected log output:
# 2025-12-28T... INFO Route not implemented: /v1/subscribe
# 2025-12-28T... INFO Returning 501 Not Implemented response
```

**✅ PASS:** Logs appear in CloudWatch, no errors logged

### Test 7: Security Verification

```bash
# Verify tables are encrypted
for table in dev-email-subscribers dev-email-audit-events dev-email-campaigns dev-email-deliveries dev-email-engagement-events; do
  echo "Checking encryption for $table:"
  aws dynamodb describe-table \
    --table-name $table \
    --region eu-west-2 \
    --query 'Table.SSEDescription.{Status:Status, Type:SSEType, KMSKey:KMSMasterKeyArn}' \
    --output json
  echo ""
done

# Expected output for each table:
# Subscribers, AuditEvents, Campaigns, Deliveries: SSEType = "KMS"
# EngagementEvents: SSEType = "DEFAULT" (AWS-managed)
```

**✅ PASS:** All sensitive tables use KMS encryption

---

## Rollback Procedures

### Scenario 1: DynamoDB Stack Deployment Fails

```bash
# Check stack status
aws cloudformation describe-stacks \
  --stack-name dev-email-dynamodb \
  --region eu-west-2 \
  --query 'Stacks[0].StackStatus'

# If status is ROLLBACK_COMPLETE or CREATE_FAILED:
# 1. Check CloudFormation events for error details
aws cloudformation describe-stack-events \
  --stack-name dev-email-dynamodb \
  --region eu-west-2 \
  --max-items 20

# 2. Delete the failed stack
aws cloudformation delete-stack \
  --stack-name dev-email-dynamodb \
  --region eu-west-2

# 3. Wait for deletion to complete
aws cloudformation wait stack-delete-complete \
  --stack-name dev-email-dynamodb \
  --region eu-west-2

# 4. Fix the issue in code
# 5. Redeploy
npx cdk deploy dev-email-dynamodb --context environment=dev
```

### Scenario 2: Need to Rollback to Milestone 1 (Remove DynamoDB)

```bash
# 1. Update API Gateway stack to remove DynamoDB references
#    (Revert code changes in api-gateway-stack.ts)

# 2. Deploy API Gateway stack update
npx cdk deploy dev-email-api-gateway --context environment=dev

# 3. Delete DynamoDB stack
npx cdk destroy dev-email-dynamodb --context environment=dev

# WARNING: This will delete all DynamoDB tables and data
# In production, tables with DeletionProtection cannot be deleted via CDK
```

### Scenario 3: Production Rollback (CRITICAL)

**⚠️ PRODUCTION ROLLBACK IS HIGH RISK**

Production tables have:
- `DeletionProtection: true` (cannot be deleted via CloudFormation)
- `RemovalPolicy: RETAIN` for KMS key (key not deleted on stack deletion)

To rollback production:

```bash
# 1. DO NOT use `cdk destroy` - it will fail due to deletion protection

# 2. Manually disable deletion protection on each table
for table in prod-email-subscribers prod-email-audit-events prod-email-campaigns prod-email-deliveries prod-email-engagement-events; do
  aws dynamodb update-table \
    --table-name $table \
    --region eu-west-2 \
    --no-deletion-protection-enabled
done

# 3. Now you can delete the stack
npx cdk destroy prod-email-dynamodb --context environment=prod

# 4. KMS key will remain (RETAIN policy) - this is intentional for compliance
```

**RECOMMENDATION:** Instead of rollback, consider fixing forward by deploying a patch.

---

## Troubleshooting

### Issue 1: "Table already exists" Error

**Error:**
```
ResourceAlreadyExistsException: Table dev-email-subscribers already exists
```

**Cause:** Previous deployment left tables behind

**Solution:**
```bash
# List existing tables
aws dynamodb list-tables --region eu-west-2

# Option A: Delete tables manually
aws dynamodb delete-table --table-name dev-email-subscribers --region eu-west-2
# (Repeat for other tables)

# Option B: Use CDK destroy and redeploy
npx cdk destroy dev-email-dynamodb --context environment=dev
npx cdk deploy dev-email-dynamodb --context environment=dev
```

### Issue 2: KMS Permission Denied

**Error:**
```
User is not authorized to perform: kms:CreateKey
```

**Cause:** IAM user lacks KMS permissions

**Solution:**
```bash
# Verify your IAM user has KMS permissions
aws iam get-user-policy \
  --user-name YOUR_USER \
  --policy-name EmailPlatformDynamoDBDeploymentPolicy

# If missing, attach the policy from IAM Policies Required section
```

### Issue 3: CDK Synth Fails with TypeScript Errors

**Error:**
```
npx cdk synth
Error: ... TypeScript compilation failed
```

**Cause:** Code changes broke TypeScript compilation

**Solution:**
```bash
# Check for TypeScript errors
npm run build

# Fix errors in source files
# Common issues:
# - Missing imports
# - Type mismatches
# - Syntax errors

# Verify fix
npm run build
npx cdk synth --context environment=dev
```

### Issue 4: Lambda Function Has No Permissions After Deployment

**Symptom:** Lambda logs show "AccessDeniedException" when accessing DynamoDB

**Cause:** This should NOT happen if security fixes were applied correctly

**Verification:**
```bash
# Check Lambda IAM role policies
ROLE_NAME=$(aws lambda get-function \
  --function-name dev-email-api-not-implemented \
  --region eu-west-2 \
  --query 'Configuration.Role' \
  --output text | awk -F/ '{print $NF}')

aws iam list-attached-role-policies --role-name $ROLE_NAME
aws iam list-role-policies --role-name $ROLE_NAME
```

**Expected for notImplementedFunction:** ZERO DynamoDB policies (this is correct per security fixes)

**For future handlers:** Check that `grantReadWriteData()` was called in the stack code

### Issue 5: API Gateway Returns 500 Internal Server Error

**Cause:** Lambda function error

**Solution:**
```bash
# Check Lambda logs
aws logs tail /aws/lambda/dev-email-api-health --region eu-west-2 --follow

# Look for error stack traces
# Common issues:
# - Missing environment variables
# - Runtime errors in handler code
# - Timeout issues
```

### Issue 6: GSI Not Queryable

**Error:**
```
ValidationException: The provided key element does not match the schema
```

**Cause:** GSI not yet active or wrong key used

**Solution:**
```bash
# Check GSI status
aws dynamodb describe-table \
  --table-name dev-email-subscribers \
  --region eu-west-2 \
  --query 'Table.GlobalSecondaryIndexes[].{Name:IndexName, Status:IndexStatus}'

# Expected output: "IndexStatus": "ACTIVE" for all GSIs
# If CREATING, wait a few minutes and try again
```

---

## Success Criteria Checklist

Use this checklist to confirm Milestone 2 deployment is complete:

### Infrastructure

- [ ] DynamoDB stack deployed successfully (`dev-email-dynamodb`)
- [ ] API Gateway stack updated successfully (`dev-email-api-gateway`)
- [ ] All 5 DynamoDB tables created (`subscribers`, `audit-events`, `engagement-events`, `campaigns`, `deliveries`)
- [ ] All 11 GSIs created and ACTIVE
- [ ] KMS key created with rotation enabled
- [ ] KMS key policy includes DynamoDB service principal

### Security

- [ ] Subscribers table uses KMS encryption (CMK)
- [ ] AuditEvents table uses KMS encryption (CMK)
- [ ] Campaigns table uses KMS encryption (CMK)
- [ ] Deliveries table uses KMS encryption (CMK)
- [ ] EngagementEvents table uses AWS-managed encryption
- [ ] AuditEvents GSI uses `ProjectionType.INCLUDE` (not ALL)
- [ ] notImplementedFunction has ZERO DynamoDB permissions
- [ ] notImplementedFunction has NO table name environment variables
- [ ] TTL enabled on EngagementEvents (`expiresAt` attribute)

### Environment-Specific (Dev)

- [ ] Point-in-Time Recovery DISABLED on all tables (cost optimization)
- [ ] Deletion protection DISABLED on all tables (flexibility)
- [ ] KMS key RemovalPolicy is DESTROY

### Environment-Specific (Prod)

- [ ] Point-in-Time Recovery ENABLED on business tables
- [ ] Deletion protection ENABLED on all tables
- [ ] KMS key RemovalPolicy is RETAIN

### Testing

- [ ] Health endpoint returns 200 OK
- [ ] Not implemented endpoints return 501
- [ ] Admin endpoints return 401 (deny-all authorizer)
- [ ] Test write to Subscribers table succeeds
- [ ] GSI query on EmailHashIndex succeeds
- [ ] TTL attribute set correctly (Unix seconds)
- [ ] CloudWatch logs show Lambda execution
- [ ] No errors in CloudWatch logs

### Documentation

- [ ] README.md updated with Milestone 2 status
- [ ] CloudFormation outputs documented
- [ ] This deployment guide reviewed and followed

---

## Next Steps After Successful Deployment

1. **Verify Monitoring:**
   - Check CloudWatch Logs for Lambda functions
   - Verify no error logs present

2. **Plan Milestone 3:**
   - Review `plans.md` for Milestone 3 requirements
   - Prepare Secrets Manager for HMAC email hashing key
   - Prepare SSM parameters for configuration

3. **Security Review:**
   - Schedule security review of deployed infrastructure
   - Test IAM permissions are minimal (principle of least privilege)
   - Verify encryption at rest for all sensitive tables

4. **Cost Monitoring:**
   - Set up CloudWatch billing alarms
   - Monitor DynamoDB on-demand capacity charges
   - Review KMS key usage charges

---

## Contact and Support

**Questions or Issues?**
- GitHub Issues: https://github.com/anthropics/claude-code/issues
- Documentation: See `README.md` and `PLATFORM_INVARIANTS.md`

**Emergency Rollback Contact:**
- [Your Operations Team Contact]

---

**Document Version History:**

- v1.0 (2025-12-28): Initial deployment guide for Milestone 2
