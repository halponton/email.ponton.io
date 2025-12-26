import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import { EnvironmentConfig, envResourceName } from '../config/environments';
import { StandardLambdaFunction } from '../constructs/lambda-function';
import { ApiRoutes, RouteDefinition } from '../constructs/api-routes';

/**
 * Props for ApiGatewayStack
 */
export interface ApiGatewayStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  readonly certificate: acm.ICertificate;
  readonly hostedZone: route53.IHostedZone;
}

/**
 * API Gateway Stack
 *
 * Creates:
 * 1. HTTP API Gateway (v2)
 * 2. Custom domain configuration (api.email.ponton.io)
 * 3. Route53 alias record
 * 4. Lambda functions for all routes
 * 5. Route definitions for public and admin APIs
 *
 * Route structure:
 * - Public API (v1):
 *   - POST /v1/subscribe - Subscribe to newsletter
 *   - GET /v1/confirm - Confirm subscription via token
 *   - POST /v1/unsubscribe - Unsubscribe via token
 *   - GET /v1/track/open/:token - Track email opens
 *   - GET /v1/track/click/:token - Track link clicks and redirect
 *   - GET /v1/health - Health check (200 OK)
 *
 * - Admin API:
 *   - POST /admin/campaigns - Create campaign
 *   - GET /admin/campaigns/:id - Get campaign details
 *   - POST /admin/campaigns/:id/send - Send campaign
 *   - GET /admin/subscribers - List subscribers
 *   - POST /admin/subscribers/:id/suppress - Suppress subscriber
 *
 * Milestone 1: All routes except /v1/health return 501 Not Implemented
 */
export class ApiGatewayStack extends cdk.Stack {
  /** The HTTP API */
  public readonly httpApi: apigatewayv2.HttpApi;

  /** Custom domain for the API */
  public readonly customDomain: apigatewayv2.DomainName;

  /** Health check Lambda function */
  public readonly healthFunction: StandardLambdaFunction;

  /** Not implemented placeholder Lambda function */
  public readonly notImplementedFunction: StandardLambdaFunction;

  constructor(scope: Construct, id: string, props: ApiGatewayStackProps) {
    super(scope, id, props);

    const { config, certificate, hostedZone } = props;

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
      }
    );

    // Create HTTP API
    this.httpApi = new apigatewayv2.HttpApi(
      this,
      envResourceName(config.env, 'EmailApi'),
      {
        apiName: envResourceName(config.env, 'email-api'),
        description: `Email platform API (${config.env})`,
        // CORS configuration for future admin UI
        corsPreflight: {
          allowOrigins: config.env === 'dev'
            ? ['http://localhost:3000']
            : ['https://newsletter.ponton.io'],
          allowMethods: [
            apigatewayv2.CorsHttpMethod.GET,
            apigatewayv2.CorsHttpMethod.POST,
            apigatewayv2.CorsHttpMethod.PUT,
            apigatewayv2.CorsHttpMethod.DELETE,
          ],
          allowHeaders: ['Content-Type', 'Authorization'],
          maxAge: cdk.Duration.hours(1),
        },
        createDefaultStage: true,
      }
    );

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
        stage: this.httpApi.defaultStage,
      }
    );

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
      {
        method: 'POST',
        path: '/admin/campaigns',
        handler: this.notImplementedFunction.function,
        description: 'Create campaign',
      },
      {
        method: 'GET',
        path: '/admin/campaigns/{id}',
        handler: this.notImplementedFunction.function,
        description: 'Get campaign details',
      },
      {
        method: 'POST',
        path: '/admin/campaigns/{id}/send',
        handler: this.notImplementedFunction.function,
        description: 'Send campaign',
      },

      // Admin API - Subscriber management (Milestone 5+)
      {
        method: 'GET',
        path: '/admin/subscribers',
        handler: this.notImplementedFunction.function,
        description: 'List subscribers',
      },
      {
        method: 'POST',
        path: '/admin/subscribers/{id}/suppress',
        handler: this.notImplementedFunction.function,
        description: 'Suppress subscriber',
      },
    ];

    // Create routes
    new ApiRoutes(this, 'Routes', {
      httpApi: this.httpApi,
      routes,
    });

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
