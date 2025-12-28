import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DynamoDBStack } from '../lib/stacks/dynamodb-stack';
import { DEV_CONFIG, PROD_CONFIG, EnvironmentConfig } from '../lib/config/environments';

const makeStack = (config: EnvironmentConfig, id: string): DynamoDBStack => {
  const app = new cdk.App();
  return new DynamoDBStack(app, id, {
    config,
    env: { account: '111111111111', region: config.region },
  });
};

describe('DynamoDBStack', () => {
  test('dev config sets DynamoDB tables, GSIs, and TTL', () => {
    const stack = makeStack(DEV_CONFIG, 'DevDynamoDBStack');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::DynamoDB::Table', 5);
    template.resourceCountIs('AWS::KMS::Key', 1);

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'dev-email-engagement-events',
      TimeToLiveSpecification: {
        AttributeName: 'expiresAt',
        Enabled: true,
      },
      DeletionProtectionEnabled: false,
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: false,
      },
    });

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'dev-email-subscribers',
      BillingMode: 'PAY_PER_REQUEST',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'EmailHashIndex' }),
        Match.objectLike({ IndexName: 'ConfirmTokenIndex' }),
        Match.objectLike({ IndexName: 'UnsubscribeTokenIndex' }),
        Match.objectLike({ IndexName: 'StateIndex' }),
      ]),
    });

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'dev-email-audit-events',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'SubscriberEventsIndex' }),
      ]),
    });

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'dev-email-campaigns',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'StatusIndex' }),
      ]),
    });

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'dev-email-deliveries',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'CampaignDeliveriesIndex' }),
        Match.objectLike({ IndexName: 'SubscriberDeliveriesIndex' }),
        Match.objectLike({ IndexName: 'StatusIndex' }),
      ]),
    });
  });

  test('prod config enables deletion protection and PITR on business tables', () => {
    const stack = makeStack(PROD_CONFIG, 'ProdDynamoDBStack');
    const template = Template.fromStack(stack);

    const tables = [
      'prod-email-subscribers',
      'prod-email-audit-events',
      'prod-email-campaigns',
      'prod-email-deliveries',
      'prod-email-engagement-events',
    ];

    tables.forEach((tableName) => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: tableName,
        DeletionProtectionEnabled: true,
      });
    });

    const pitrTables = [
      'prod-email-subscribers',
      'prod-email-audit-events',
      'prod-email-campaigns',
      'prod-email-deliveries',
    ];

    pitrTables.forEach((tableName) => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: tableName,
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
      });
    });

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'prod-email-engagement-events',
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: false,
      },
    });
  });
});
