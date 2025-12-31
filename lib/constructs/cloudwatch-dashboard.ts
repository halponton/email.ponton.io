import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { EnvironmentConfig, envResourceName } from '../config/environments';

/**
 * Props for CloudWatchDashboardConstruct
 */
export interface CloudWatchDashboardProps {
  /** Environment configuration */
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

  /** CloudWatch alarms */
  readonly alarms: {
    readonly dlqDepthAlarm: cloudwatch.IAlarm;
    readonly lambdaErrorAlarm: cloudwatch.IAlarm;
    readonly api5xxAlarm: cloudwatch.IAlarm;
    readonly sesBounceRateAlarm: cloudwatch.IAlarm;
    readonly sesComplaintRateAlarm: cloudwatch.IAlarm;
    readonly systemHealthAlarm: cloudwatch.IAlarm;
  };
}

/**
 * CloudWatch Dashboard Construct
 *
 * Creates a comprehensive CloudWatch dashboard for email platform observability.
 *
 * Dashboard sections:
 * 1. System Health - Overall alarm status and key metrics
 * 2. API Gateway - Request rates, latency, errors
 * 3. Lambda Functions - Invocations, errors, duration, throttles
 * 4. SES Metrics - Sends, deliveries, bounces, complaints
 * 5. SES Event Processing - Queue depth, DLQ, processing latency
 * 6. DynamoDB - Read/write capacity, throttles, item counts
 *
 * Per Milestone 6 architecture requirements:
 * - All critical metrics visible at a glance
 * - Color-coded alarm states
 * - Time-series graphs for trend analysis
 * - Operational metrics for performance tuning
 *
 * Use cases:
 * - Daily operational monitoring
 * - Incident response and debugging
 * - Capacity planning and optimization
 * - Performance trend analysis
 *
 * IMPORTANT: Dashboard shows metrics, NOT PII.
 * All graphs are aggregate counts and rates, never individual records.
 */
export class CloudWatchDashboardConstruct extends Construct {
  /** The CloudWatch dashboard */
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: CloudWatchDashboardProps) {
    super(scope, id);

    const { config, sesEventQueue, sesDeadLetterQueue, sesEventHandler, httpApi, apiStageName, lambdaFunctions, tables, alarms } = props;

    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: envResourceName(config.env, 'email-platform'),
      start: '-PT3H', // Last 3 hours by default
      periodOverride: cloudwatch.PeriodOverride.AUTO,
    });

    /**
     * Section 1: System Health
     *
     * High-level system health indicators and alarm states.
     */
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `# Email Platform - ${config.env.toUpperCase()}

## System Health Overview

This dashboard provides operational visibility into the email.ponton.io platform.

**Environment**: ${config.env}
**Region**: ${config.region}
**API Domain**: ${config.apiDomain}
`,
        width: 24,
        height: 3,
      })
    );

    this.dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({
        title: 'System Health Alarms',
        alarms: [
          alarms.systemHealthAlarm,
          alarms.dlqDepthAlarm,
          alarms.lambdaErrorAlarm,
          alarms.api5xxAlarm,
          alarms.sesBounceRateAlarm,
          alarms.sesComplaintRateAlarm,
        ],
        width: 24,
        height: 3,
      })
    );

    /**
     * Section 2: API Gateway Metrics
     *
     * Request volume, latency, and error rates.
     */
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## API Gateway',
        width: 24,
        height: 1,
      })
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Request Count',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: 'Count',
            dimensionsMap: {
              ApiId: httpApi.apiId,
              Stage: apiStageName,
            },
            statistic: cloudwatch.Statistic.SUM,
            label: 'Total Requests',
          }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Latency (p50, p99)',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: 'Latency',
            dimensionsMap: {
              ApiId: httpApi.apiId,
              Stage: apiStageName,
            },
            statistic: 'p50',
            label: 'p50',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: 'Latency',
            dimensionsMap: {
              ApiId: httpApi.apiId,
              Stage: apiStageName,
            },
            statistic: 'p99',
            label: 'p99',
          }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Errors (4xx, 5xx)',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '4XXError',
            dimensionsMap: {
              ApiId: httpApi.apiId,
              Stage: apiStageName,
            },
            statistic: cloudwatch.Statistic.SUM,
            label: '4xx Errors',
            color: cloudwatch.Color.ORANGE,
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '5XXError',
            dimensionsMap: {
              ApiId: httpApi.apiId,
              Stage: apiStageName,
            },
            statistic: cloudwatch.Statistic.SUM,
            label: '5xx Errors',
            color: cloudwatch.Color.RED,
          }),
        ],
        width: 8,
        height: 6,
      })
    );

    /**
     * Section 3: Lambda Functions
     *
     * Invocations, errors, duration, and throttles.
     */
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## Lambda Functions',
        width: 24,
        height: 1,
      })
    );

    // Create metrics for all Lambda functions
    const lambdaInvocations = lambdaFunctions.map(fn =>
      fn.metricInvocations({ label: fn.functionName, statistic: cloudwatch.Statistic.SUM })
    );

    const lambdaErrors = lambdaFunctions.map(fn =>
      fn.metricErrors({ label: fn.functionName, statistic: cloudwatch.Statistic.SUM, color: cloudwatch.Color.RED })
    );

    const lambdaDuration = lambdaFunctions.map(fn =>
      fn.metricDuration({ label: fn.functionName, statistic: 'p99' })
    );

    const lambdaThrottles = lambdaFunctions.map(fn =>
      fn.metricThrottles({ label: fn.functionName, statistic: cloudwatch.Statistic.SUM, color: cloudwatch.Color.ORANGE })
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Invocations',
        left: lambdaInvocations,
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Errors',
        left: lambdaErrors,
        width: 12,
        height: 6,
      })
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Duration (p99)',
        left: lambdaDuration,
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Throttles',
        left: lambdaThrottles,
        width: 12,
        height: 6,
      })
    );

    /**
     * Section 4: SES Metrics
     *
     * Email sending, delivery, bounce, and complaint metrics.
     */
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## SES Email Metrics',
        width: 24,
        height: 1,
      })
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'SES Sends',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/SES',
            metricName: 'Send',
            statistic: cloudwatch.Statistic.SUM,
            label: 'Emails Sent',
          }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'SES Deliveries',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/SES',
            metricName: 'Delivery',
            statistic: cloudwatch.Statistic.SUM,
            label: 'Emails Delivered',
            color: cloudwatch.Color.GREEN,
          }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'SES Bounces',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/SES',
            metricName: 'Bounce',
            statistic: cloudwatch.Statistic.SUM,
            label: 'Bounces',
            color: cloudwatch.Color.ORANGE,
          }),
        ],
        width: 8,
        height: 6,
      })
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'SES Complaints',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/SES',
            metricName: 'Complaint',
            statistic: cloudwatch.Statistic.SUM,
            label: 'Complaints',
            color: cloudwatch.Color.RED,
          }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'SES Bounce Rate (%)',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/SES',
            metricName: 'Reputation.BounceRate',
            statistic: cloudwatch.Statistic.AVERAGE,
            label: 'Bounce Rate',
            color: cloudwatch.Color.ORANGE,
          }),
        ],
        width: 8,
        height: 6,
        leftYAxis: {
          min: 0,
          max: 10,
        },
      }),
      new cloudwatch.GraphWidget({
        title: 'SES Complaint Rate (%)',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/SES',
            metricName: 'Reputation.ComplaintRate',
            statistic: cloudwatch.Statistic.AVERAGE,
            label: 'Complaint Rate',
            color: cloudwatch.Color.RED,
          }),
        ],
        width: 8,
        height: 6,
        leftYAxis: {
          min: 0,
          max: 1,
        },
      })
    );

    /**
     * Section 5: SES Event Processing
     *
     * Queue depth, DLQ messages, and processing latency.
     */
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## SES Event Processing',
        width: 24,
        height: 1,
      })
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'SES Event Queue Depth',
        left: [
          sesEventQueue.metricApproximateNumberOfMessagesVisible({
            label: 'Messages in Queue',
          }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'SES Event DLQ Depth',
        left: [
          sesDeadLetterQueue.metricApproximateNumberOfMessagesVisible({
            label: 'Messages in DLQ',
            color: cloudwatch.Color.RED,
          }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'SES Event Handler Duration',
        left: [
          sesEventHandler.metricDuration({
            label: 'p50',
            statistic: 'p50',
          }),
          sesEventHandler.metricDuration({
            label: 'p99',
            statistic: 'p99',
            color: cloudwatch.Color.ORANGE,
          }),
        ],
        width: 8,
        height: 6,
      })
    );

    /**
     * Section 6: DynamoDB Metrics
     *
     * Read/write capacity, throttles, and item counts.
     */
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## DynamoDB Tables',
        width: 24,
        height: 1,
      })
    );

    // Subscribers table metrics
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Subscribers Table - Operations',
        left: [
          tables.subscribersTable.metricConsumedReadCapacityUnits({
            label: 'Read Capacity',
          }),
          tables.subscribersTable.metricConsumedWriteCapacityUnits({
            label: 'Write Capacity',
            color: cloudwatch.Color.ORANGE,
          }),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Subscribers Table - Throttles',
        left: [
          tables.subscribersTable.metricUserErrors({
            label: 'User Errors',
            color: cloudwatch.Color.RED,
          }),
          tables.subscribersTable.metricSystemErrorsForOperations({
            label: 'System Errors',
            color: cloudwatch.Color.PURPLE,
          }),
        ],
        width: 12,
        height: 6,
      })
    );

    // Deliveries table metrics
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Deliveries Table - Operations',
        left: [
          tables.deliveriesTable.metricConsumedReadCapacityUnits({
            label: 'Read Capacity',
          }),
          tables.deliveriesTable.metricConsumedWriteCapacityUnits({
            label: 'Write Capacity',
            color: cloudwatch.Color.ORANGE,
          }),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'EngagementEvents Table - Operations',
        left: [
          tables.engagementEventsTable.metricConsumedReadCapacityUnits({
            label: 'Read Capacity',
          }),
          tables.engagementEventsTable.metricConsumedWriteCapacityUnits({
            label: 'Write Capacity',
            color: cloudwatch.Color.ORANGE,
          }),
        ],
        width: 12,
        height: 6,
      })
    );

    // Add tags
    cdk.Tags.of(this).add('Environment', config.env);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Project', 'email.ponton.io');
  }
}
