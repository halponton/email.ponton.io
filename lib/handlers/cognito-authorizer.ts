import {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewayAuthorizerResult,
} from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

/**
 * Lambda authorizer for admin routes with Cognito JWT validation
 *
 * Validates JWT tokens from Cognito User Pool and enforces group membership.
 *
 * Security requirements:
 * - Validates JWT signature using Cognito public keys
 * - Verifies token expiration and issuer
 * - Enforces group membership (must be in "Administrators" group)
 * - Structured logging for security events
 * - Returns authorization context with user information
 *
 * Per security architecture:
 * - Uses aws-jwt-verify library for JWT validation
 * - Validates group membership server-side (not just client-side)
 * - Logs all authorization attempts for audit trail
 *
 * Environment variables required:
 * - USER_POOL_ID: Cognito User Pool ID
 * - CLIENT_ID: Cognito User Pool Client ID
 * - AWS_REGION: AWS region (automatically provided by Lambda)
 *
 * Routes protected by this authorizer:
 * - POST /admin/campaigns
 * - GET /admin/campaigns/{id}
 * - POST /admin/campaigns/{id}/send
 * - GET /admin/subscribers
 * - POST /admin/subscribers/{id}/suppress
 */

// Environment variables
const USER_POOL_ID = process.env.USER_POOL_ID;
const CLIENT_ID = process.env.CLIENT_ID;
const AWS_REGION = process.env.AWS_REGION || 'eu-west-2';

// Required group for admin access
const REQUIRED_GROUP = 'Administrators';

// H-3: Token size limits to prevent DoS attacks
// JWT tokens are typically < 4KB, but we allow up to 8KB for safety
const MAX_TOKEN_LENGTH = 8192;
// Authorization header includes "Bearer " prefix plus token
const MAX_HEADER_LENGTH = 10000;

// Validate environment variables on cold start
if (!USER_POOL_ID || !CLIENT_ID) {
  throw new Error(
    'Missing required environment variables: USER_POOL_ID and CLIENT_ID must be set'
  );
}

// Create JWT verifier (reused across invocations)
const verifier = CognitoJwtVerifier.create({
  userPoolId: USER_POOL_ID,
  tokenUse: 'access',
  clientId: CLIENT_ID,
});

/**
 * Structured log for security events
 */
interface SecurityLogEvent {
  event: 'AUTHORIZATION_ATTEMPT' | 'AUTHORIZATION_SUCCESS' | 'AUTHORIZATION_FAILURE';
  path: string;
  method: string;
  sourceIp: string;
  userAgent: string;
  username?: string;
  groups?: string[];
  reason?: string;
  timestamp: string;
}

/**
 * Log structured security event
 */
function logSecurityEvent(event: SecurityLogEvent): void {
  console.log(JSON.stringify(event));
}

/**
 * Extract token from Authorization header
 * H-3: Includes validation of token size and format to prevent DoS attacks
 */
function extractToken(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  // Validate header size before processing
  if (authHeader.length > MAX_HEADER_LENGTH) {
    console.warn('Authorization header exceeds maximum length', {
      length: authHeader.length,
      maxLength: MAX_HEADER_LENGTH,
    });
    return null;
  }

  // Expected format: "Bearer <token>" (case-insensitive, allow extra whitespace)
  const match = authHeader.trim().match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }

  const token = match[1].trim();

  // Validate token size
  if (token.length > MAX_TOKEN_LENGTH) {
    console.warn('Token exceeds maximum length', {
      length: token.length,
      maxLength: MAX_TOKEN_LENGTH,
    });
    return null;
  }

  // Validate JWT format (three base64url parts separated by dots)
  // Base64url character set: A-Z, a-z, 0-9, hyphen, underscore
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    console.warn('Token does not match JWT format');
    return null;
  }

  return token;
}

/**
 * Generate IAM policy for API Gateway
 */
function generatePolicy(
  principalId: string,
  effect: 'Allow' | 'Deny',
  resource: string,
  context?: Record<string, string | number | boolean>
): APIGatewayAuthorizerResult {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: effect,
          Resource: resource,
        },
      ],
    },
    context: context || {},
  };
}

/**
 * Lambda handler for Cognito authorization
 */
export const handler = async (
  event: APIGatewayRequestAuthorizerEventV2
): Promise<APIGatewayAuthorizerResult> => {
  const path = event.requestContext.http.path;
  const method = event.requestContext.http.method;
  const sourceIp = event.requestContext.http.sourceIp;
  const userAgent = event.requestContext.http.userAgent || 'unknown';
  const timestamp = new Date().toISOString();

  // Log authorization attempt
  logSecurityEvent({
    event: 'AUTHORIZATION_ATTEMPT',
    path,
    method,
    sourceIp,
    userAgent,
    timestamp,
  });

  try {
    // Extract Authorization header
    const authHeader = event.headers?.authorization || event.headers?.Authorization;
    const token = extractToken(authHeader);

    if (!token) {
      logSecurityEvent({
        event: 'AUTHORIZATION_FAILURE',
        path,
        method,
        sourceIp,
        userAgent,
        reason: 'Missing or invalid Authorization header',
        timestamp,
      });

      return generatePolicy('user', 'Deny', event.routeArn);
    }

    // Verify JWT token
    let payload;
    try {
      payload = await verifier.verify(token);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logSecurityEvent({
        event: 'AUTHORIZATION_FAILURE',
        path,
        method,
        sourceIp,
        userAgent,
        reason: `JWT verification failed: ${errorMessage}`,
        timestamp,
      });

      return generatePolicy('user', 'Deny', event.routeArn);
    }

    // Extract username and groups from token
    const username = payload.username || payload.sub;
    const groups = (payload['cognito:groups'] as string[]) || [];

    // Check group membership
    if (!groups.includes(REQUIRED_GROUP)) {
      logSecurityEvent({
        event: 'AUTHORIZATION_FAILURE',
        path,
        method,
        sourceIp,
        userAgent,
        username,
        groups,
        reason: `User not in required group: ${REQUIRED_GROUP}`,
        timestamp,
      });

      return generatePolicy(username, 'Deny', event.routeArn);
    }

    // Authorization successful
    logSecurityEvent({
      event: 'AUTHORIZATION_SUCCESS',
      path,
      method,
      sourceIp,
      userAgent,
      username,
      groups,
      timestamp,
    });

    // Return Allow policy with user context
    return generatePolicy(username, 'Allow', event.routeArn, {
      username,
      groups: groups.join(','),
      userId: payload.sub,
    });
  } catch (error) {
    // Unexpected error - deny access and log
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Unexpected error in authorizer:', {
      error: errorMessage,
      path,
      method,
      sourceIp,
      timestamp,
    });

    logSecurityEvent({
      event: 'AUTHORIZATION_FAILURE',
      path,
      method,
      sourceIp,
      userAgent,
      reason: `Unexpected error: ${errorMessage}`,
      timestamp,
    });

    return generatePolicy('user', 'Deny', event.routeArn);
  }
};
