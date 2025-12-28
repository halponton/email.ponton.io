/**
 * Environment configuration for email.ponton.io infrastructure
 *
 * Per PLATFORM_INVARIANTS.md section 3:
 * - Exactly two environments: dev and prod
 * - Single AWS account
 * - SES sandbox in dev
 * - Distinct secrets and parameters per environment
 */

export interface EnvironmentConfig {
  /** Environment name (dev or prod) */
  readonly env: 'dev' | 'prod';

  /** AWS region for deployment */
  readonly region: string;

  /** API subdomain (e.g., api-dev.email.ponton.io, api.email.ponton.io) */
  readonly apiDomain: string;

  /** Whether SES is in sandbox mode (dev only) */
  readonly sesSandbox: boolean;

  /** Route53 hosted zone name (parent domain) */
  readonly hostedZoneName: string;

  /** Whether to enable detailed monitoring */
  readonly enableDetailedMonitoring: boolean;

  /**
   * DynamoDB configuration
   */
  readonly dynamodb: {
    /**
     * Whether to enable Point-in-Time Recovery (PITR)
     * Recommended: true for prod (data protection), false for dev (cost optimization)
     */
    readonly enablePointInTimeRecovery: boolean;

    /**
     * Whether to enable deletion protection
     * Recommended: true for prod (prevent accidental deletion), false for dev (development flexibility)
     */
    readonly enableDeletionProtection: boolean;
  };
}

/**
 * Development environment configuration
 */
export const DEV_CONFIG: EnvironmentConfig = {
  env: 'dev',
  region: 'eu-west-2',
  apiDomain: 'api-dev.email.ponton.io',
  sesSandbox: true,
  hostedZoneName: 'ponton.io',
  enableDetailedMonitoring: false,
  dynamodb: {
    enablePointInTimeRecovery: false, // Cost optimization for dev
    enableDeletionProtection: false, // Development flexibility
  },
};

/**
 * Production environment configuration
 */
export const PROD_CONFIG: EnvironmentConfig = {
  env: 'prod',
  region: 'eu-west-2',
  apiDomain: 'api.email.ponton.io',
  sesSandbox: false,
  hostedZoneName: 'ponton.io',
  enableDetailedMonitoring: true,
  dynamodb: {
    enablePointInTimeRecovery: true, // Data protection for prod
    enableDeletionProtection: true, // Prevent accidental deletion
  },
};

/**
 * Get environment configuration based on context
 * @param envName - Environment name from CDK context
 * @returns Environment configuration
 */
export function getEnvironmentConfig(envName: string): EnvironmentConfig {
  switch (envName) {
    case 'dev':
      return DEV_CONFIG;
    case 'prod':
      return PROD_CONFIG;
    default:
      throw new Error(
        `Invalid environment: ${envName}. Must be 'dev' or 'prod' per PLATFORM_INVARIANTS.md section 3`
      );
  }
}

/**
 * Generate environment-scoped resource name
 * Per PLATFORM_INVARIANTS.md: All resources must be environment-scoped
 *
 * @param env - Environment name
 * @param resourceName - Base resource name
 * @returns Prefixed resource name (e.g., dev-email-api)
 */
export function envResourceName(env: string, resourceName: string): string {
  return `${env}-${resourceName}`;
}
