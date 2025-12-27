import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

/**
 * Health check endpoint handler
 *
 * Returns 200 OK with basic system information.
 * This endpoint is publicly accessible and requires no authentication.
 *
 * Path: GET /v1/health
 */
export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  const timestamp = new Date().toISOString();
  const environment = process.env.ENVIRONMENT || 'unknown';

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
    body: JSON.stringify({
      status: 'healthy',
      timestamp,
      environment,
      service: 'email.ponton.io',
      version: '0.1.0',
    }),
  };
};
