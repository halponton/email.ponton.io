import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { EnvironmentConfig, envResourceName } from '../config/environments';
import { CloudWatchAlarmsConstruct } from '../constructs/cloudwatch-alarms';
import { CloudWatchDashboardConstruct } from '../constructs/cloudwatch-dashboard';

/**
 * Props for ObservabilityStack
 */
export interface ObservabilityStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;

  /** SES event queue */
  readonly sesEventQueue: sqs.IQueue;

  /** SES event Dead Letter Queue */
  readonly sesDeadLetterQueue: sqs.IQueue;

  /** SES event processor Lambda function */
  readonly sesEventHandler: lambda.IFunction;

  /** API Gateway HTTP API */
  readonly httpApi: apigatewayv2.IHttpApi;

  /** API Gateway stage name */
  readonly apiStageName: string;

  /** All Lambda functions to monitor */
  readonly lambdaFunctions: lambda.IFunction[];

  /** DynamoDB tables */
  readonly tables: {
    readonly subscribersTable: dynamodb.ITable;
    readonly campaignsTable: dynamodb.ITable;
    readonly deliveriesTable: dynamodb.ITable;
    readonly auditEventsTable: dynamodb.ITable;
    readonly engagementEventsTable: dynamodb.ITable;
  };
}

/**
 * Observability Stack
 *
 * Creates CloudWatch monitoring infrastructure for the email platform.
 *
 * Components:
 * 1. SNS Topic - Alarm notifications sent to email
 * 2. CloudWatch Alarms - Critical alerts for operational issues
 * 3. CloudWatch Dashboard - Comprehensive metrics visualization
 * 4. Log Groups - Enforced retention policies (180 days)
 *
 * Per Milestone 6 requirements:
 * - Phase 1 (MVP): Dashboard, critical alarms, observability stack
 * - Phase 2 (Production Hardening): Enhanced SES metrics, structured logging, retention verification
 *
 * Security Architecture:
 * - Log sanitization enforced (NO PII in logs)
 * - CloudWatch Logs retention: 180 days per platform invariants
 * - SNS topic: Email subscriptions for alarm notifications
 * - IAM policies: Least privilege for alarm actions
 *
 * Monitoring Coverage:
 * - API Gateway: Request rates, latency, errors
 * - Lambda: Invocations, errors, duration, throttles
 * - SES: Sends, deliveries, bounces, complaints
 * - SQS: Queue depth, DLQ messages
 * - DynamoDB: Read/write capacity, throttles
 *
 * Alarms:
 * - DLQ depth (SES event processing failures)
 * - Lambda error rate (application errors)
 * - API 5xx errors (server errors)
 * - SES bounce rate (deliverability issues)
 * - SES complaint rate (spam complaints)
 *
 * IMPORTANT: This stack depends on other stacks being deployed first.
 * Deploy order: Certificate → DynamoDB → Secrets → SES → Cognito → API Gateway → Observability
 */
export class ObservabilityStack extends cdk.Stack {
  /** SNS topic for alarm notifications */
  public readonly alarmTopic: sns.Topic;

  /** CloudWatch alarms construct */
  public readonly alarms: CloudWatchAlarmsConstruct;

  /** CloudWatch dashboard construct */
  public readonly dashboard: CloudWatchDashboardConstruct;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const { config, sesEventQueue, sesDeadLetterQueue, sesEventHandler, httpApi, apiStageName, lambdaFunctions, tables } = props;

    /**
     * SNS Topic for Alarm Notifications
     *
     * All CloudWatch alarms send notifications to this topic.
     * Email subscriptions are created per environment configuration.
     *
     * Note: Email subscriptions require manual confirmation via email.
     * After deployment, check the notification email and confirm subscription.
     */
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: envResourceName(config.env, 'email-alarms'),
      displayName: `Email Platform Alarms (${config.env})`,
    });

    // Add email subscription for alarm notifications
    this.alarmTopic.addSubscription(
      new sns_subscriptions.EmailSubscription(config.observability.alarmNotificationEmail)
    );

    /**
     * CloudWatch Alarms
     *
     * Creates critical alarms for operational monitoring.
     */
    this.alarms = new CloudWatchAlarmsConstruct(this, 'Alarms', {
      config,
      alarmTopic: this.alarmTopic,
      sesDeadLetterQueue,
      sesEventHandler,
      httpApi,
      apiStageName,
      lambdaFunctions,
    });

    /**
     * CloudWatch Dashboard
     *
     * Creates comprehensive metrics dashboard.
     */
    this.dashboard = new CloudWatchDashboardConstruct(this, 'Dashboard', {
      config,
      sesEventQueue,
      sesDeadLetterQueue,
      sesEventHandler,
      httpApi,
      apiStageName,
      lambdaFunctions,
      tables,
      alarms: {
        dlqDepthAlarm: this.alarms.dlqDepthAlarm,
        lambdaErrorAlarm: this.alarms.lambdaErrorAlarm,
        api5xxAlarm: this.alarms.api5xxAlarm,
        sesBounceRateAlarm: this.alarms.sesBounceRateAlarm,
        sesComplaintRateAlarm: this.alarms.sesComplaintRateAlarm,
        systemHealthAlarm: this.alarms.systemHealthAlarm,
      },
    });

    /**
     * Log Retention Enforcement
     *
     * Per platform invariants section 11:
     * - Application logs retained for 180 days (6 months)
     * - Automatic deletion after retention period
     *
     * IMPORTANT: Log retention is now managed directly in the StandardLambdaFunction construct
     * (lib/constructs/lambda-function.ts). Each Lambda function creates its own LogGroup with
     * the correct retention policy and removal policy during function creation.
     *
     * This approach prevents CloudFormation conflicts that occur when multiple resources
     * try to manage the same log group. The StandardLambdaFunction construct creates log groups
     * with these properties:
     * - Retention: 180 days (6 months) per platform invariants
     * - Removal policy: RETAIN for prod, DESTROY for dev
     * - Log group name: /aws/lambda/{functionName}
     *
     * SECURITY: Production logs are retained even after stack deletion to maintain
     * audit trail. Dev logs are cleaned up on stack deletion to save costs.
     *
     * DO NOT add LogRetention resources here - they will conflict with the log groups
     * created by StandardLambdaFunction.
     */

    /**
     * CloudFormation Outputs
     *
     * Export key resource identifiers for operational access.
     */
    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: this.alarmTopic.topicArn,
      description: 'SNS topic ARN for alarm notifications',
      exportName: envResourceName(config.env, 'AlarmTopicArn'),
    });

    new cdk.CfnOutput(this, 'AlarmTopicName', {
      value: this.alarmTopic.topicName,
      description: 'SNS topic name for alarm notifications',
      exportName: envResourceName(config.env, 'AlarmTopicName'),
    });

    new cdk.CfnOutput(this, 'DashboardName', {
      value: this.dashboard.dashboard.dashboardName,
      description: 'CloudWatch dashboard name',
      exportName: envResourceName(config.env, 'DashboardName'),
    });

    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${config.region}#dashboards:name=${this.dashboard.dashboard.dashboardName}`,
      description: 'CloudWatch dashboard URL',
    });

    // Output alarm ARNs for external integrations
    new cdk.CfnOutput(this, 'DLQDepthAlarmArn', {
      value: this.alarms.dlqDepthAlarm.alarmArn,
      description: 'DLQ depth alarm ARN',
    });

    new cdk.CfnOutput(this, 'LambdaErrorAlarmArn', {
      value: this.alarms.lambdaErrorAlarm.alarmArn,
      description: 'Lambda error rate alarm ARN',
    });

    new cdk.CfnOutput(this, 'Api5xxAlarmArn', {
      value: this.alarms.api5xxAlarm.alarmArn,
      description: 'API 5xx error alarm ARN',
    });

    new cdk.CfnOutput(this, 'SESBounceRateAlarmArn', {
      value: this.alarms.sesBounceRateAlarm.alarmArn,
      description: 'SES bounce rate alarm ARN',
    });

    new cdk.CfnOutput(this, 'SESComplaintRateAlarmArn', {
      value: this.alarms.sesComplaintRateAlarm.alarmArn,
      description: 'SES complaint rate alarm ARN',
    });

    new cdk.CfnOutput(this, 'SystemHealthAlarmArn', {
      value: this.alarms.systemHealthAlarm.alarmArn,
      description: 'System health composite alarm ARN',
    });

    // Add tags
    cdk.Tags.of(this).add('Environment', config.env);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Project', 'email.ponton.io');
  }
}
