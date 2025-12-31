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
   * API Gateway throttling configuration
   */
  readonly apiGateway: {
    /**
     * Stage-level throttling limits (requests per second)
     */
    readonly throttle: {
      readonly rateLimit: number;
      readonly burstLimit: number;
    };
  };

  /**
   * WAF configuration
   */
  readonly waf: {
    /**
     * Whether to enable WAF rate-based protection
     */
    readonly enable: boolean;

    /**
     * Rate limit per 5-minute period per IP for /admin paths
     */
    readonly adminRateLimit: number;
  };

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

  /**
   * Secrets and parameters configuration
   */
  readonly secrets: {
    /**
     * Whether secrets and parameters should be retained on stack deletion
     * Recommended: true for prod (prevent accidental deletion), false for dev (clean deletion)
     */
    readonly retainOnDelete: boolean;
  };

  /**
   * SES configuration
   */
  readonly ses: {
    /**
     * SES verified domain for sending emails
     */
    readonly verifiedDomain: string;

    /**
     * Configuration set name (environment-scoped)
     */
    readonly configurationSetName: string;

    /**
     * Whether to enable DKIM signing
     * Recommended: true for both dev and prod (email deliverability)
     */
    readonly enableDkim: boolean;

    /**
     * Whether to enable SNS notifications for SES events
     * Recommended: true for both dev and prod (bounce/complaint handling)
     */
    readonly enableEventNotifications: boolean;
  };

  /**
   * Cognito configuration for admin authentication
   */
  readonly cognito: {
    /**
     * Callback URLs for OAuth flow (after successful sign-in)
     */
    readonly callbackUrls: string[];

    /**
     * Logout URLs for OAuth flow (after sign-out)
     */
    readonly logoutUrls: string[];
  };

  /**
   * Observability configuration for CloudWatch
   */
  readonly observability: {
    /**
     * CloudWatch Logs retention period in days
     * Per platform invariants: 180 days (6 months) for all logs
     */
    readonly logRetentionDays: number;

    /**
     * SNS topic email for alarm notifications
     * Alarms for DLQ depth, Lambda errors, API 5xx, SES bounce/complaint rates
     */
    readonly alarmNotificationEmail: string;

    /**
     * CloudWatch alarm thresholds
     */
    readonly alarms: {
      /**
       * Dead Letter Queue message depth threshold
       * Alert when DLQ has this many messages
       */
      readonly dlqDepthThreshold: number;

      /**
       * Lambda error rate threshold (percentage)
       * Alert when error rate exceeds this percentage over 5-minute period
       */
      readonly lambdaErrorRateThreshold: number;

      /**
       * API Gateway 5xx error count threshold
       * Alert when 5xx errors exceed this count in 5-minute period
       */
      readonly api5xxThreshold: number;

      /**
       * SES bounce rate threshold (percentage)
       * Alert when bounce rate exceeds this percentage
       */
      readonly sesBounceRateThreshold: number;

      /**
       * SES complaint rate threshold (percentage)
       * Alert when complaint rate exceeds this percentage
       */
      readonly sesComplaintRateThreshold: number;
    };
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
  apiGateway: {
    throttle: {
      rateLimit: 20,
      burstLimit: 40,
    },
  },
  waf: {
    enable: false,
    adminRateLimit: 1000,
  },
  dynamodb: {
    enablePointInTimeRecovery: false, // Cost optimization for dev
    enableDeletionProtection: false, // Development flexibility
  },
  secrets: {
    retainOnDelete: false, // Clean deletion for dev
  },
  ses: {
    verifiedDomain: 'email.ponton.io',
    configurationSetName: 'dev-email-ses-config',
    enableDkim: true, // Email deliverability
    enableEventNotifications: true, // Bounce/complaint handling
  },
  cognito: {
    callbackUrls: [
      'http://localhost:3000/auth/callback',
      'https://mailer-dev.ponton.io/auth/callback',
    ],
    logoutUrls: [
      'http://localhost:3000/auth/logout',
      'https://mailer-dev.ponton.io/auth/logout',
    ],
  },
  observability: {
    logRetentionDays: 180, // 6 months per platform invariants
    alarmNotificationEmail: 'alerts-dev@ponton.io',
    alarms: {
      dlqDepthThreshold: 10, // Alert on 10+ messages in DLQ
      lambdaErrorRateThreshold: 5, // Alert on 5% error rate
      api5xxThreshold: 10, // Alert on 10+ 5xx errors in 5 minutes
      sesBounceRateThreshold: 5, // Alert on 5% bounce rate
      sesComplaintRateThreshold: 0.1, // Alert on 0.1% complaint rate (strict)
    },
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
  apiGateway: {
    throttle: {
      rateLimit: 100,
      burstLimit: 200,
    },
  },
  waf: {
    enable: true,
    adminRateLimit: 1000,
  },
  dynamodb: {
    enablePointInTimeRecovery: true, // Data protection for prod
    enableDeletionProtection: true, // Prevent accidental deletion
  },
  secrets: {
    retainOnDelete: true, // Prevent accidental secret deletion in prod
  },
  ses: {
    verifiedDomain: 'email.ponton.io',
    configurationSetName: 'prod-email-ses-config',
    enableDkim: true, // Email deliverability
    enableEventNotifications: true, // Bounce/complaint handling
  },
  cognito: {
    callbackUrls: ['https://mailer.ponton.io/auth/callback'],
    logoutUrls: ['https://mailer.ponton.io/auth/logout'],
  },
  observability: {
    logRetentionDays: 180, // 6 months per platform invariants
    alarmNotificationEmail: 'alerts@ponton.io',
    alarms: {
      dlqDepthThreshold: 5, // Alert on 5+ messages in DLQ (stricter in prod)
      lambdaErrorRateThreshold: 2, // Alert on 2% error rate (stricter in prod)
      api5xxThreshold: 5, // Alert on 5+ 5xx errors in 5 minutes (stricter in prod)
      sesBounceRateThreshold: 5, // Alert on 5% bounce rate
      sesComplaintRateThreshold: 0.1, // Alert on 0.1% complaint rate (strict)
    },
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
