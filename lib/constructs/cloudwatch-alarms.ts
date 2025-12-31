import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { Construct } from 'constructs';
import { EnvironmentConfig, envResourceName } from '../config/environments';

/**
 * Props for CloudWatchAlarmsConstruct
 */
export interface CloudWatchAlarmsProps {
  /** Environment configuration */
  readonly config: EnvironmentConfig;

  /** SNS topic for alarm notifications */
  readonly alarmTopic: sns.ITopic;

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
}

/**
 * CloudWatch Alarms Construct
 *
 * Creates CloudWatch alarms for critical infrastructure metrics.
 *
 * Alarms created:
 * 1. Dead Letter Queue Depth - Alert when DLQ has messages (SES event processing failures)
 * 2. Lambda Error Rate - Alert when Lambda error rate exceeds threshold
 * 3. API Gateway 5xx Errors - Alert when API returns server errors
 * 4. SES Bounce Rate - Alert when email bounce rate is high
 * 5. SES Complaint Rate - Alert when spam complaint rate is high
 *
 * Per Milestone 6 security and architecture requirements:
 * - All alarms send notifications to SNS topic (email subscriptions)
 * - Alarms configured with environment-specific thresholds
 * - Production has stricter thresholds than dev
 * - Evaluation periods minimize false positives while maintaining responsiveness
 *
 * Alarm Actions:
 * - SNS topic notifications (email alerts)
 * - CloudWatch dashboard visibility
 * - Future: Integration with PagerDuty, Slack, etc.
 *
 * IMPORTANT: Alarms are for operational monitoring, NOT security incident detection.
 * Security events (unauthorized access, data breaches) require separate tooling.
 */
export class CloudWatchAlarmsConstruct extends Construct {
  /** Alarm for DLQ depth */
  public readonly dlqDepthAlarm: cloudwatch.Alarm;

  /** Alarm for Lambda errors */
  public readonly lambdaErrorAlarm: cloudwatch.Alarm;

  /** Alarm for API 5xx errors */
  public readonly api5xxAlarm: cloudwatch.Alarm;

  /** Alarm for SES bounce rate */
  public readonly sesBounceRateAlarm: cloudwatch.Alarm;

  /** Alarm for SES complaint rate */
  public readonly sesComplaintRateAlarm: cloudwatch.Alarm;

  /** Composite alarm for overall system health */
  public readonly systemHealthAlarm: cloudwatch.CompositeAlarm;

  constructor(scope: Construct, id: string, props: CloudWatchAlarmsProps) {
    super(scope, id);

    const { config, alarmTopic, sesDeadLetterQueue, sesEventHandler, httpApi, apiStageName, lambdaFunctions } = props;

    /**
     * Alarm 1: Dead Letter Queue Depth
     *
     * Monitors SES event processing failures.
     * Messages in DLQ indicate:
     * - SES event handler errors (after max retries)
     * - Database write failures
     * - Malformed SES events
     * - SNS signature verification failures
     *
     * Action required:
     * - Check Lambda logs for errors
     * - Verify DynamoDB table availability
     * - Check for SES event schema changes
     * - Re-drive DLQ messages after fixing root cause
     */
    this.dlqDepthAlarm = new cloudwatch.Alarm(this, 'DLQDepthAlarm', {
      alarmName: envResourceName(config.env, 'ses-dlq-depth'),
      alarmDescription: 'SES event Dead Letter Queue has messages (processing failures)',
      metric: sesDeadLetterQueue.metricApproximateNumberOfMessagesVisible(),
      threshold: config.observability.alarms.dlqDepthThreshold,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    this.dlqDepthAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));

    /**
     * Alarm 2: Lambda Error Rate
     *
     * Monitors Lambda function errors across all functions.
     * High error rate indicates:
     * - Application bugs
     * - Timeout issues
     * - Memory exhaustion
     * - External dependency failures (DynamoDB, SES)
     *
     * Action required:
     * - Check CloudWatch Logs for error messages
     * - Review Lambda metrics (duration, memory, throttles)
     * - Verify downstream service health (DynamoDB, SES)
     */
    this.lambdaErrorAlarm = new cloudwatch.Alarm(this, 'LambdaErrorAlarm', {
      alarmName: envResourceName(config.env, 'lambda-error-rate'),
      alarmDescription: 'Lambda error rate exceeds threshold',
      metric: new cloudwatch.MathExpression({
        expression: '(errors / invocations) * 100',
        usingMetrics: {
          errors: this.createCompositeLambdaMetric(lambdaFunctions, 'Errors', cloudwatch.Statistic.SUM),
          invocations: this.createCompositeLambdaMetric(lambdaFunctions, 'Invocations', cloudwatch.Statistic.SUM),
        },
        period: cdk.Duration.minutes(5),
      }),
      threshold: config.observability.alarms.lambdaErrorRateThreshold,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    this.lambdaErrorAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));

    /**
     * Alarm 3: API Gateway 5xx Errors
     *
     * Monitors API Gateway server errors.
     * High 5xx rate indicates:
     * - Lambda function failures
     * - Lambda timeouts
     * - Lambda cold start issues
     * - API Gateway throttling
     * - Authorizer failures
     *
     * Action required:
     * - Check API Gateway access logs
     * - Review Lambda error logs
     * - Verify Lambda concurrency limits
     * - Check authorizer function health
     */
    this.api5xxAlarm = new cloudwatch.Alarm(this, 'Api5xxAlarm', {
      alarmName: envResourceName(config.env, 'api-5xx-errors'),
      alarmDescription: 'API Gateway 5xx error count exceeds threshold',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '5XXError',
        dimensionsMap: {
          ApiId: httpApi.apiId,
          Stage: apiStageName,
        },
        statistic: cloudwatch.Statistic.SUM,
        period: cdk.Duration.minutes(5),
      }),
      threshold: config.observability.alarms.api5xxThreshold,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    this.api5xxAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));

    /**
     * Alarm 4: SES Bounce Rate
     *
     * Monitors email bounce rate.
     * High bounce rate indicates:
     * - Invalid recipient email addresses
     * - Recipient mailbox full
     * - Recipient mail server issues
     * - Spam list issues
     * - Domain reputation problems
     *
     * SES automatically suppresses emails to repeatedly bouncing addresses.
     * Sustained high bounce rate (>5%) risks SES account suspension.
     *
     * IMPORTANT: Reputation.BounceRate is already a percentage from AWS SES.
     * We use it directly without further calculation.
     * See: https://docs.aws.amazon.com/ses/latest/dg/monitor-reputation.html
     *
     * Action required:
     * - Review bounce reasons in DynamoDB EngagementEvents table
     * - Clean subscriber list (suppress hard bounces)
     * - Verify email validation in subscribe flow
     * - Check SES reputation dashboard
     */
    this.sesBounceRateAlarm = new cloudwatch.Alarm(this, 'SESBounceRateAlarm', {
      alarmName: envResourceName(config.env, 'ses-bounce-rate'),
      alarmDescription: 'SES bounce rate exceeds threshold (risk of account suspension)',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SES',
        metricName: 'Reputation.BounceRate',
        statistic: cloudwatch.Statistic.AVERAGE,
        period: cdk.Duration.minutes(15),
      }),
      threshold: config.observability.alarms.sesBounceRateThreshold,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    this.sesBounceRateAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));

    /**
     * Alarm 5: SES Complaint Rate
     *
     * Monitors spam complaint rate.
     * High complaint rate indicates:
     * - Recipients marking emails as spam
     * - Poor email content quality
     * - Sending to unengaged subscribers
     * - Lack of unsubscribe link
     * - Misleading subject lines
     *
     * SES automatically suppresses emails to complaining recipients.
     * Sustained high complaint rate (>0.1%) risks SES account suspension.
     *
     * CRITICAL: Complaint rate >0.5% will trigger automatic SES sending pause.
     *
     * IMPORTANT: Reputation.ComplaintRate is already a percentage from AWS SES.
     * We use it directly without further calculation.
     * See: https://docs.aws.amazon.com/ses/latest/dg/monitor-reputation.html
     *
     * Action required:
     * - Review email content and subject lines
     * - Verify unsubscribe links are prominent
     * - Clean subscriber list (suppress complaints)
     * - Check SES reputation dashboard
     * - Consider re-engagement campaign before suppression
     */
    this.sesComplaintRateAlarm = new cloudwatch.Alarm(this, 'SESComplaintRateAlarm', {
      alarmName: envResourceName(config.env, 'ses-complaint-rate'),
      alarmDescription: 'SES complaint rate exceeds threshold (risk of account suspension)',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SES',
        metricName: 'Reputation.ComplaintRate',
        statistic: cloudwatch.Statistic.AVERAGE,
        period: cdk.Duration.minutes(15),
      }),
      threshold: config.observability.alarms.sesComplaintRateThreshold,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    this.sesComplaintRateAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));

    /**
     * Composite Alarm: System Health
     *
     * Aggregates critical alarms into a single system health indicator.
     * System is unhealthy if ANY critical alarm is in ALARM state.
     *
     * Use case:
     * - Single notification for multiple concurrent issues
     * - High-level dashboard status
     * - Integration with external monitoring (PagerDuty, Slack)
     */
    this.systemHealthAlarm = new cloudwatch.CompositeAlarm(this, 'SystemHealthAlarm', {
      compositeAlarmName: envResourceName(config.env, 'system-health'),
      alarmDescription: 'Overall system health (composite of critical alarms)',
      alarmRule: cloudwatch.AlarmRule.anyOf(
        cloudwatch.AlarmRule.fromAlarm(this.dlqDepthAlarm, cloudwatch.AlarmState.ALARM),
        cloudwatch.AlarmRule.fromAlarm(this.lambdaErrorAlarm, cloudwatch.AlarmState.ALARM),
        cloudwatch.AlarmRule.fromAlarm(this.api5xxAlarm, cloudwatch.AlarmState.ALARM),
        cloudwatch.AlarmRule.fromAlarm(this.sesBounceRateAlarm, cloudwatch.AlarmState.ALARM),
        cloudwatch.AlarmRule.fromAlarm(this.sesComplaintRateAlarm, cloudwatch.AlarmState.ALARM)
      ),
    });

    this.systemHealthAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));

    // Add tags
    cdk.Tags.of(this).add('Environment', config.env);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Project', 'email.ponton.io');
  }

  /**
   * Create composite Lambda metric across multiple functions
   *
   * Aggregates metrics from all Lambda functions for error rate calculation.
   *
   * @param functions - Lambda functions to monitor
   * @param metricName - CloudWatch metric name
   * @param statistic - Metric statistic
   * @returns Composite metric (Metric or MathExpression)
   */
  private createCompositeLambdaMetric(
    functions: lambda.IFunction[],
    metricName: string,
    statistic: string
  ): cloudwatch.IMetric {
    // Create metric for first function (required for MathExpression)
    const firstMetric = new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName,
      dimensionsMap: {
        FunctionName: functions[0].functionName,
      },
      statistic,
      period: cdk.Duration.minutes(5),
    });

    // If only one function, return its metric
    if (functions.length === 1) {
      return firstMetric;
    }

    // Create metrics for remaining functions
    const metrics: Record<string, cloudwatch.IMetric> = {};
    functions.forEach((fn, index) => {
      metrics[`m${index}`] = new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName,
        dimensionsMap: {
          FunctionName: fn.functionName,
        },
        statistic,
        period: cdk.Duration.minutes(5),
      });
    });

    // Sum all metrics
    const expression = Object.keys(metrics).join(' + ');
    return new cloudwatch.MathExpression({
      expression,
      usingMetrics: metrics,
      period: cdk.Duration.minutes(5),
    });
  }
}
