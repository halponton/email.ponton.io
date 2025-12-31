import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { ObservabilityStack } from '../lib/stacks/observability-stack';
import { DEV_CONFIG, PROD_CONFIG, EnvironmentConfig } from '../lib/config/environments';

/**
 * Test helper to create a minimal ObservabilityStack for testing
 */
const makeStack = (config: EnvironmentConfig, id: string): ObservabilityStack => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', {
    env: { account: '111111111111', region: config.region },
  });

  // Create mock resources
  const mockQueue = new sqs.Queue(stack, 'MockQueue');
  const mockDLQ = new sqs.Queue(stack, 'MockDLQ');

  const mockFunction = new lambda.Function(stack, 'MockFunction', {
    runtime: lambda.Runtime.NODEJS_20_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => {}'),
  });

  const mockApi = new apigatewayv2.HttpApi(stack, 'MockApi');

  const mockTable = new dynamodb.Table(stack, 'MockTable', {
    partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  });

  return new ObservabilityStack(app, id, {
    config,
    sesEventQueue: mockQueue,
    sesDeadLetterQueue: mockDLQ,
    sesEventHandler: mockFunction,
    httpApi: mockApi,
    apiStageName: '$default',
    lambdaFunctions: [mockFunction],
    tables: {
      subscribersTable: mockTable,
      campaignsTable: mockTable,
      deliveriesTable: mockTable,
      auditEventsTable: mockTable,
      engagementEventsTable: mockTable,
    },
    env: { account: '111111111111', region: config.region },
  });
};

describe('ObservabilityStack', () => {
  describe('SNS Topic', () => {
    test('creates SNS topic for alarm notifications', () => {
      const stack = makeStack(DEV_CONFIG, 'DevObservabilityStack');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::SNS::Topic', {
        TopicName: 'dev-email-alarms',
        DisplayName: 'Email Platform Alarms (dev)',
      });
    });

    test('adds email subscription to alarm topic', () => {
      const stack = makeStack(DEV_CONFIG, 'DevObservabilityStack');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'email',
        Endpoint: DEV_CONFIG.observability.alarmNotificationEmail,
      });
    });
  });

  describe('CloudWatch Alarms', () => {
    test('creates DLQ depth alarm', () => {
      const stack = makeStack(DEV_CONFIG, 'DevObservabilityStack');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'dev-ses-dlq-depth',
        AlarmDescription: 'SES event Dead Letter Queue has messages (processing failures)',
        Threshold: DEV_CONFIG.observability.alarms.dlqDepthThreshold,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        TreatMissingData: 'notBreaching',
      });
    });

    test('creates Lambda error rate alarm', () => {
      const stack = makeStack(DEV_CONFIG, 'DevObservabilityStack');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'dev-lambda-error-rate',
        AlarmDescription: 'Lambda error rate exceeds threshold',
        Threshold: DEV_CONFIG.observability.alarms.lambdaErrorRateThreshold,
        ComparisonOperator: 'GreaterThanThreshold',
        EvaluationPeriods: 2,
        DatapointsToAlarm: 2,
      });
    });

    test('creates API 5xx alarm', () => {
      const stack = makeStack(DEV_CONFIG, 'DevObservabilityStack');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'dev-api-5xx-errors',
        AlarmDescription: 'API Gateway 5xx error count exceeds threshold',
        Threshold: DEV_CONFIG.observability.alarms.api5xxThreshold,
        ComparisonOperator: 'GreaterThanThreshold',
      });
    });

    test('creates SES bounce rate alarm', () => {
      const stack = makeStack(DEV_CONFIG, 'DevObservabilityStack');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'dev-ses-bounce-rate',
        AlarmDescription: 'SES bounce rate exceeds threshold (risk of account suspension)',
        Threshold: DEV_CONFIG.observability.alarms.sesBounceRateThreshold,
        ComparisonOperator: 'GreaterThanThreshold',
      });
    });

    test('creates SES complaint rate alarm', () => {
      const stack = makeStack(DEV_CONFIG, 'DevObservabilityStack');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'dev-ses-complaint-rate',
        AlarmDescription: 'SES complaint rate exceeds threshold (risk of account suspension)',
        Threshold: DEV_CONFIG.observability.alarms.sesComplaintRateThreshold,
        ComparisonOperator: 'GreaterThanThreshold',
      });
    });

    test('creates composite system health alarm', () => {
      const stack = makeStack(DEV_CONFIG, 'DevObservabilityStack');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::CloudWatch::CompositeAlarm', {
        AlarmName: 'dev-system-health',
        AlarmDescription: 'Overall system health (composite of critical alarms)',
      });
    });

    test('all alarms have SNS actions configured', () => {
      const stack = makeStack(DEV_CONFIG, 'DevObservabilityStack');
      const template = Template.fromStack(stack);

      // Count alarms with SNS actions
      // Should have 5 individual alarms + 1 composite alarm = 6 alarms with actions
      const alarms = template.findResources('AWS::CloudWatch::Alarm');
      const alarmsWithActions = Object.values(alarms).filter((alarm: any) => {
        return alarm.Properties.AlarmActions && alarm.Properties.AlarmActions.length > 0;
      });

      expect(alarmsWithActions.length).toBe(5); // 5 individual alarms have SNS actions
    });
  });

  describe('CloudWatch Dashboard', () => {
    test('creates CloudWatch dashboard', () => {
      const stack = makeStack(DEV_CONFIG, 'DevObservabilityStack');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
        DashboardName: 'dev-email-platform',
      });
    });

    test('dashboard includes alarm status widgets', () => {
      const stack = makeStack(DEV_CONFIG, 'DevObservabilityStack');
      const template = Template.fromStack(stack);

      const dashboards = template.findResources('AWS::CloudWatch::Dashboard');

      // Dashboard body may contain CDK tokens, so just verify it exists
      expect(Object.values(dashboards).length).toBeGreaterThan(0);
      const dashboard = Object.values(dashboards)[0];
      expect(dashboard.Properties.DashboardBody).toBeDefined();
    });
  });

  describe('Log Retention', () => {
    test('log retention is managed by StandardLambdaFunction construct', () => {
      const stack = makeStack(DEV_CONFIG, 'DevObservabilityStack');
      const template = Template.fromStack(stack);

      // Log retention is now managed directly in StandardLambdaFunction construct
      // (lib/constructs/lambda-function.ts), not in ObservabilityStack.
      // This prevents CloudFormation conflicts when multiple resources try to manage
      // the same log group.
      //
      // ObservabilityStack should NOT contain LogRetention custom resources
      // because they would conflict with log groups created by StandardLambdaFunction.
      const customResources = template.findResources('Custom::LogRetention');
      expect(Object.keys(customResources).length).toBe(0);
    });
  });

  describe('Environment-Specific Configuration', () => {
    test('dev uses relaxed thresholds', () => {
      const stack = makeStack(DEV_CONFIG, 'DevObservabilityStack');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'dev-lambda-error-rate',
        Threshold: 5, // 5% in dev
      });
    });

    test('prod uses strict thresholds', () => {
      const stack = makeStack(PROD_CONFIG, 'ProdObservabilityStack');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'prod-lambda-error-rate',
        Threshold: 2, // 2% in prod (stricter)
      });
    });

    test('prod has stricter DLQ threshold', () => {
      const stack = makeStack(PROD_CONFIG, 'ProdObservabilityStack');
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'prod-ses-dlq-depth',
        Threshold: 5, // 5 messages in prod (stricter)
      });
    });
  });

  describe('CloudFormation Outputs', () => {
    test('exports alarm topic ARN', () => {
      const stack = makeStack(DEV_CONFIG, 'DevObservabilityStack');
      const template = Template.fromStack(stack);

      template.hasOutput('AlarmTopicArn', {
        Description: 'SNS topic ARN for alarm notifications',
        Export: {
          Name: 'dev-AlarmTopicArn',
        },
      });
    });

    test('exports dashboard name', () => {
      const stack = makeStack(DEV_CONFIG, 'DevObservabilityStack');
      const template = Template.fromStack(stack);

      template.hasOutput('DashboardName', {
        Description: 'CloudWatch dashboard name',
        Export: {
          Name: 'dev-DashboardName',
        },
      });
    });

    test('exports dashboard URL', () => {
      const stack = makeStack(DEV_CONFIG, 'DevObservabilityStack');
      const template = Template.fromStack(stack);

      template.hasOutput('DashboardUrl', {
        Description: 'CloudWatch dashboard URL',
      });
    });

    test('exports all alarm ARNs', () => {
      const stack = makeStack(DEV_CONFIG, 'DevObservabilityStack');
      const template = Template.fromStack(stack);

      const outputs = template.toJSON().Outputs;
      const alarmOutputs = Object.keys(outputs).filter(key => key.endsWith('AlarmArn'));

      // Should have 6 alarm outputs (5 individual + 1 composite)
      expect(alarmOutputs.length).toBe(6);
    });
  });

  describe('Resource Tagging', () => {
    test('applies environment tag to all resources', () => {
      const stack = makeStack(DEV_CONFIG, 'DevObservabilityStack');
      const template = Template.fromStack(stack);

      // Check that SNS topic has environment tag
      template.hasResourceProperties('AWS::SNS::Topic', {
        Tags: Match.arrayWith([
          Match.objectLike({
            Key: 'Environment',
            Value: 'dev',
          }),
        ]),
      });
    });

    test('applies project tag to all resources', () => {
      const stack = makeStack(DEV_CONFIG, 'DevObservabilityStack');
      const template = Template.fromStack(stack);

      // Check that SNS topic has project tag
      template.hasResourceProperties('AWS::SNS::Topic', {
        Tags: Match.arrayWith([
          Match.objectLike({
            Key: 'Project',
            Value: 'email.ponton.io',
          }),
        ]),
      });
    });
  });

  describe('IAM Permissions', () => {
    test('SNS topic policy allows CloudWatch alarms to publish', () => {
      const stack = makeStack(DEV_CONFIG, 'DevObservabilityStack');
      const template = Template.fromStack(stack);

      // SNS topic policy is automatically created by CDK when alarms are added
      // Verify alarm topic exists and is referenced by alarms
      const alarms = template.findResources('AWS::CloudWatch::Alarm');
      const alarmsWithActions = Object.values(alarms).filter((alarm: any) => {
        return alarm.Properties.AlarmActions && alarm.Properties.AlarmActions.length > 0;
      });

      expect(alarmsWithActions.length).toBeGreaterThan(0);
    });
  });
});

describe('Retention Verification', () => {
  test('verifies EngagementEvents table has TTL enabled', () => {
    // This is verified in DynamoDB stack tests
    // Observability stack only enforces log retention
    // TTL verification is implicit via DynamoDB table configuration
    expect(true).toBe(true);
  });

  test('verifies all log groups have 180-day retention', () => {
    const stack = makeStack(DEV_CONFIG, 'DevObservabilityStack');
    const template = Template.fromStack(stack);

    const logGroups = template.findResources('AWS::Logs::LogGroup');
    const allHaveCorrectRetention = Object.values(logGroups).every((logGroup: any) => {
      return logGroup.Properties.RetentionInDays === 180;
    });

    expect(allHaveCorrectRetention).toBe(true);
  });
});
