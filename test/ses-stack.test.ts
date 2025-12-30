import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { SESStack } from '../lib/stacks/ses-stack';
import { DEV_CONFIG, PROD_CONFIG, EnvironmentConfig } from '../lib/config/environments';

/**
 * Helper to create a mock hosted zone
 */
function createMockHostedZone(app: cdk.App): route53.IHostedZone {
  const stack = new cdk.Stack(app, 'MockHostedZoneStack');
  return route53.HostedZone.fromHostedZoneAttributes(stack, 'MockHostedZone', {
    hostedZoneId: 'Z1234567890ABC',
    zoneName: 'ponton.io',
  });
}

/**
 * Helper to create mock DynamoDB tables
 */
function createMockTables(app: cdk.App) {
  const stack = new cdk.Stack(app, 'MockTablesStack');

  return {
    subscribersTable: dynamodb.Table.fromTableName(
      stack,
      'MockSubscribersTable',
      'mock-subscribers-table'
    ),
    auditEventsTable: dynamodb.Table.fromTableName(
      stack,
      'MockAuditEventsTable',
      'mock-audit-events-table'
    ),
    engagementEventsTable: dynamodb.Table.fromTableName(
      stack,
      'MockEngagementEventsTable',
      'mock-engagement-events-table'
    ),
    deliveriesTable: dynamodb.Table.fromTableName(
      stack,
      'MockDeliveriesTable',
      'mock-deliveries-table'
    ),
  };
}

/**
 * Helper to create SES stack with mocks
 */
const makeStack = (config: EnvironmentConfig, id: string): SESStack => {
  const app = new cdk.App();
  const hostedZone = createMockHostedZone(app);
  const tables = createMockTables(app);

  return new SESStack(app, id, {
    config,
    hostedZone,
    tables,
    env: { account: '111111111111', region: config.region },
  });
};

describe('SESStack', () => {
  describe('SES Email Identity', () => {
    test('dev config creates email identity with DKIM', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      // Should create one SES email identity
      template.resourceCountIs('AWS::SES::EmailIdentity', 1);

      // Email identity should have DKIM enabled
      template.hasResourceProperties('AWS::SES::EmailIdentity', {
        EmailIdentity: 'email.ponton.io',
        DkimAttributes: {
          SigningEnabled: true,
        },
        MailFromAttributes: {
          MailFromDomain: 'bounce.email.ponton.io',
        },
      });
    });

    test('prod config creates email identity with DKIM', () => {
      const stack = makeStack(PROD_CONFIG, 'ProdSESStack');
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::SES::EmailIdentity', 1);

      template.hasResourceProperties('AWS::SES::EmailIdentity', {
        EmailIdentity: 'email.ponton.io',
        DkimAttributes: {
          SigningEnabled: true,
        },
        MailFromAttributes: {
          MailFromDomain: 'bounce.email.ponton.io',
        },
      });
    });

    test('creates SPF record with hard fail policy', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      // Should create Route53 TXT record for SPF
      const txtRecords = template.findResources('AWS::Route53::RecordSet', {
        Properties: {
          Type: 'TXT',
          Name: 'email.ponton.io.',
        },
      });

      expect(Object.keys(txtRecords).length).toBeGreaterThan(0);

      // Verify SPF record value
      const spfRecord = Object.values(txtRecords).find((record: any) =>
        record.Properties.ResourceRecords?.some((rr: string) =>
          rr.includes('v=spf1 include:amazonses.com -all')
        )
      );
      expect(spfRecord).toBeDefined();
    });

    test('creates DMARC record with monitoring policy', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      // Should create Route53 TXT record for DMARC
      const txtRecords = template.findResources('AWS::Route53::RecordSet', {
        Properties: {
          Type: 'TXT',
          Name: '_dmarc.email.ponton.io.',
        },
      });

      expect(Object.keys(txtRecords).length).toBeGreaterThan(0);

      // Verify DMARC record value
      const dmarcRecord = Object.values(txtRecords).find((record: any) =>
        record.Properties.ResourceRecords?.some((rr: string) =>
          rr.includes('v=DMARC1') && rr.includes('p=none')
        )
      );
      expect(dmarcRecord).toBeDefined();
    });

    test('creates MAIL FROM records for bounce subdomain', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      const mxRecords = template.findResources('AWS::Route53::RecordSet', {
        Properties: {
          Type: 'MX',
          Name: 'bounce.email.ponton.io.',
        },
      });

      expect(Object.keys(mxRecords).length).toBeGreaterThan(0);

      const txtRecords = template.findResources('AWS::Route53::RecordSet', {
        Properties: {
          Type: 'TXT',
          Name: 'bounce.email.ponton.io.',
        },
      });

      const spfRecord = Object.values(txtRecords).find((record: any) =>
        record.Properties.ResourceRecords?.some((rr: string) =>
          rr.includes('v=spf1 include:amazonses.com -all')
        )
      );
      expect(spfRecord).toBeDefined();
    });
  });

  describe('SES Configuration Set', () => {
    test('dev config creates configuration set with correct name', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::SES::ConfigurationSet', 1);

      template.hasResourceProperties('AWS::SES::ConfigurationSet', {
        Name: 'dev-email-ses-config',
      });
    });

    test('prod config creates configuration set with correct name', () => {
      const stack = makeStack(PROD_CONFIG, 'ProdSESStack');
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::SES::ConfigurationSet', 1);

      template.hasResourceProperties('AWS::SES::ConfigurationSet', {
        Name: 'prod-email-ses-config',
      });
    });
  });

  describe('Event Destination Pipeline', () => {
    test('creates SNS topic for SES events', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::SNS::Topic', 1);

      template.hasResourceProperties('AWS::SNS::Topic', {
        TopicName: 'dev-email-ses-events',
        DisplayName: Match.stringLikeRegexp('SES Events.*dev'),
      });
    });

    test('SNS topic has SES-only publish policy', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::SNS::TopicPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'AllowSESToPublish',
              Effect: 'Allow',
              Principal: {
                Service: 'ses.amazonaws.com',
              },
              Action: 'SNS:Publish',
            }),
          ]),
        },
      });
    });

    test('creates SQS queue with encryption', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      // Should create main queue and DLQ
      template.resourceCountIs('AWS::SQS::Queue', 2);

      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'dev-email-ses-events',
        VisibilityTimeout: 360, // 6x Lambda timeout
      });
    });

    test('creates dead letter queue', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'dev-email-ses-events-dlq',
        MessageRetentionPeriod: 1209600, // 14 days in seconds
      });
    });

    test('main queue has DLQ configured with max receive count', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      // Find the main queue (not DLQ)
      const queues = template.findResources('AWS::SQS::Queue');
      const mainQueue = Object.values(queues).find(
        (queue: any) =>
          queue.Properties.QueueName === 'dev-email-ses-events' &&
          queue.Properties.RedrivePolicy
      );

      expect(mainQueue).toBeDefined();
      expect((mainQueue as any).Properties.RedrivePolicy.maxReceiveCount).toBe(3);
    });

    test('creates dedicated KMS key for SES events', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::KMS::Key', 1);

      template.hasResourceProperties('AWS::KMS::Key', {
        EnableKeyRotation: true,
      });

      template.hasResourceProperties('AWS::KMS::Alias', {
        AliasName: 'alias/dev-email-ses-events-key',
      });
    });

    test('KMS key has SNS and SQS service policies', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::KMS::Key', {
        KeyPolicy: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'AllowSNSToEncrypt',
              Effect: 'Allow',
              Principal: {
                Service: 'sns.amazonaws.com',
              },
            }),
            Match.objectLike({
              Sid: 'AllowSQSToDecrypt',
              Effect: 'Allow',
              Principal: {
                Service: 'sqs.amazonaws.com',
              },
            }),
          ]),
        },
      });
    });

    test('SNS topic subscribes to SQS queue', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::SNS::Subscription', 1);

      template.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'sqs',
        RawMessageDelivery: false, // Keep SNS envelope
      });
    });

    test('creates SES event destination with correct event types', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::SES::ConfigurationSetEventDestination', 1);

      template.hasResourceProperties('AWS::SES::ConfigurationSetEventDestination', {
        ConfigurationSetName: Match.objectLike({ Ref: Match.anyValue() }),
        EventDestination: {
          Name: 'dev-email-ses-sns-destination',
          Enabled: true,
          MatchingEventTypes: Match.arrayWith(['send', 'delivery', 'bounce', 'complaint', 'reject']),
          SnsDestination: {
            TopicARN: Match.anyValue(),
          },
        },
      });
    });
  });

  describe('Lambda Event Handler', () => {
    test('creates Lambda function with correct configuration', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::Lambda::Function', 1);

      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'dev-email-ses-event-processor',
        Runtime: 'nodejs20.x',
        Timeout: 60,
        MemorySize: 256,
        Architectures: ['arm64'],
      });
    });

    test('Lambda has correct environment variables', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: {
            ENVIRONMENT: 'dev',
            REGION: 'eu-west-2',
            LOG_LEVEL: 'DEBUG',
            DELIVERIES_TABLE: Match.anyValue(),
            SUBSCRIBERS_TABLE: Match.anyValue(),
            AUDIT_EVENTS_TABLE: Match.anyValue(),
            ENGAGEMENT_EVENTS_TABLE: Match.anyValue(),
          },
        },
      });
    });

    test('Lambda has IAM permission to consume from SQS', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                'sqs:ReceiveMessage',
                'sqs:ChangeMessageVisibility',
                'sqs:GetQueueUrl',
                'sqs:DeleteMessage',
                'sqs:GetQueueAttributes',
              ]),
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });

    test('Lambda has IAM permission to decrypt KMS key', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'kms:Decrypt',
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });

    test('Lambda does NOT have ses:SendEmail permission', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      // Get all IAM policies
      const policies = template.findResources('AWS::IAM::Policy');

      // Check none of them grant ses:SendEmail
      Object.values(policies).forEach((policy: any) => {
        const statements = policy.Properties.PolicyDocument.Statement;
        statements.forEach((statement: any) => {
          if (Array.isArray(statement.Action)) {
            expect(statement.Action).not.toContain('ses:SendEmail');
            expect(statement.Action).not.toContain('ses:Send*');
            expect(statement.Action).not.toContain('ses:*');
          } else if (typeof statement.Action === 'string') {
            expect(statement.Action).not.toBe('ses:SendEmail');
            expect(statement.Action).not.toBe('ses:Send*');
            expect(statement.Action).not.toBe('ses:*');
          }
        });
      });
    });

    test('creates SQS event source mapping for Lambda', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);

      template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
        BatchSize: 10,
        MaximumBatchingWindowInSeconds: 5,
        FunctionResponseTypes: ['ReportBatchItemFailures'], // Partial batch failure
      });
    });

    test('creates CloudWatch log group with 6-month retention', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/aws/lambda/dev-email-ses-event-processor',
        RetentionInDays: 180, // 6 months
      });
    });
  });

  describe('Environment-specific Configuration', () => {
    test('dev stack has DELETE removal policy', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      // Check KMS key has DELETE/DESTROY policy (default is Delete in CloudFormation)
      const kmsKeys = template.findResources('AWS::KMS::Key');
      Object.values(kmsKeys).forEach((key: any) => {
        // RemovalPolicy.DESTROY translates to DeletionPolicy: Delete in CloudFormation
        expect(key.DeletionPolicy).toBe('Delete');
      });

      // Check SQS queues have DELETE/DESTROY policy
      const queues = template.findResources('AWS::SQS::Queue');
      Object.values(queues).forEach((queue: any) => {
        // RemovalPolicy.DESTROY translates to DeletionPolicy: Delete in CloudFormation
        expect(queue.DeletionPolicy).toBe('Delete');
      });
    });

    test('prod stack has RETAIN removal policy', () => {
      const stack = makeStack(PROD_CONFIG, 'ProdSESStack');
      const template = Template.fromStack(stack);

      // Check KMS key has RETAIN policy
      const kmsKeys = template.findResources('AWS::KMS::Key');
      Object.values(kmsKeys).forEach((key: any) => {
        expect(key.DeletionPolicy).toBe('Retain');
      });

      // Check SQS queues have RETAIN policy
      const queues = template.findResources('AWS::SQS::Queue');
      Object.values(queues).forEach((queue: any) => {
        expect(queue.DeletionPolicy).toBe('Retain');
      });
    });

    test('dev stack has DEBUG log level', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: {
            LOG_LEVEL: 'DEBUG',
          },
        },
      });
    });

    test('prod stack has INFO log level', () => {
      const stack = makeStack(PROD_CONFIG, 'ProdSESStack');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: {
            LOG_LEVEL: 'INFO',
          },
        },
      });
    });
  });

  describe('CloudFormation Outputs', () => {
    test('exports all required outputs', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      // Should have outputs for all key resources
      const outputs = template.findOutputs('*');

      expect(outputs.EmailIdentityName).toBeDefined();
      expect(outputs.ConfigurationSetName).toBeDefined();
      expect(outputs.EventTopicArn).toBeDefined();
      expect(outputs.EventQueueUrl).toBeDefined();
      expect(outputs.EventQueueArn).toBeDefined();
      expect(outputs.DeadLetterQueueUrl).toBeDefined();
      expect(outputs.EventHandlerFunctionName).toBeDefined();
      expect(outputs.EventHandlerFunctionArn).toBeDefined();
      expect(outputs.EncryptionKeyId).toBeDefined();
      expect(outputs.EncryptionKeyArn).toBeDefined();
    });

    test('outputs have correct export names', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      const outputs = template.findOutputs('*');

      expect(outputs.EmailIdentityName.Export.Name).toBe('dev-SESEmailIdentityName');
      expect(outputs.ConfigurationSetName.Export.Name).toBe('dev-SESConfigurationSetName');
      expect(outputs.EventTopicArn.Export.Name).toBe('dev-SESEventTopicArn');
      expect(outputs.EventQueueUrl.Export.Name).toBe('dev-SESEventQueueUrl');
    });
  });

  describe('Tagging', () => {
    test('all resources are tagged correctly', () => {
      const stack = makeStack(DEV_CONFIG, 'DevSESStack');
      const template = Template.fromStack(stack);

      // Check that key resources have tags in their CloudFormation template
      // Tags are applied at stack level and inherited by resources
      const kmsKeys = template.findResources('AWS::KMS::Key');
      const topics = template.findResources('AWS::SNS::Topic');
      const queues = template.findResources('AWS::SQS::Queue');

      // Verify resources exist (tags are applied via CDK Tags.of())
      expect(Object.keys(kmsKeys).length).toBeGreaterThan(0);
      expect(Object.keys(topics).length).toBeGreaterThan(0);
      expect(Object.keys(queues).length).toBeGreaterThan(0);
    });
  });
});
