import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

/**
 * Route definition for API Gateway
 */
export interface RouteDefinition {
  /** HTTP method */
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

  /** Route path (e.g., /v1/health) */
  readonly path: string;

  /** Lambda function to handle this route */
  readonly handler: lambda.IFunction;

  /** Optional route description */
  readonly description?: string;
}

/**
 * Props for ApiRoutes construct
 */
export interface ApiRoutesProps {
  /** The HTTP API to attach routes to */
  readonly httpApi: apigatewayv2.HttpApi;

  /** Route definitions to create */
  readonly routes: RouteDefinition[];
}

/**
 * API Gateway routes construct
 *
 * Creates HTTP API routes with Lambda integrations.
 *
 * Route structure per architecture plan:
 * - Public routes: /v1/* (subscribe, confirm, unsubscribe, tracking)
 * - Admin routes: /admin/* (campaigns, subscribers, analytics)
 *
 * All routes in Milestone 1 return 501 Not Implemented except /v1/health
 */
export class ApiRoutes extends Construct {
  /** Created routes */
  public readonly routes: apigatewayv2.HttpRoute[];

  constructor(scope: Construct, id: string, props: ApiRoutesProps) {
    super(scope, id);

    const { httpApi, routes: routeDefinitions } = props;

    this.routes = routeDefinitions.map((routeDef, index) => {
      // Create Lambda integration
      const integration = new apigatewayv2Integrations.HttpLambdaIntegration(
        `${id}Integration${index}`,
        routeDef.handler,
        {
          // API Gateway payload format version 2.0
          payloadFormatVersion: apigatewayv2.PayloadFormatVersion.VERSION_2_0,
        }
      );

      // Create route
      const route = new apigatewayv2.HttpRoute(this, `Route${index}`, {
        httpApi,
        routeKey: apigatewayv2.HttpRouteKey.with(
          routeDef.path,
          apigatewayv2.HttpMethod[routeDef.method]
        ),
        integration,
      });

      return route;
    });
  }
}
