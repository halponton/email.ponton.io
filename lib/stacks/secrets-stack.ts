import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { EnvironmentConfig, envResourceName } from '../config/environments';
import { SecretsConstruct } from '../constructs/secrets';
import { SSMParametersConstruct } from '../constructs/ssm-parameters';
import * as kms from 'aws-cdk-lib/aws-kms';

/**
 * Props for SecretsStack
 */
export interface SecretsStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
}

/**
 * Secrets Stack
 *
 * Creates AWS Secrets Manager secrets and SSM Parameter Store parameters
 * for the email platform.
 *
 * Components:
 * 1. SecretsConstruct - HMAC secrets for token generation and email hashing
 * 2. SSMParametersConstruct - Non-secret configuration (SES, API, tracking, retention)
 *
 * Security Architecture:
 * - Secrets use a dedicated CMK for Secrets Manager
 * - Environment-scoped naming for isolation
 * - RemovalPolicy.RETAIN for prod secrets/parameters
 * - CloudTrail logging enabled by default
 * - Secrets are generated automatically at deployment time
 *
 * Per PLATFORM_INVARIANTS.md section 4:
 * - No hardcoded secrets, ever
 * - Secrets live in AWS Secrets Manager
 * - Non-secret configuration lives in SSM Parameter Store
 * - Distinct secrets and parameters per environment
 *
 * Stack Dependencies:
 * - Independent of DynamoDB stack (dedicated CMK)
 * - Must be deployed before API Gateway stack (Lambda functions need secrets/parameters)
 *
 * Cost Optimization:
 * - Dedicated CMK: ~$1/month per environment
 * - SSM parameters use Standard tier (free)
 * - Secrets Manager: $0.40/secret/month + $0.05/10,000 API calls
 *   - Dev: ~$0.80/month (2 secrets)
 *   - Prod: ~$0.80/month (2 secrets)
 */
export class SecretsStack extends cdk.Stack {
  /** Secrets construct containing HMAC secrets */
  public readonly secrets: SecretsConstruct;

  /** SSM parameters construct containing configuration */
  public readonly parameters: SSMParametersConstruct;

  constructor(scope: Construct, id: string, props: SecretsStackProps) {
    super(scope, id, props);

    const { config } = props;
    const removalPolicy = config.secrets.retainOnDelete
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY;

    /**
     * Dedicated CMK for Secrets Manager
     *
     * Keeps Secrets Manager access scoped to its own key (least privilege).
     */
    const secretsKey = new kms.Key(this, 'SecretsEncryptionKey', {
      alias: `alias/${envResourceName(config.env, 'email-secrets-key')}`,
      description: `Encryption key for Secrets Manager (${config.env})`,
      enableKeyRotation: true,
      removalPolicy,
    });

    const accountId = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;

    // Allow Secrets Manager to use the key for encryption/decryption
    secretsKey.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'AllowSecretsManagerUse',
        effect: cdk.aws_iam.Effect.ALLOW,
        principals: [new cdk.aws_iam.ServicePrincipal('secretsmanager.amazonaws.com')],
        actions: [
          'kms:Decrypt',
          'kms:Encrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:CreateGrant',
          'kms:DescribeKey',
        ],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'kms:ViaService': `secretsmanager.${region}.amazonaws.com`,
            'kms:CallerAccount': accountId,
          },
        },
      })
    );

    // Add tags to the key
    cdk.Tags.of(secretsKey).add('Environment', config.env);
    cdk.Tags.of(secretsKey).add('ManagedBy', 'CDK');
    cdk.Tags.of(secretsKey).add('Project', 'email.ponton.io');

    // Create secrets
    this.secrets = new SecretsConstruct(this, 'Secrets', {
      config,
      encryptionKey: secretsKey,
    });

    // Create SSM parameters
    this.parameters = new SSMParametersConstruct(this, 'Parameters', {
      config,
    });

    // CloudFormation outputs for secrets and parameters

    // Secrets outputs
    new cdk.CfnOutput(this, 'TokenHmacSecretArn', {
      value: this.secrets.tokenHmacSecret.secretArn,
      description: 'ARN of token HMAC secret',
      exportName: envResourceName(config.env, 'TokenHmacSecretArn'),
    });

    new cdk.CfnOutput(this, 'TokenHmacSecretName', {
      value: this.secrets.tokenHmacSecret.secretName,
      description: 'Name of token HMAC secret',
      exportName: envResourceName(config.env, 'TokenHmacSecretName'),
    });

    new cdk.CfnOutput(this, 'EmailHashHmacSecretArn', {
      value: this.secrets.emailHashHmacSecret.secretArn,
      description: 'ARN of email hash HMAC secret',
      exportName: envResourceName(config.env, 'EmailHashHmacSecretArn'),
    });

    new cdk.CfnOutput(this, 'EmailHashHmacSecretName', {
      value: this.secrets.emailHashHmacSecret.secretName,
      description: 'Name of email hash HMAC secret',
      exportName: envResourceName(config.env, 'EmailHashHmacSecretName'),
    });

    // SSM parameter outputs
    new cdk.CfnOutput(this, 'SesVerifiedDomainParameter', {
      value: this.parameters.sesVerifiedDomain.parameterName,
      description: 'SSM parameter name for SES verified domain',
      exportName: envResourceName(config.env, 'SesVerifiedDomainParameter'),
    });

    new cdk.CfnOutput(this, 'SesFromEmailParameter', {
      value: this.parameters.sesFromEmail.parameterName,
      description: 'SSM parameter name for SES from email',
      exportName: envResourceName(config.env, 'SesFromEmailParameter'),
    });

    new cdk.CfnOutput(this, 'SesFromNameParameter', {
      value: this.parameters.sesFromName.parameterName,
      description: 'SSM parameter name for SES from name',
      exportName: envResourceName(config.env, 'SesFromNameParameter'),
    });

    new cdk.CfnOutput(this, 'ApiBaseUrlParameter', {
      value: this.parameters.apiBaseUrl.parameterName,
      description: 'SSM parameter name for API base URL',
      exportName: envResourceName(config.env, 'ApiBaseUrlParameter'),
    });

    new cdk.CfnOutput(this, 'ClickRedirectBaseUrlParameter', {
      value: this.parameters.clickRedirectBaseUrl.parameterName,
      description: 'SSM parameter name for click tracking base URL',
      exportName: envResourceName(config.env, 'ClickRedirectBaseUrlParameter'),
    });

    new cdk.CfnOutput(this, 'OpenPixelBaseUrlParameter', {
      value: this.parameters.openPixelBaseUrl.parameterName,
      description: 'SSM parameter name for open tracking base URL',
      exportName: envResourceName(config.env, 'OpenPixelBaseUrlParameter'),
    });

    new cdk.CfnOutput(this, 'EngagementTtlDaysParameter', {
      value: this.parameters.engagementTtlDays.parameterName,
      description: 'SSM parameter name for engagement events TTL days',
      exportName: envResourceName(config.env, 'EngagementTtlDaysParameter'),
    });

    // Add tags
    cdk.Tags.of(this).add('Environment', config.env);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Project', 'email.ponton.io');
  }
}
