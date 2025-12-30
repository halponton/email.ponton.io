/**
 * Tests for Cognito Stack security validations
 */
import * as cdk from 'aws-cdk-lib';
import { CognitoStack } from '../lib/stacks/cognito-stack';
import { EnvironmentConfig } from '../lib/config/environments';

describe('CognitoStack Security Validations', () => {
  describe('H-1: CORS Configuration Validation', () => {
    test('should reject localhost URLs in production callback URLs', () => {
      const app = new cdk.App();

      const invalidConfig: EnvironmentConfig = {
        env: 'prod',
        region: 'eu-west-2',
        apiDomain: 'api.email.ponton.io',
        sesSandbox: false,
        hostedZoneName: 'ponton.io',
        enableDetailedMonitoring: true,
        dynamodb: {
          enablePointInTimeRecovery: true,
          enableDeletionProtection: true,
        },
        secrets: {
          retainOnDelete: true,
        },
        ses: {
          verifiedDomain: 'email.ponton.io',
          configurationSetName: 'prod-email-ses-config',
          enableDkim: true,
          enableEventNotifications: true,
        },
        cognito: {
          callbackUrls: [
            'https://mailer.ponton.io/auth/callback',
            'http://localhost:3000/auth/callback', // Invalid for prod
          ],
          logoutUrls: ['https://mailer.ponton.io/auth/logout'],
        },
      };

      expect(() => {
        new CognitoStack(app, 'TestCognitoStack', {
          config: invalidConfig,
        });
      }).toThrow('SECURITY: Production Cognito configuration contains localhost or HTTP URLs');
    });

    test('should reject HTTP URLs in production callback URLs', () => {
      const app = new cdk.App();

      const invalidConfig: EnvironmentConfig = {
        env: 'prod',
        region: 'eu-west-2',
        apiDomain: 'api.email.ponton.io',
        sesSandbox: false,
        hostedZoneName: 'ponton.io',
        enableDetailedMonitoring: true,
        dynamodb: {
          enablePointInTimeRecovery: true,
          enableDeletionProtection: true,
        },
        secrets: {
          retainOnDelete: true,
        },
        ses: {
          verifiedDomain: 'email.ponton.io',
          configurationSetName: 'prod-email-ses-config',
          enableDkim: true,
          enableEventNotifications: true,
        },
        cognito: {
          callbackUrls: [
            'http://insecure.example.com/auth/callback', // Invalid HTTP
          ],
          logoutUrls: ['https://mailer.ponton.io/auth/logout'],
        },
      };

      expect(() => {
        new CognitoStack(app, 'TestCognitoStack', {
          config: invalidConfig,
        });
      }).toThrow('SECURITY: Production Cognito configuration contains localhost or HTTP URLs');
    });

    test('should reject localhost URLs in production logout URLs', () => {
      const app = new cdk.App();

      const invalidConfig: EnvironmentConfig = {
        env: 'prod',
        region: 'eu-west-2',
        apiDomain: 'api.email.ponton.io',
        sesSandbox: false,
        hostedZoneName: 'ponton.io',
        enableDetailedMonitoring: true,
        dynamodb: {
          enablePointInTimeRecovery: true,
          enableDeletionProtection: true,
        },
        secrets: {
          retainOnDelete: true,
        },
        ses: {
          verifiedDomain: 'email.ponton.io',
          configurationSetName: 'prod-email-ses-config',
          enableDkim: true,
          enableEventNotifications: true,
        },
        cognito: {
          callbackUrls: ['https://mailer.ponton.io/auth/callback'],
          logoutUrls: [
            'https://mailer.ponton.io/auth/logout',
            'http://localhost:3000/auth/logout', // Invalid for prod
          ],
        },
      };

      expect(() => {
        new CognitoStack(app, 'TestCognitoStack', {
          config: invalidConfig,
        });
      }).toThrow('SECURITY: Production Cognito configuration contains localhost or HTTP URLs');
    });

    test('should allow HTTPS URLs in production', () => {
      const app = new cdk.App();

      const validConfig: EnvironmentConfig = {
        env: 'prod',
        region: 'eu-west-2',
        apiDomain: 'api.email.ponton.io',
        sesSandbox: false,
        hostedZoneName: 'ponton.io',
        enableDetailedMonitoring: true,
        dynamodb: {
          enablePointInTimeRecovery: true,
          enableDeletionProtection: true,
        },
        secrets: {
          retainOnDelete: true,
        },
        ses: {
          verifiedDomain: 'email.ponton.io',
          configurationSetName: 'prod-email-ses-config',
          enableDkim: true,
          enableEventNotifications: true,
        },
        cognito: {
          callbackUrls: ['https://mailer.ponton.io/auth/callback'],
          logoutUrls: ['https://mailer.ponton.io/auth/logout'],
        },
      };

      expect(() => {
        new CognitoStack(app, 'TestCognitoStack', {
          config: validConfig,
        });
      }).not.toThrow();
    });

    test('should allow localhost and HTTP URLs in dev environment', () => {
      const app = new cdk.App();

      const devConfig: EnvironmentConfig = {
        env: 'dev',
        region: 'eu-west-2',
        apiDomain: 'api-dev.email.ponton.io',
        sesSandbox: true,
        hostedZoneName: 'ponton.io',
        enableDetailedMonitoring: false,
        dynamodb: {
          enablePointInTimeRecovery: false,
          enableDeletionProtection: false,
        },
        secrets: {
          retainOnDelete: false,
        },
        ses: {
          verifiedDomain: 'email.ponton.io',
          configurationSetName: 'dev-email-ses-config',
          enableDkim: true,
          enableEventNotifications: true,
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
      };

      expect(() => {
        new CognitoStack(app, 'TestDevCognitoStack', {
          config: devConfig,
        });
      }).not.toThrow();
    });
  });
});
