import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { EnvironmentConfig, envResourceName } from '../config/environments';
import { StandardLambdaFunction } from '../constructs/lambda-function';
import { ApiRoutes, RouteDefinition } from '../constructs/api-routes';
import { DynamoDBTablesConstruct } from '../constructs/dynamodb-tables';
import { SecretsConstruct } from '../constructs/secrets';
import { SSMParametersConstruct } from '../constructs/ssm-parameters';

/**
 * Props for ApiGatewayStack
 */
export interface ApiGatewayStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  readonly certificate: acm.ICertificate;
  readonly hostedZone: route53.IHostedZone;
  readonly tables: DynamoDBTablesConstruct;
  readonly secrets: SecretsConstruct;
  readonly parameters: SSMParametersConstruct;
  readonly cognitoUserPoolId: string;
  readonly cognitoClientId: string;
}

/**
 * API Gateway Stack
 *
 * Creates:
 * 1. HTTP API Gateway (v2)
 * 2. Custom domain configuration (environment-scoped)
 * 3. Route53 alias record
 * 4. Lambda functions for all routes
 * 5. Route definitions for public and admin APIs
 *
 * Route structure:
 * - Public API (v1):
 *   - POST /v1/subscribe - Subscribe to newsletter
 *   - GET /v1/confirm - Confirm subscription via token
 *   - POST /v1/unsubscribe - Unsubscribe via token
 *   - GET /v1/track/open/{token} - Track email opens
 *   - GET /v1/track/click/{token} - Track link clicks and redirect
 *   - GET /v1/health - Health check (200 OK)
 *
 * - Admin API (requires authentication via Cognito):
 *   - POST /admin/campaigns - Create campaign
 *   - GET /admin/campaigns/{id} - Get campaign details
 *   - POST /admin/campaigns/{id}/send - Send campaign
 *   - GET /admin/subscribers - List subscribers
 *   - POST /admin/subscribers/{id}/suppress - Suppress subscriber
 *
 * Milestone 1:
 * - Public routes except /v1/health return 501 Not Implemented
 *
 * Milestone 5:
 * - Admin routes protected by Cognito Lambda authorizer (401/403 for unauth users)
 * - JWT validation with group membership enforcement
 * - Users must be in "Administrators" group
 *
 * SECURITY: All /admin/* routes are protected by Lambda authorizer that:
 * - Validates JWT tokens from Cognito User Pool
 * - Enforces group membership (Administrators group required)
 * - Logs all authorization attempts for audit trail
 */
export class ApiGatewayStack extends cdk.Stack {
  /** The HTTP API */
  public readonly httpApi: apigatewayv2.HttpApi;

  /** Custom domain for the API */
  public readonly customDomain: apigatewayv2.DomainName;

  /** Default stage with throttling */
  public readonly httpStage: apigatewayv2.HttpStage;

  /** Health check Lambda function */
  public readonly healthFunction: StandardLambdaFunction;

  /** Not implemented placeholder Lambda function */
  public readonly notImplementedFunction: StandardLambdaFunction;

  /** Admin authorizer Lambda function */
  public readonly adminAuthorizerFunction: StandardLambdaFunction;

  /** Admin route authorizer */
  public readonly adminAuthorizer: apigatewayv2Authorizers.HttpLambdaAuthorizer;

  constructor(scope: Construct, id: string, props: ApiGatewayStackProps) {
    super(scope, id, props);

    const { config, certificate, hostedZone, tables, secrets, parameters, cognitoUserPoolId, cognitoClientId } = props;

    // Create Lambda functions
    this.healthFunction = new StandardLambdaFunction(this, 'HealthFunction', {
      config,
      functionName: 'email-api-health',
      handlerFileName: 'health',
      description: 'Health check endpoint for email.ponton.io API',
      memorySize: 128,
      timeout: 10,
    });

    this.notImplementedFunction = new StandardLambdaFunction(
      this,
      'NotImplementedFunction',
      {
        config,
        functionName: 'email-api-not-implemented',
        handlerFileName: 'not-implemented',
        description: 'Placeholder handler for routes not yet implemented',
        memorySize: 128,
        timeout: 10,
        // No environment variables - this function returns static 501 response
      }
    );

    // Create Cognito authorizer function
    this.adminAuthorizerFunction = new StandardLambdaFunction(
      this,
      'AdminAuthorizerFunction',
      {
        config,
        functionName: 'email-api-cognito-authorizer',
        handlerFileName: 'cognito-authorizer',
        description: 'Cognito JWT authorizer for admin routes with group membership validation',
        memorySize: 256, // Increased for JWT verification
        timeout: 10,
        environment: {
          USER_POOL_ID: cognitoUserPoolId,
          CLIENT_ID: cognitoClientId,
        },
      }
    );

    // Create HTTP API
    const corsOrigins = Array.from(
      new Set(
        [...config.cognito.callbackUrls, ...config.cognito.logoutUrls].map(url => new URL(url).origin)
      )
    );

    this.httpApi = new apigatewayv2.HttpApi(
      this,
      envResourceName(config.env, 'EmailApi'),
      {
        apiName: envResourceName(config.env, 'email-api'),
        description: `Email platform API (${config.env})`,
        // CORS configuration for future admin UI
        corsPreflight: {
          // Keep CORS in sync with configured Cognito callback/logout origins.
          allowOrigins: corsOrigins,
          allowMethods: [
            apigatewayv2.CorsHttpMethod.GET,
            apigatewayv2.CorsHttpMethod.POST,
            // PUT and DELETE removed - add back when needed for admin features
          ],
          allowHeaders: ['Content-Type', 'Authorization'],
          maxAge: cdk.Duration.hours(1),
        },
        createDefaultStage: false,
      }
    );

    this.httpStage = this.httpApi.addStage('DefaultStage', {
      stageName: '$default',
      autoDeploy: true,
      throttle: {
        rateLimit: config.apiGateway.throttle.rateLimit,
        burstLimit: config.apiGateway.throttle.burstLimit,
      },
      detailedMetricsEnabled: config.enableDetailedMonitoring,
    });

    // Create custom domain
    this.customDomain = new apigatewayv2.DomainName(
      this,
      envResourceName(config.env, 'CustomDomain'),
      {
        domainName: config.apiDomain,
        certificate,
      }
    );

    // Map custom domain to API
    new apigatewayv2.ApiMapping(
      this,
      envResourceName(config.env, 'ApiMapping'),
      {
        api: this.httpApi,
        domainName: this.customDomain,
        stage: this.httpStage,
      }
    );

    if (config.waf.enable) {
      const webAcl = new wafv2.CfnWebACL(this, envResourceName(config.env, 'ApiWebAcl'), {
        name: envResourceName(config.env, 'api-web-acl'),
        scope: 'REGIONAL',
        defaultAction: { allow: {} },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: envResourceName(config.env, 'ApiWebAcl'),
          sampledRequestsEnabled: true,
        },
        rules: [
          {
            name: envResourceName(config.env, 'AdminRateLimit'),
            priority: 0,
            action: { block: {} },
            statement: {
              rateBasedStatement: {
                limit: config.waf.adminRateLimit,
                aggregateKeyType: 'IP',
                scopeDownStatement: {
                  byteMatchStatement: {
                    fieldToMatch: { uriPath: {} },
                    positionalConstraint: 'STARTS_WITH',
                    searchString: '/admin',
                    textTransformations: [
                      {
                        priority: 0,
                        type: 'NONE',
                      },
                    ],
                  },
                },
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: envResourceName(config.env, 'AdminRateLimit'),
              sampledRequestsEnabled: true,
            },
          },
        ],
      });

      const partition = cdk.Stack.of(this).partition;
      const apiStageArn = `arn:${partition}:apigateway:${cdk.Stack.of(this).region}::/apis/${this.httpApi.apiId}/stages/${this.httpStage.stageName}`;

      new wafv2.CfnWebACLAssociation(
        this,
        envResourceName(config.env, 'ApiWebAclAssociation'),
        {
          resourceArn: apiStageArn,
          webAclArn: webAcl.attrArn,
        }
      );
    }

    // Create Route53 alias record
    new route53.ARecord(this, envResourceName(config.env, 'AliasRecord'), {
      zone: hostedZone,
      recordName: config.apiDomain,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.ApiGatewayv2DomainProperties(
          this.customDomain.regionalDomainName,
          this.customDomain.regionalHostedZoneId
        )
      ),
    });

    // Create Lambda authorizer for admin routes
    // Uses Cognito JWT validation with group membership enforcement
    // H-2: SECURITY - Caching disabled to prevent privilege escalation via cached policies.
    // The authorizer generates route-specific IAM policies (using event.routeArn), but the
    // cache key only includes the Authorization header. This could allow a cached "Allow"
    // policy for one route to be reused for a different route the user shouldn't access.
    // For production optimization, consider enabling caching with per-route identity source
    // (e.g., adding '$context.routeKey' to identitySource).
    // Use a distinct authorizer name to avoid conflicts when migrating payload formats.
    this.adminAuthorizer = new apigatewayv2Authorizers.HttpLambdaAuthorizer(
      'AdminAuthorizerIam',
      this.adminAuthorizerFunction.function,
      {
        authorizerName: envResourceName(config.env, 'cognito-authorizer-iam'),
        responseTypes: [apigatewayv2Authorizers.HttpLambdaResponseType.IAM],
        identitySource: ['$request.header.Authorization'],
        resultsCacheTtl: cdk.Duration.seconds(0), // Disabled for security (MVP)
      }
    );

    // Define routes
    const routes: RouteDefinition[] = [
      // Public API - Health check
      {
        method: 'GET',
        path: '/v1/health',
        handler: this.healthFunction.function,
        description: 'Health check endpoint',
      },

      // Public API - Subscriber management (Milestone 2+)
      {
        method: 'POST',
        path: '/v1/subscribe',
        handler: this.notImplementedFunction.function,
        description: 'Subscribe to newsletter',
      },
      {
        method: 'GET',
        path: '/v1/confirm',
        handler: this.notImplementedFunction.function,
        description: 'Confirm subscription via token',
      },
      {
        method: 'POST',
        path: '/v1/unsubscribe',
        handler: this.notImplementedFunction.function,
        description: 'Unsubscribe from newsletter',
      },

      // Public API - Tracking (Milestone 2+)
      {
        method: 'GET',
        path: '/v1/track/open/{token}',
        handler: this.notImplementedFunction.function,
        description: 'Track email opens',
      },
      {
        method: 'GET',
        path: '/v1/track/click/{token}',
        handler: this.notImplementedFunction.function,
        description: 'Track link clicks',
      },

      // Admin API - Campaign management (Milestone 5+)
      // All admin routes require authentication via Cognito authorizer
      {
        method: 'POST',
        path: '/admin/campaigns',
        handler: this.notImplementedFunction.function,
        description: 'Create campaign',
        authorizer: this.adminAuthorizer,
      },
      {
        method: 'GET',
        path: '/admin/campaigns/{id}',
        handler: this.notImplementedFunction.function,
        description: 'Get campaign details',
        authorizer: this.adminAuthorizer,
      },
      {
        method: 'POST',
        path: '/admin/campaigns/{id}/send',
        handler: this.notImplementedFunction.function,
        description: 'Send campaign',
        authorizer: this.adminAuthorizer,
      },

      // Admin API - Subscriber management (Milestone 5+)
      {
        method: 'GET',
        path: '/admin/subscribers',
        handler: this.notImplementedFunction.function,
        description: 'List subscribers',
        authorizer: this.adminAuthorizer,
      },
      {
        method: 'POST',
        path: '/admin/subscribers/{id}/suppress',
        handler: this.notImplementedFunction.function,
        description: 'Suppress subscriber',
        authorizer: this.adminAuthorizer,
      },
    ];

    // Create routes
    new ApiRoutes(this, 'Routes', {
      httpApi: this.httpApi,
      routes,
    });

    /**
     * IAM Permissions Architecture
     *
     * Per least privilege principle, IAM permissions are granted ONLY to Lambda functions
     * that actually need them. Permissions are granted per-function based on actual usage.
     *
     * Current state (Milestone 3):
     * - healthFunction: No DynamoDB/Secrets/SSM access (returns static 200 OK)
     * - notImplementedFunction: No DynamoDB/Secrets/SSM access (returns static 501 Not Implemented)
     * - adminAuthorizerFunction: No DynamoDB/Secrets/SSM access (Cognito JWT authorizer)
     *
     * Future milestones:
     * When implementing real handlers, grant permissions ONLY to functions that need them:
     *
     * DynamoDB permissions:
     * - Public API functions: Read/write to Subscribers, AuditEvents, EngagementEvents
     * - Admin API functions: Read access to all tables (write access granted per-endpoint)
     * - KMS decrypt/encrypt: Required only for functions accessing CMK-encrypted tables
     *
     * Secrets Manager permissions:
     * - Functions that generate/validate tokens: Read access to tokenHmacSecret
     * - Functions that hash emails: Read access to emailHashHmacSecret
     * - Example: secrets.tokenHmacSecret.grantRead(subscribeFunction.function)
     *
     * SSM Parameter Store permissions:
     * - Functions that send emails: Read access to SES parameters
     * - Functions that generate tracking links: Read access to tracking parameters
     * - Example: parameters.sesFromEmail.grantRead(sendCampaignFunction.function)
     *
     * Example for future implementation:
     * ```typescript
     * // Subscribe handler needs Subscribers, AuditEvents, HMAC secrets, and SSM parameters
     * tables.subscribersTable.grantReadWriteData(subscribeFunction.function);
     * tables.auditEventsTable.grantWriteData(subscribeFunction.function);
     * tables.encryptionKey.grantEncryptDecrypt(subscribeFunction.function);
     * secrets.tokenHmacSecret.grantRead(subscribeFunction.function);
     * secrets.emailHashHmacSecret.grantRead(subscribeFunction.function);
     * parameters.apiBaseUrl.grantRead(subscribeFunction.function);
     * ```
     *
     * SECURITY: Never grant permissions "just in case" - only grant when code needs it.
     */

    // No permissions granted to placeholder functions
    // Permissions will be added in future milestones when handlers are implemented
    // Secrets and parameters are now available via the `secrets` and `parameters` props

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.httpApi.apiEndpoint,
      description: 'HTTP API Gateway endpoint URL',
      exportName: envResourceName(config.env, 'ApiUrl'),
    });

    new cdk.CfnOutput(this, 'CustomDomainUrl', {
      value: `https://${config.apiDomain}`,
      description: 'Custom domain URL for API',
      exportName: envResourceName(config.env, 'CustomDomainUrl'),
    });

    new cdk.CfnOutput(this, 'HealthCheckUrl', {
      value: `https://${config.apiDomain}/v1/health`,
      description: 'Health check endpoint URL',
    });

    // Add tags
    cdk.Tags.of(this).add('Environment', config.env);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Project', 'email.ponton.io');
  }
}
