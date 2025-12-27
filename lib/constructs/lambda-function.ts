import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';
import { EnvironmentConfig, envResourceName } from '../config/environments';

/**
 * Props for creating a standardized Lambda function
 */
export interface StandardLambdaProps {
  /** Environment configuration */
  readonly config: EnvironmentConfig;

  /** Function name (will be prefixed with environment) */
  readonly functionName: string;

  /** Handler file name (without extension, e.g., 'health' for health.ts) */
  readonly handlerFileName: string;

  /** Description of the function's purpose */
  readonly description: string;

  /** Memory size in MB (default: 256) */
  readonly memorySize?: number;

  /** Timeout in seconds (default: 30) */
  readonly timeout?: number;

  /** Environment variables to pass to the function */
  readonly environment?: { [key: string]: string };
}

/**
 * Standardized Lambda function construct
 *
 * Creates a Lambda function with consistent configuration:
 * - Node.js 20 runtime
 * - TypeScript support via esbuild bundling
 * - Appropriate log retention per environment
 * - Environment-scoped naming
 * - Standard IAM execution role with least privilege
 * - CloudWatch Logs integration
 *
 * Per PLATFORM_INVARIANTS.md section 1:
 * - This infrastructure layer wires Lambda functions
 * - Domain logic lives in ponton.io_email_service
 * - No business logic in this construct
 */
export class StandardLambdaFunction extends Construct {
  /** The Lambda function */
  public readonly function: lambdaNodejs.NodejsFunction;

  /** The CloudWatch log group */
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: StandardLambdaProps) {
    super(scope, id);

    const {
      config,
      functionName,
      handlerFileName,
      description,
      memorySize = 256,
      timeout = 30,
      environment = {},
    } = props;

    // Create log group with appropriate retention
    // Per PLATFORM_INVARIANTS.md section 11: Application logs retained for 6 months
    this.logGroup = new logs.LogGroup(
      this,
      'LogGroup',
      {
        logGroupName: `/aws/lambda/${envResourceName(config.env, functionName)}`,
        retention: logs.RetentionDays.SIX_MONTHS,
        removalPolicy: config.env === 'prod'
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
      }
    );

    // Merge standard environment variables with custom ones
    const functionEnvironment = {
      ENVIRONMENT: config.env,
      REGION: config.region,
      LOG_LEVEL: config.env === 'dev' ? 'DEBUG' : 'INFO',
      ...environment,
    };

    // Create Lambda function using NodejsFunction for TypeScript support
    this.function = new lambdaNodejs.NodejsFunction(this, 'Function', {
      functionName: envResourceName(config.env, functionName),
      entry: path.join(__dirname, '..', 'handlers', `${handlerFileName}.ts`),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize,
      timeout: cdk.Duration.seconds(timeout),
      description: `${description} (${config.env})`,
      environment: functionEnvironment,
      logGroup: this.logGroup,
      architecture: lambda.Architecture.ARM_64, // Graviton2 for cost optimization
      tracing: config.enableDetailedMonitoring
        ? lambda.Tracing.ACTIVE
        : lambda.Tracing.DISABLED,
      bundling: {
        minify: config.env === 'prod',
        sourceMap: true,
        target: 'node20',
        format: lambdaNodejs.OutputFormat.ESM,
        mainFields: ['module', 'main'],
      },
    });

    // Add tags
    cdk.Tags.of(this.function).add('Environment', config.env);
    cdk.Tags.of(this.function).add('ManagedBy', 'CDK');
    cdk.Tags.of(this.function).add('Handler', handlerFileName);
  }

  /**
   * Grant this function permission to invoke another function
   */
  public grantInvoke(grantee: iam.IGrantable): void {
    this.function.grantInvoke(grantee);
  }
}
