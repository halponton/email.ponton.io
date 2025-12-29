import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { SecretsStack } from '../lib/stacks/secrets-stack';
import { DEV_CONFIG, PROD_CONFIG, EnvironmentConfig } from '../lib/config/environments';

const makeStack = (config: EnvironmentConfig, id: string): SecretsStack => {
  const app = new cdk.App();
  return new SecretsStack(app, id, {
    config,
    env: { account: '111111111111', region: config.region },
  });
};

describe('SecretsStack', () => {
  describe('Secrets Manager', () => {
    test('dev config creates secrets with correct naming and generation', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSecretsStack');
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::SecretsManager::Secret', 2);

      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: '/dev/email/token-hmac-secret',
        Description: Match.stringLikeRegexp('Token HMAC secret.*dev'),
        GenerateSecretString: {
          PasswordLength: 64,
          ExcludePunctuation: true,
        },
      });

      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: '/dev/email/email-hash-hmac-secret',
        Description: Match.stringLikeRegexp('Email hash HMAC secret.*dev'),
        GenerateSecretString: {
          PasswordLength: 64,
          ExcludePunctuation: true,
        },
      });
    });

    test('prod config creates secrets with correct naming and generation', () => {
      const stack = makeStack(PROD_CONFIG, 'ProdSecretsStack');
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::SecretsManager::Secret', 2);

      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: '/prod/email/token-hmac-secret',
        Description: Match.stringLikeRegexp('Token HMAC secret.*prod'),
        GenerateSecretString: {
          PasswordLength: 64,
          ExcludePunctuation: true,
        },
      });

      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: '/prod/email/email-hash-hmac-secret',
        Description: Match.stringLikeRegexp('Email hash HMAC secret.*prod'),
        GenerateSecretString: {
          PasswordLength: 64,
          ExcludePunctuation: true,
        },
      });
    });

    test('secrets use KMS encryption and generated values', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSecretsStack');
      const template = Template.fromStack(stack);

      const secrets = template.findResources('AWS::SecretsManager::Secret');
      Object.values(secrets).forEach((secret) => {
        expect(secret.Properties.KmsKeyId).toBeDefined();
        expect(secret.Properties.GenerateSecretString).toMatchObject({
          PasswordLength: 64,
          ExcludePunctuation: true,
        });
        expect(secret.Properties.SecretString).toBeUndefined();
      });
    });
  });

  describe('KMS', () => {
    test('creates a dedicated CMK with Secrets Manager policy', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSecretsStack');
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::KMS::Key', 1);
      template.hasResourceProperties('AWS::KMS::Key', {
        EnableKeyRotation: true,
      });

      template.hasResourceProperties('AWS::KMS::Alias', {
        AliasName: 'alias/dev-email-secrets-key',
      });

      template.hasResourceProperties('AWS::KMS::Key', {
        KeyPolicy: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'AllowSecretsManagerUse',
              Effect: 'Allow',
              Principal: {
                Service: 'secretsmanager.amazonaws.com',
              },
              Action: Match.arrayWith([
                'kms:Decrypt',
                'kms:Encrypt',
                'kms:ReEncrypt*',
                'kms:GenerateDataKey*',
                'kms:CreateGrant',
                'kms:DescribeKey',
              ]),
              Condition: {
                StringEquals: {
                  'kms:ViaService': `secretsmanager.${DEV_CONFIG.region}.amazonaws.com`,
                  'kms:CallerAccount': '111111111111',
                },
              },
            }),
          ]),
        },
      });
    });

    test('creates a prod alias with environment scoping', () => {
      const stack = makeStack(PROD_CONFIG, 'ProdSecretsStack');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::KMS::Alias', {
        AliasName: 'alias/prod-email-secrets-key',
      });
    });
  });

  describe('SSM Parameter Store', () => {
    test('dev config creates all required SSM parameters', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSecretsStack');
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::SSM::Parameter', 7);

      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/email/dev/ses/verified-domain',
        Type: 'String',
        Value: 'email.ponton.io',
      });

      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/email/dev/ses/from-email',
        Type: 'String',
        Value: 'newsletter-dev@email.ponton.io',
      });

      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/email/dev/ses/from-name',
        Type: 'String',
        Value: 'Ponton Newsletter (Dev)',
      });

      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/email/dev/api/base-url',
        Type: 'String',
        Value: 'https://api-dev.email.ponton.io',
      });

      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/email/dev/tracking/click-redirect-base-url',
        Type: 'String',
        Value: 'https://api-dev.email.ponton.io/v1/track/click',
      });

      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/email/dev/tracking/open-pixel-base-url',
        Type: 'String',
        Value: 'https://api-dev.email.ponton.io/v1/track/open',
      });

      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/email/dev/retention/engagement-ttl-days',
        Type: 'String',
        Value: '180',
      });
    });

    test('prod config creates all required SSM parameters with prod values', () => {
      const stack = makeStack(PROD_CONFIG, 'ProdSecretsStack');
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::SSM::Parameter', 7);

      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/email/prod/ses/verified-domain',
        Type: 'String',
        Value: 'email.ponton.io',
      });

      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/email/prod/ses/from-email',
        Type: 'String',
        Value: 'newsletter@email.ponton.io',
      });

      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/email/prod/ses/from-name',
        Type: 'String',
        Value: 'Ponton Newsletter',
      });

      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/email/prod/api/base-url',
        Type: 'String',
        Value: 'https://api.email.ponton.io',
      });

      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/email/prod/tracking/click-redirect-base-url',
        Type: 'String',
        Value: 'https://api.email.ponton.io/v1/track/click',
      });

      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/email/prod/tracking/open-pixel-base-url',
        Type: 'String',
        Value: 'https://api.email.ponton.io/v1/track/open',
      });

      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/email/prod/retention/engagement-ttl-days',
        Type: 'String',
        Value: '180',
      });
    });
  });

  describe('Stack Outputs', () => {
    test('dev stack exports all required outputs', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSecretsStack');
      const template = Template.fromStack(stack);

      const outputs = template.findOutputs('*');
      expect(Object.keys(outputs).length).toBe(11);

      template.hasOutput('TokenHmacSecretArn', {
        Export: {
          Name: 'dev-TokenHmacSecretArn',
        },
      });

      template.hasOutput('TokenHmacSecretName', {
        Export: {
          Name: 'dev-TokenHmacSecretName',
        },
      });

      template.hasOutput('EmailHashHmacSecretArn', {
        Export: {
          Name: 'dev-EmailHashHmacSecretArn',
        },
      });

      template.hasOutput('EmailHashHmacSecretName', {
        Export: {
          Name: 'dev-EmailHashHmacSecretName',
        },
      });

      template.hasOutput('SesVerifiedDomainParameter', {
        Export: {
          Name: 'dev-SesVerifiedDomainParameter',
        },
      });
    });

    test('prod stack exports required outputs with prod naming', () => {
      const stack = makeStack(PROD_CONFIG, 'ProdSecretsStack');
      const template = Template.fromStack(stack);

      const outputs = template.findOutputs('*');
      expect(Object.keys(outputs).length).toBe(11);

      template.hasOutput('TokenHmacSecretArn', {
        Export: {
          Name: 'prod-TokenHmacSecretArn',
        },
      });

      template.hasOutput('EmailHashHmacSecretArn', {
        Export: {
          Name: 'prod-EmailHashHmacSecretArn',
        },
      });

      template.hasOutput('ApiBaseUrlParameter', {
        Export: {
          Name: 'prod-ApiBaseUrlParameter',
        },
      });
    });
  });

  describe('Removal Policies', () => {
    test('prod config retains secrets, parameters, and CMK', () => {
      const stack = makeStack(PROD_CONFIG, 'ProdSecretsStack');
      const template = Template.fromStack(stack);

      const secrets = template.findResources('AWS::SecretsManager::Secret');
      Object.values(secrets).forEach((secret) => {
        expect(secret.DeletionPolicy).toBe('Retain');
      });

      const parameters = template.findResources('AWS::SSM::Parameter');
      Object.values(parameters).forEach((parameter) => {
        expect(parameter.DeletionPolicy).toBe('Retain');
      });

      const keys = template.findResources('AWS::KMS::Key');
      Object.values(keys).forEach((key) => {
        expect(key.DeletionPolicy).toBe('Retain');
      });
    });
  });

  describe('Environment Isolation', () => {
    test('dev and prod have distinct secret names', () => {
      const devStack = makeStack(DEV_CONFIG, 'DevSecretsStack');
      const prodStack = makeStack(PROD_CONFIG, 'ProdSecretsStack');

      const devTemplate = Template.fromStack(devStack);
      const prodTemplate = Template.fromStack(prodStack);

      devTemplate.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: '/dev/email/token-hmac-secret',
      });

      devTemplate.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: '/dev/email/email-hash-hmac-secret',
      });

      prodTemplate.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: '/prod/email/token-hmac-secret',
      });

      prodTemplate.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: '/prod/email/email-hash-hmac-secret',
      });
    });

    test('dev and prod have distinct SSM parameter names', () => {
      const devStack = makeStack(DEV_CONFIG, 'DevSecretsStack');
      const prodStack = makeStack(PROD_CONFIG, 'ProdSecretsStack');

      const devTemplate = Template.fromStack(devStack);
      const prodTemplate = Template.fromStack(prodStack);

      devTemplate.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/email/dev/ses/from-email',
      });

      prodTemplate.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/email/prod/ses/from-email',
      });
    });
  });
});
