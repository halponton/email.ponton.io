import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { EnvironmentConfig, envResourceName } from '../config/environments';

/**
 * Props for CognitoStack
 */
export interface CognitoStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
}

/**
 * Cognito Stack
 *
 * Creates Cognito User Pool and resources for admin authentication.
 *
 * Security configuration:
 * - MFA: REQUIRED (TOTP only, no SMS)
 * - Password: 14+ chars with complexity requirements
 * - Access Token: 30 minutes
 * - Refresh Token: 7 days
 * - Self-signup: DISABLED (admin invite only)
 * - Account recovery: Email only
 * - Advanced Security: ENFORCED for prod, AUDIT for dev
 * - Email via SES (admin@email.ponton.io for prod, admin-dev@email.ponton.io for dev)
 *
 * Admin group:
 * - Name: "Administrators"
 * - Required for access to /admin/* routes
 *
 * Per PLATFORM_INVARIANTS.md section 5:
 * - Humans authenticate via Cognito
 * - Services use IAM or API keys
 *
 * Milestone 5: Phase 1 (MVP)
 * - User Pool with security hardening
 * - User Pool Client for OAuth Authorization Code Grant
 * - User Pool Domain (OAuth endpoints for admin UI)
 * - Administrators group
 * - Stack outputs for UI integration
 */
export class CognitoStack extends cdk.Stack {
  /** Cognito User Pool */
  public readonly userPool: cognito.UserPool;

  /** User Pool Client for admin UI */
  public readonly userPoolClient: cognito.UserPoolClient;

  /** User Pool Domain */
  public readonly userPoolDomain: cognito.UserPoolDomain;

  /** Administrators group */
  public readonly adminGroup: cognito.CfnUserPoolGroup;

  constructor(scope: Construct, id: string, props: CognitoStackProps) {
    super(scope, id, props);

    const { config } = props;

    // H-1: CORS Configuration Validation - Prevent localhost URLs in production
    if (config.env === 'prod') {
      const insecureCallbackUrls = config.cognito.callbackUrls.filter(url =>
        url.includes('localhost') || url.startsWith('http://')
      );
      const insecureLogoutUrls = config.cognito.logoutUrls.filter(url =>
        url.includes('localhost') || url.startsWith('http://')
      );

      if (insecureCallbackUrls.length > 0 || insecureLogoutUrls.length > 0) {
        throw new Error(
          'SECURITY: Production Cognito configuration contains localhost or HTTP URLs. ' +
          'All production callback and logout URLs must use HTTPS. ' +
          `Invalid callback URLs: ${insecureCallbackUrls.join(', ')}. ` +
          `Invalid logout URLs: ${insecureLogoutUrls.join(', ')}.`
        );
      }
    }

    // Determine SES email address for Cognito
    const cognitoFromEmail =
      config.env === 'prod'
        ? 'admin@email.ponton.io'
        : 'admin-dev@email.ponton.io';

    // Create User Pool
    this.userPool = new cognito.UserPool(
      this,
      envResourceName(config.env, 'AdminUserPool'),
      {
        userPoolName: envResourceName(config.env, 'email-admin-users'),
        // Sign-in configuration
        signInAliases: {
          email: true,
          username: false,
          phone: false,
          preferredUsername: false,
        },
        // Self sign-up disabled - admin invite only
        selfSignUpEnabled: false,
        // Auto-verify email addresses
        autoVerify: {
          email: true,
          phone: false,
        },
        // Standard attributes required
        standardAttributes: {
          email: {
            required: true,
            mutable: true,
          },
        },
        // MFA configuration - REQUIRED for all users
        mfa: cognito.Mfa.REQUIRED,
        mfaSecondFactor: {
          sms: false,
          otp: true, // TOTP only
        },
        // Password policy - strong security requirements
        passwordPolicy: {
          minLength: 14,
          requireLowercase: true,
          requireUppercase: true,
          requireDigits: true,
          requireSymbols: true,
          tempPasswordValidity: cdk.Duration.days(3),
        },
        // Account recovery - email only
        accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
        // Email configuration - use SES
        email: cognito.UserPoolEmail.withSES({
          fromEmail: cognitoFromEmail,
          fromName: 'Email.Ponton.io Admin',
          sesRegion: config.region,
          // Cognito will use the default SES configuration
          // SES identity (email.ponton.io) must be verified before deployment
        }),
        // Advanced security features
        // M-1: Use new standardThreatProtectionMode API (replaces deprecated advancedSecurityMode)
        standardThreatProtectionMode:
          config.env === 'prod'
            ? cognito.StandardThreatProtectionMode.FULL_FUNCTION
            : cognito.StandardThreatProtectionMode.AUDIT_ONLY,
        // User invitation template
        userInvitation: {
          emailSubject: 'Your admin account for Email.Ponton.io',
          emailBody: `Hello,

You have been invited to join the Email.Ponton.io admin dashboard.

Your temporary password is: {####}
Username: {username}

Please sign in and change your password immediately. You will also need to set up MFA (Time-based One-Time Password) using an authenticator app.

Environment: ${config.env}

Best regards,
Email.Ponton.io Team`,
        },
        // User verification template
        userVerification: {
          emailSubject: 'Verify your email for Email.Ponton.io',
          emailBody: 'Your verification code is {####}',
          emailStyle: cognito.VerificationEmailStyle.CODE,
        },
        // Removal policy
        removalPolicy:
          config.env === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        // Enable deletion protection for prod
        deletionProtection: config.env === 'prod',
      }
    );

    // Create User Pool Client
    this.userPoolClient = new cognito.UserPoolClient(
      this,
      envResourceName(config.env, 'AdminUserPoolClient'),
      {
        userPool: this.userPool,
        userPoolClientName: envResourceName(config.env, 'email-admin-client'),
        // OAuth configuration
        oAuth: {
          flows: {
            authorizationCodeGrant: true,
            implicitCodeGrant: false,
            clientCredentials: false,
          },
          scopes: [
            cognito.OAuthScope.EMAIL,
            cognito.OAuthScope.OPENID,
            cognito.OAuthScope.PROFILE,
          ],
          callbackUrls: config.cognito.callbackUrls,
          logoutUrls: config.cognito.logoutUrls,
        },
        // Token validity
        accessTokenValidity: cdk.Duration.minutes(30),
        idTokenValidity: cdk.Duration.minutes(30),
        refreshTokenValidity: cdk.Duration.days(7),
        // Token revocation enabled
        enableTokenRevocation: true,
        // Prevent user existence errors (security best practice)
        preventUserExistenceErrors: true,
        // Auth flows - OAuth only (no direct password auth)
        authFlows: {
          userPassword: false,
          userSrp: true,
          custom: false,
          adminUserPassword: false,
        },
        // Generate secret for server-side OAuth flows
        generateSecret: false, // Set to false for public clients (SPA/mobile)
      }
    );

    // Create User Pool Domain (OAuth endpoints for admin UI)
    this.userPoolDomain = new cognito.UserPoolDomain(
      this,
      envResourceName(config.env, 'AdminUserPoolDomain'),
      {
        userPool: this.userPool,
        cognitoDomain: {
          domainPrefix: `${config.env}-email-admin`,
        },
      }
    );

    // Create Administrators group
    this.adminGroup = new cognito.CfnUserPoolGroup(
      this,
      envResourceName(config.env, 'AdministratorsGroup'),
      {
        userPoolId: this.userPool.userPoolId,
        groupName: 'Administrators',
        description: 'Admin users with full access to admin APIs',
        precedence: 1,
      }
    );

    // Stack outputs
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito User Pool ID',
      exportName: envResourceName(config.env, 'UserPoolId'),
    });

    new cdk.CfnOutput(this, 'UserPoolArn', {
      value: this.userPool.userPoolArn,
      description: 'Cognito User Pool ARN',
      exportName: envResourceName(config.env, 'UserPoolArn'),
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
      exportName: envResourceName(config.env, 'UserPoolClientId'),
    });

    new cdk.CfnOutput(this, 'UserPoolDomain', {
      value: this.userPoolDomain.domainName,
      description: 'Cognito User Pool Domain',
      exportName: envResourceName(config.env, 'UserPoolDomain'),
    });

    new cdk.CfnOutput(this, 'UserPoolIssuer', {
      value: `https://cognito-idp.${config.region}.amazonaws.com/${this.userPool.userPoolId}`,
      description: 'Cognito User Pool Issuer URL (for JWT validation)',
      exportName: envResourceName(config.env, 'UserPoolIssuer'),
    });

    // Add tags
    cdk.Tags.of(this).add('Environment', config.env);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Project', 'email.ponton.io');
  }
}
