import {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerResult,
} from 'aws-lambda';

/**
 * Placeholder Lambda authorizer for admin routes
 *
 * This is a TEMPORARY security measure that blocks all requests (401 Unauthorized)
 * until Cognito-based admin authentication is implemented in Milestone 5.
 *
 * TODO (Milestone 5): Replace this with proper Cognito JWT validation
 * - Validate JWT tokens from Cognito User Pool
 * - Check admin role/group membership
 * - Return isAuthorized true for approved requests
 *
 * SECURITY NOTE: All /admin/* routes are currently inaccessible.
 * This is intentional - no admin access until proper authentication exists.
 *
 * Routes protected by this authorizer:
 * - POST /admin/campaigns
 * - GET /admin/campaigns/{id}
 * - POST /admin/campaigns/{id}/send
 * - GET /admin/subscribers
 * - POST /admin/subscribers/{id}/suppress
 */
export const handler = async (
  event: APIGatewayRequestAuthorizerEventV2
): Promise<APIGatewaySimpleAuthorizerResult> => {
  // Log the authorization attempt for security monitoring
  console.log('Admin authorization attempt blocked - Cognito not yet configured', {
    path: event.requestContext.http.path,
    method: event.requestContext.http.method,
    sourceIp: event.requestContext.http.sourceIp,
    userAgent: event.requestContext.http.userAgent,
  });

  return {
    isAuthorized: false,
  };
};
