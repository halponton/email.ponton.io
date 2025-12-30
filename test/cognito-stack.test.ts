import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { CognitoStack } from '../lib/stacks/cognito-stack';
import { DEV_CONFIG, PROD_CONFIG, EnvironmentConfig } from '../lib/config/environments';

const makeStack = (config: EnvironmentConfig, id: string): CognitoStack => {
  const app = new cdk.App();
  return new CognitoStack(app, id, {
    config,
    env: { account: '111111111111', region: config.region },
  });
};

describe('CognitoStack', () => {
  test('dev config creates User Pool with correct settings', () => {
    const stack = makeStack(DEV_CONFIG, 'DevCognitoStack');
    const template = Template.fromStack(stack);

    // Should create User Pool, Client, Domain, and Group
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
    template.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
    template.resourceCountIs('AWS::Cognito::UserPoolGroup', 1);

    // User Pool configuration
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'dev-email-admin-users',
      MfaConfiguration: 'ON',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      // Email sign-in only
      UsernameAttributes: ['email'],
      AutoVerifiedAttributes: ['email'],
      // Self sign-up disabled
      AdminCreateUserConfig: {
        AllowAdminCreateUserOnly: true,
      },
      // Password policy
      Policies: {
        PasswordPolicy: {
          MinimumLength: 14,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
          TemporaryPasswordValidityDays: 3,
        },
      },
      // Account recovery - email only
      AccountRecoverySetting: {
        RecoveryMechanisms: [
          {
            Name: 'verified_email',
            Priority: 1,
          },
        ],
      },
      // Email configuration - SES
      EmailConfiguration: {
        EmailSendingAccount: 'DEVELOPER',
        From: 'Email.Ponton.io Admin <admin-dev@email.ponton.io>',
        SourceArn: Match.objectLike({
          'Fn::Join': Match.anyValue(),
        }),
      },
      // Advanced security for dev - AUDIT mode
      UserPoolAddOns: {
        AdvancedSecurityMode: 'AUDIT',
      },
      // Deletion protection - off for dev (becomes INACTIVE)
      DeletionProtection: 'INACTIVE',
    });
  });

  test('prod config creates User Pool with ENFORCED security', () => {
    const stack = makeStack(PROD_CONFIG, 'ProdCognitoStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'prod-email-admin-users',
      // Advanced security for prod - ENFORCED mode
      UserPoolAddOns: {
        AdvancedSecurityMode: 'ENFORCED',
      },
      // Deletion protection - on for prod
      DeletionProtection: 'ACTIVE',
      // Email from prod address
      EmailConfiguration: {
        EmailSendingAccount: 'DEVELOPER',
        From: 'Email.Ponton.io Admin <admin@email.ponton.io>',
        SourceArn: Match.objectLike({
          'Fn::Join': Match.anyValue(),
        }),
      },
    });
  });

  test('User Pool Client has correct OAuth configuration', () => {
    const stack = makeStack(DEV_CONFIG, 'DevCognitoStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'dev-email-admin-client',
      // OAuth flows - Authorization Code Grant only
      AllowedOAuthFlows: ['code'],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: ['email', 'openid', 'profile'],
      CallbackURLs: [
        'http://localhost:3000/auth/callback',
        'https://mailer-dev.ponton.io/auth/callback',
      ],
      LogoutURLs: [
        'http://localhost:3000/auth/logout',
        'https://mailer-dev.ponton.io/auth/logout',
      ],
      // Token validity (converted to minutes in CloudFormation)
      AccessTokenValidity: 30,
      IdTokenValidity: 30,
      RefreshTokenValidity: 10080, // 7 days * 24 hours * 60 minutes
      TokenValidityUnits: {
        AccessToken: 'minutes',
        IdToken: 'minutes',
        RefreshToken: 'minutes',
      },
      // Security settings
      EnableTokenRevocation: true,
      PreventUserExistenceErrors: 'ENABLED',
      // Auth flows
      ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      // No client secret for public clients
      GenerateSecret: false,
    });
  });

  test('prod User Pool Client uses production callback URLs', () => {
    const stack = makeStack(PROD_CONFIG, 'ProdCognitoStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: ['https://mailer.ponton.io/auth/callback'],
      LogoutURLs: ['https://mailer.ponton.io/auth/logout'],
    });
  });

  test('User Pool Domain has correct naming', () => {
    const stack = makeStack(DEV_CONFIG, 'DevCognitoStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'dev-email-admin',
    });
  });

  test('prod User Pool Domain uses prod prefix', () => {
    const stack = makeStack(PROD_CONFIG, 'ProdCognitoStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'prod-email-admin',
    });
  });

  test('Administrators group is created', () => {
    const stack = makeStack(DEV_CONFIG, 'DevCognitoStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
      GroupName: 'Administrators',
      Description: 'Admin users with full access to admin APIs',
      Precedence: 1,
    });
  });

  test('stack outputs are created', () => {
    const stack = makeStack(DEV_CONFIG, 'DevCognitoStack');
    const template = Template.fromStack(stack);

    // Check that outputs exist
    template.hasOutput('UserPoolId', {});
    template.hasOutput('UserPoolArn', {});
    template.hasOutput('UserPoolClientId', {});
    template.hasOutput('UserPoolDomain', {});
    template.hasOutput('UserPoolIssuer', {});
  });

  test('MFA configuration requires TOTP only (no SMS)', () => {
    const stack = makeStack(DEV_CONFIG, 'DevCognitoStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Cognito::UserPool', {
      MfaConfiguration: 'ON',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
    });

    // Should NOT have SMS MFA
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      EnabledMfas: Match.not(Match.arrayWith(['SMS_MFA'])),
    });
  });

  test('password policy enforces strong requirements', () => {
    const stack = makeStack(DEV_CONFIG, 'DevCognitoStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: {
        PasswordPolicy: {
          MinimumLength: 14,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
        },
      },
    });
  });
});
