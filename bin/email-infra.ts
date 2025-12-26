#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CertificateStack } from '../lib/stacks/certificate-stack';
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
 * - ACM certificate for api.email.ponton.io
 * - API Gateway HTTP API with custom domain
 * - Route53 alias record
 * - Placeholder Lambda functions
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
const apiGatewayStackName = `${config.env}-email-api-gateway`;

/**
 * Certificate Stack
 *
 * Must be deployed first as API Gateway stack depends on it.
 * Creates ACM certificate in us-east-1 for API Gateway custom domain.
 */
const certificateStack = new CertificateStack(app, certificateStackName, {
  env,
  config,
  description: `ACM certificate for api.email.ponton.io (${config.env})`,
  stackName: certificateStackName,
});

/**
 * API Gateway Stack
 *
 * Depends on Certificate Stack for ACM certificate and Route53 hosted zone.
 * Creates HTTP API with custom domain and all routes.
 */
const apiGatewayStack = new ApiGatewayStack(app, apiGatewayStackName, {
  env,
  config,
  certificate: certificateStack.certificate,
  hostedZone: certificateStack.hostedZone,
  description: `API Gateway and Lambda functions for email.ponton.io (${config.env})`,
  stackName: apiGatewayStackName,
});

// Explicit dependency to ensure certificate is created first
apiGatewayStack.addDependency(certificateStack);

// Add global tags
cdk.Tags.of(app).add('Project', 'email.ponton.io');
cdk.Tags.of(app).add('ManagedBy', 'CDK');
cdk.Tags.of(app).add('Environment', config.env);

// Synthesize CloudFormation templates
app.synth();
