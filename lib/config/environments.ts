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

  /** Base domain for the platform */
  readonly domain: string;

  /** API subdomain (e.g., api.email.ponton.io) */
  readonly apiDomain: string;

  /** Whether SES is in sandbox mode (dev only) */
  readonly sesSandbox: boolean;

  /** CloudWatch log retention in days */
  readonly logRetentionDays: number;

  /** Route53 hosted zone name (parent domain) */
  readonly hostedZoneName: string;

  /** Whether to enable detailed monitoring */
  readonly enableDetailedMonitoring: boolean;
}

/**
 * Development environment configuration
 */
export const DEV_CONFIG: EnvironmentConfig = {
  env: 'dev',
  region: 'us-east-1',
  domain: 'email.ponton.io',
  apiDomain: 'api.email.ponton.io',
  sesSandbox: true,
  logRetentionDays: 180, // 6 months per PLATFORM_INVARIANTS.md section 11
  hostedZoneName: 'ponton.io',
  enableDetailedMonitoring: false,
};

/**
 * Production environment configuration
 */
export const PROD_CONFIG: EnvironmentConfig = {
  env: 'prod',
  region: 'us-east-1',
  domain: 'email.ponton.io',
  apiDomain: 'api.email.ponton.io',
  sesSandbox: false,
  logRetentionDays: 180, // 6 months per PLATFORM_INVARIANTS.md section 11
  hostedZoneName: 'ponton.io',
  enableDetailedMonitoring: true,
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
