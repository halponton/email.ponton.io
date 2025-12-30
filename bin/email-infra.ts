#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CertificateStack } from '../lib/stacks/certificate-stack';
import { DynamoDBStack } from '../lib/stacks/dynamodb-stack';
import { SecretsStack } from '../lib/stacks/secrets-stack';
import { SESStack } from '../lib/stacks/ses-stack';
import { CognitoStack } from '../lib/stacks/cognito-stack';
import { ApiGatewayStack } from '../lib/stacks/api-gateway-stack';
import { getEnvironmentConfig } from '../lib/config/environments';

/**
 * Main CDK application for email.ponton.io infrastructure
 *
 * Deployment instructions:
 * - Dev: npm run deploy:dev
 * - Prod: npm run deploy:prod
 *
 * Per PLATFORM_INVARIANTS.md:
 * - Exactly two environments: dev and prod
 * - Single AWS account
 * - All resources environment-scoped
 *
 * Milestone 1: Domains and API Gateway
 * - ACM certificate for environment-scoped API domain
 * - API Gateway HTTP API with custom domain
 * - Route53 alias record
 * - Placeholder Lambda functions
 *
 * Milestone 2: DynamoDB Tables and GSIs
 * - DynamoDB tables for subscribers, campaigns, deliveries, audit events, engagement events
 * - Global Secondary Indexes for efficient queries
 * - Customer Managed Keys for encryption at rest
 * - Point-in-Time Recovery and deletion protection for prod
 *
 * Milestone 3: Secrets Manager and SSM
 * - AWS Secrets Manager for HMAC secrets (token generation, email hashing)
 * - SSM Parameter Store for non-secret configuration (SES, API, tracking, retention)
 * - Dedicated CMK encryption for Secrets Manager
 * - Environment-scoped naming and distinct values per environment
 *
 * Milestone 4: SES Configuration
 * - SES Email Identity for email.ponton.io with DKIM, SPF, DMARC
 * - SES Configuration Set (environment-scoped)
 * - Event destination pipeline: SNS → SQS → Lambda → DynamoDB
 * - Dead Letter Queue for failed events
 * - Lambda handler for processing delivery, bounce, complaint, reject events
 * - Dedicated KMS key for SES event encryption
 *
 * Milestone 5: Cognito for Admin APIs
 * - Cognito User Pool with MFA and strong password policy
 * - User Pool Client for OAuth Authorization Code Grant
 * - User Pool Domain (OAuth endpoints for admin UI)
 * - Administrators group for admin access
 * - Lambda authorizer for JWT validation with group membership enforcement
 */

const app = new cdk.App();

// Get environment from CDK context
const envName = app.node.tryGetContext('environment');

if (!envName) {
  throw new Error(
    'Environment context required. Use: cdk deploy --context environment=dev|prod'
  );
}

// Load environment configuration
const config = getEnvironmentConfig(envName);

// AWS account and region from environment or CDK defaults
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: config.region,
};

// Stack naming convention: {env}-email-{stack-name}
const certificateStackName = `${config.env}-email-certificate`;
const dynamodbStackName = `${config.env}-email-dynamodb`;
const secretsStackName = `${config.env}-email-secrets`;
const sesStackName = `${config.env}-email-ses`;
const cognitoStackName = `${config.env}-email-cognito`;
const apiGatewayStackName = `${config.env}-email-api-gateway`;

/**
 * Certificate Stack
 *
 * Must be deployed first as API Gateway stack depends on it.
 * Creates ACM certificate in eu-west-2 for the API Gateway custom domain.
 */
const certificateStack = new CertificateStack(app, certificateStackName, {
  env,
  config,
  description: `ACM certificate for ${config.apiDomain} (${config.env})`,
  stackName: certificateStackName,
});

/**
 * DynamoDB Stack
 *
 * Creates all DynamoDB tables and GSIs.
 * Independent of other stacks, can be deployed in parallel with Certificate Stack.
 */
const dynamodbStack = new DynamoDBStack(app, dynamodbStackName, {
  env,
  config,
  description: `DynamoDB tables and GSIs for email.ponton.io (${config.env})`,
  stackName: dynamodbStackName,
});

/**
 * Secrets Stack
 *
 * Creates AWS Secrets Manager secrets and SSM Parameter Store parameters.
 * Uses a dedicated CMK for Secrets Manager.
 * Must be deployed before API Gateway Stack (Lambda functions need secrets/parameters).
 */
const secretsStack = new SecretsStack(app, secretsStackName, {
  env,
  config,
  description: `Secrets Manager and SSM Parameter Store for email.ponton.io (${config.env})`,
  stackName: secretsStackName,
});

/**
 * SES Stack
 *
 * Creates SES configuration for email sending.
 * Depends on Certificate Stack for Route53 hosted zone and DynamoDB Stack for tables.
 * Independent of API Gateway Stack and Secrets Stack.
 */
const sesStack = new SESStack(app, sesStackName, {
  env,
  config,
  hostedZone: certificateStack.hostedZone,
  tables: {
    subscribersTable: dynamodbStack.tables.subscribersTable,
    auditEventsTable: dynamodbStack.tables.auditEventsTable,
    engagementEventsTable: dynamodbStack.tables.engagementEventsTable,
    deliveriesTable: dynamodbStack.tables.deliveriesTable,
  },
  description: `SES configuration for email.ponton.io (${config.env})`,
  stackName: sesStackName,
});

/**
 * Cognito Stack
 *
 * Creates Cognito User Pool for admin authentication.
 * Independent of other stacks.
 */
const cognitoStack = new CognitoStack(app, cognitoStackName, {
  env,
  config,
  description: `Cognito User Pool for admin authentication (${config.env})`,
  stackName: cognitoStackName,
});

/**
 * API Gateway Stack
 *
 * Depends on Certificate Stack for ACM certificate and Route53 hosted zone.
 * Depends on DynamoDB Stack for table references and IAM permissions.
 * Depends on Secrets Stack for secrets and parameters (Lambda environment config).
 * Depends on Cognito Stack for User Pool ID and Client ID (JWT validation).
 * Creates HTTP API with custom domain and all routes.
 */
const apiGatewayStack = new ApiGatewayStack(app, apiGatewayStackName, {
  env,
  config,
  certificate: certificateStack.certificate,
  hostedZone: certificateStack.hostedZone,
  tables: dynamodbStack.tables,
  secrets: secretsStack.secrets,
  parameters: secretsStack.parameters,
  cognitoUserPoolId: cognitoStack.userPool.userPoolId,
  cognitoClientId: cognitoStack.userPoolClient.userPoolClientId,
  description: `API Gateway and Lambda functions for email.ponton.io (${config.env})`,
  stackName: apiGatewayStackName,
});

// Explicit dependencies
sesStack.addDependency(certificateStack);
sesStack.addDependency(dynamodbStack);

apiGatewayStack.addDependency(certificateStack);
apiGatewayStack.addDependency(dynamodbStack);
apiGatewayStack.addDependency(secretsStack);
apiGatewayStack.addDependency(cognitoStack);

// Add global tags
cdk.Tags.of(app).add('Project', 'email.ponton.io');
cdk.Tags.of(app).add('ManagedBy', 'CDK');
cdk.Tags.of(app).add('Environment', config.env);

// Synthesize CloudFormation templates
app.synth();
