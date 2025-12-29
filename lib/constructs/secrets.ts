import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../config/environments';

/**
 * Props for SecretsConstruct
 */
export interface SecretsProps {
  /** Environment configuration */
  readonly config: EnvironmentConfig;

  /**
   * KMS encryption key for secrets
   * Dedicated to Secrets Manager (separate from DynamoDB)
   */
  readonly encryptionKey: kms.IKey;
}

/**
 * Secrets Construct
 *
 * Creates AWS Secrets Manager secrets for the email platform.
 *
 * Secrets created:
 * 1. Token HMAC Secret - For generating and validating secure tokens
 * 2. Email Hash HMAC Secret - For deterministic email hashing
 *
 * Security Architecture:
 * - Environment-scoped naming: /{env}/email/*
 * - CMK encryption using a dedicated Secrets Manager key
 * - RemovalPolicy.RETAIN for prod (prevent accidental secret deletion)
 * - RemovalPolicy.DESTROY for dev (development flexibility)
 * - Secrets are generated automatically at deploy time
 * - CloudTrail logging enabled by default (AWS managed)
 *
 * Per PLATFORM_INVARIANTS.md section 4:
 * - No hardcoded secrets, ever
 * - Secrets live in AWS Secrets Manager
 * - Distinct secrets per environment
 *
 * Security Requirements:
 * - Each secret MUST be at least 32 bytes (256 bits) of cryptographically secure random data
 * - Dev and prod MUST use different secret values
 *
 * Domain Layer Usage:
 * The domain layer (ponton.io_email_service) is responsible for:
 * 1. Retrieving secrets from Secrets Manager on Lambda cold start
 * 2. Caching decoded secrets in memory for the Lambda lifetime
 * 3. Using tokenHmacSecret for HMAC-SHA256 token generation/validation
 * 4. Using emailHashHmacSecret for HMAC-SHA256 email hashing (duplicate prevention)
 */
export class SecretsConstruct extends Construct {
  /**
   * Token HMAC secret for confirm/unsubscribe tokens
   */
  public readonly tokenHmacSecret: secretsmanager.Secret;

  /**
   * Email hash HMAC secret for deterministic hashing
   */
  public readonly emailHashHmacSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: SecretsProps) {
    super(scope, id);

    const { config, encryptionKey } = props;
    const removalPolicy = config.secrets.retainOnDelete
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY;

    /**
     * Token HMAC Secret
     *
     * Environment scoping: /{env}/email/token-hmac-secret
     * - Dev: /dev/email/token-hmac-secret
     * - Prod: /prod/email/token-hmac-secret
     */
    this.tokenHmacSecret = new secretsmanager.Secret(this, 'TokenHmacSecret', {
      secretName: `/${config.env}/email/token-hmac-secret`,
      description: `Token HMAC secret for confirm/unsubscribe (${config.env})`,
      encryptionKey,
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
      },
      removalPolicy,
    });

    /**
     * Email Hash HMAC Secret
     *
     * Environment scoping: /{env}/email/email-hash-hmac-secret
     * - Dev: /dev/email/email-hash-hmac-secret
     * - Prod: /prod/email/email-hash-hmac-secret
     */
    this.emailHashHmacSecret = new secretsmanager.Secret(
      this,
      'EmailHashHmacSecret',
      {
        secretName: `/${config.env}/email/email-hash-hmac-secret`,
        description: `Email hash HMAC secret (${config.env})`,
        encryptionKey,
        generateSecretString: {
          passwordLength: 64,
          excludePunctuation: true,
        },
        removalPolicy,
      }
    );

    // Add tags
    cdk.Tags.of(this.tokenHmacSecret).add('Environment', config.env);
    cdk.Tags.of(this.tokenHmacSecret).add('ManagedBy', 'CDK');
    cdk.Tags.of(this.tokenHmacSecret).add('Project', 'email.ponton.io');
    cdk.Tags.of(this.tokenHmacSecret).add('SecretType', 'TokenHmac');

    cdk.Tags.of(this.emailHashHmacSecret).add('Environment', config.env);
    cdk.Tags.of(this.emailHashHmacSecret).add('ManagedBy', 'CDK');
    cdk.Tags.of(this.emailHashHmacSecret).add('Project', 'email.ponton.io');
    cdk.Tags.of(this.emailHashHmacSecret).add('SecretType', 'EmailHashHmac');
  }
}
