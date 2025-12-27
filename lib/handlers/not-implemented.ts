import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

/**
 * Placeholder handler for routes not yet implemented
 *
 * Returns 501 Not Implemented for all requests.
 * This is a temporary handler used during Milestone 1 infrastructure setup.
 *
 * Routes using this handler:
 * - POST /v1/subscribe
 * - GET /v1/confirm
 * - POST /v1/unsubscribe
 * - GET /v1/track/open/{token}
 * - GET /v1/track/click/{token}
 * - POST /admin/campaigns
 * - GET /admin/campaigns/{id}
 * - POST /admin/campaigns/{id}/send
 * - GET /admin/subscribers
 * - POST /admin/subscribers/{id}/suppress
 */
export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;

  return {
    statusCode: 501,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      error: 'Not Implemented',
      message: `Endpoint ${method} ${path} is not yet implemented. This is a placeholder during infrastructure setup.`,
      timestamp: new Date().toISOString(),
    }),
  };
};
