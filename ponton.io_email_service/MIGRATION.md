# Migration Guide: Security Fixes (v2.0.0)

This document provides detailed guidance for migrating the infrastructure layer (`email.ponton.io` repository) to consume the security-hardened version of this domain logic library.

## Overview of Changes

This release implements critical security fixes identified during security review:

1. **Open Redirect Prevention** - Click tracking now validates destination URLs
2. **SES Event Trust Boundary** - Clarifies that signature verification MUST happen in infrastructure
3. **Timing-Safe Token Comparison** - Prevents timing attacks on token verification
4. **IDN/Punycode Email Normalization** - Prevents homograph attacks

**Breaking Changes:** #1 requires infrastructure code updates
**Documentation Only:** #2 requires infrastructure implementation validation
**Non-Breaking:** #3 and #4 are transparent to callers

---

## 1. Click Tracking URL Validation (BREAKING CHANGE)

### What Changed

The `trackClick` function now requires a `urlValidationConfig` parameter to prevent open redirect vulnerabilities.

### Why This Matters

**Security Risk:** Without URL validation, attackers can craft phishing emails that redirect users through your trusted domain to malicious sites:
```
https://your-domain.com/track/click?url=https://evil-phishing-site.com
```

Users see your trusted domain and click, then are redirected to the attacker's site.

### Migration Steps

#### Step 1: Update Click Tracking Handler

**File:** `email.ponton.io/src/handlers/trackClick.ts` (or similar)

**Before:**
```typescript
import { trackClick } from 'ponton.io_email_service';

export async function handler(event: APIGatewayProxyEvent) {
  const { campaignId, deliveryId, destinationUrl } = event.queryStringParameters;

  const result = trackClick({
    campaignId,
    deliveryId,
    destinationUrl,
    requestId: event.requestContext.requestId
  });

  // ... handle result
}
```

**After:**
```typescript
import { trackClick } from 'ponton.io_email_service';

export async function handler(event: APIGatewayProxyEvent) {
  const { campaignId, deliveryId, destinationUrl } = event.queryStringParameters;

  // Load campaign to get allowed domains
  const campaign = await getCampaign(campaignId);

  const result = trackClick({
    campaignId,
    deliveryId,
    destinationUrl,
    urlValidationConfig: {
      allowedProtocols: new Set(['https:']), // Only HTTPS in production
      allowedDomains: new Set(campaign.allowedDomains), // From campaign config
      allowSubdomains: true // Allow www.example.com if example.com is allowed
    },
    requestId: event.requestContext.requestId
  });

  if (!result.ok) {
    // New: Handle URL validation failures
    const errorLog = result.logEntries[0];
    console.error('Click tracking validation failed', {
      errorCode: errorLog?.errorCode, // INVALID_PROTOCOL, INVALID_DOMAIN, MALFORMED_URL
      campaignId,
      deliveryId
    });

    return {
      statusCode: 400,
      headers: result.response.headers,
      body: 'Invalid tracking link'
    };
  }

  // ... handle successful result
}
```

#### Step 2: Add Allowed Domains to Campaign Model

**File:** `email.ponton.io/src/models/campaign.ts` (or similar)

```typescript
export interface Campaign {
  id: string;
  name: string;
  // ... existing fields

  // NEW: Allowed destination domains for click tracking
  allowedDomains: string[];  // e.g., ['example.com', 'partner.com']
}
```

**Database Migration:**
```sql
-- Add allowedDomains column to campaigns table
ALTER TABLE campaigns ADD COLUMN allowed_domains TEXT[] DEFAULT '{}';

-- Backfill existing campaigns with their primary domain
UPDATE campaigns
SET allowed_domains = ARRAY[domain]
WHERE domain IS NOT NULL;
```

#### Step 3: Update Campaign Creation UI/API

When creating or editing campaigns, allow admins to specify allowed redirect domains:

```typescript
// In campaign creation handler
export async function createCampaign(input: CreateCampaignInput) {
  const campaign = {
    ...input,
    allowedDomains: input.allowedDomains || [input.primaryDomain]
  };

  // Validate domains
  for (const domain of campaign.allowedDomains) {
    if (!isValidDomain(domain)) {
      throw new Error(`Invalid domain: ${domain}`);
    }
  }

  await saveCampaign(campaign);
}
```

#### Step 4: Handle Validation Errors

The domain layer now returns specific error codes. Update observability:

```typescript
// In your logging/metrics system
if (!result.ok && result.reason === 'invalid_url') {
  const errorCode = result.logEntries[0]?.errorCode;

  switch (errorCode) {
    case 'INVALID_PROTOCOL':
      // Alert: Possible attack attempt (non-HTTPS)
      await sendSecurityAlert('Tracking link with invalid protocol', { campaignId, destinationUrl });
      break;
    case 'INVALID_DOMAIN':
      // Alert: Misconfigured campaign or attack
      await sendAlert('Tracking link to disallowed domain', { campaignId, destinationUrl });
      break;
    case 'MALFORMED_URL':
      // Warning: Possible bug in link generation
      await logWarning('Malformed tracking URL', { campaignId, destinationUrl });
      break;
  }
}
```

#### Step 5: Testing

**Test Cases to Add:**

```typescript
describe('trackClick with URL validation', () => {
  it('allows valid HTTPS URLs on allowed domains', async () => {
    const result = await handler({
      queryStringParameters: {
        campaignId: 'valid-campaign',
        deliveryId: 'valid-delivery',
        destinationUrl: 'https://example.com/product'
      }
    });
    expect(result.statusCode).toBe(302);
  });

  it('rejects HTTP URLs in production', async () => {
    const result = await handler({
      queryStringParameters: {
        destinationUrl: 'http://example.com/product' // Not HTTPS
      }
    });
    expect(result.statusCode).toBe(400);
  });

  it('rejects URLs to disallowed domains', async () => {
    const result = await handler({
      queryStringParameters: {
        destinationUrl: 'https://evil-site.com/phishing'
      }
    });
    expect(result.statusCode).toBe(400);
  });

  it('rejects dangerous URL schemes', async () => {
    const urls = [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd'
    ];

    for (const url of urls) {
      const result = await handler({
        queryStringParameters: { destinationUrl: url }
      });
      expect(result.statusCode).toBe(400);
    }
  });
});
```

#### Step 6: Rollout Strategy

1. **Deploy domain library update** (this repository) to staging
2. **Update infrastructure handlers** in `email.ponton.io` with URL validation config
3. **Backfill campaign.allowedDomains** from existing campaign data
4. **Test in staging** with various URL patterns
5. **Deploy to production** with monitoring for validation failures
6. **Monitor alerts** for INVALID_DOMAIN errors (may indicate misconfigured campaigns)

---

## 2. SES Event Signature Verification (DOCUMENTATION CLARIFICATION)

### What Changed

**No code changes in this repository.** The documentation now explicitly states that SES event signature verification MUST happen in the infrastructure layer.

### Why This Matters

**Security Risk:** Without signature verification, attackers can forge SES events:
- Fake DELIVERY events → manipulate metrics
- Fake BOUNCE events → suppress legitimate subscribers (DoS)
- Fake COMPLAINT events → mass-suppress your subscriber base

### Validation Required

Verify that your infrastructure layer already implements SNS signature verification. If not, this is a **CRITICAL security gap** that must be fixed.

#### Step 1: Verify SNS Signature Validation Exists

**File:** `email.ponton.io/src/handlers/sesEventHandler.ts` (or similar)

Check if you're already validating SNS signatures:

```typescript
// GOOD: Signature verification present
import { SNS } from '@aws-sdk/client-sns';
import { validateSnsSignature } from './utils/sns-validation';

export async function handler(event: SNSEvent) {
  // Verify SNS signature
  const isValid = await validateSnsSignature(event.Records[0].Sns);
  if (!isValid) {
    console.error('Invalid SNS signature', { messageId: event.Records[0].Sns.MessageId });
    return { statusCode: 401, body: 'Unauthorized' };
  }

  // Safe to process event
  const sesEvent = JSON.parse(event.Records[0].Sns.Message);
  // ...
}
```

```typescript
// BAD: No signature verification
export async function handler(event: SNSEvent) {
  const sesEvent = JSON.parse(event.Records[0].Sns.Message); // DANGER: Unverified!
  // ...
}
```

#### Step 2: Implement Signature Validation (If Missing)

If signature validation is **not** implemented, add it immediately:

**File:** `email.ponton.io/src/utils/sns-validation.ts`

```typescript
import crypto from 'crypto';
import https from 'https';

export interface SnsMessage {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
}

export async function validateSnsSignature(message: SnsMessage): Promise<boolean> {
  try {
    // 1. Verify SigningCertURL is from AWS
    const certUrl = new URL(message.SigningCertURL);
    if (!certUrl.hostname.endsWith('.amazonaws.com')) {
      console.error('Invalid signing certificate URL', { url: message.SigningCertURL });
      return false;
    }

    // 2. Download certificate
    const certificate = await downloadCertificate(message.SigningCertURL);

    // 3. Build canonical signing string
    const stringToSign = buildSigningString(message);

    // 4. Verify signature
    const verifier = crypto.createVerify('RSA-SHA1');
    verifier.update(stringToSign, 'utf8');
    const isValid = verifier.verify(certificate, message.Signature, 'base64');

    if (!isValid) {
      console.error('SNS signature verification failed', {
        messageId: message.MessageId,
        topicArn: message.TopicArn
      });
    }

    return isValid;
  } catch (error) {
    console.error('SNS signature validation error', { error });
    return false;
  }
}

function buildSigningString(message: SnsMessage): string {
  const fields = message.Type === 'Notification'
    ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];

  return fields
    .filter(field => message[field] !== undefined)
    .map(field => `${field}\n${message[field]}\n`)
    .join('');
}

async function downloadCertificate(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
  });
}
```

**Alternative:** Use AWS-provided SNS subscription confirmation instead of manual verification:
- SNS HTTPS subscriptions automatically verify signatures
- Use SNS VPC endpoints to prevent internet exposure
- This is the recommended approach for production

#### Step 3: Add Monitoring

Monitor for invalid signatures (potential attacks):

```typescript
if (!isValid) {
  await sendSecurityAlert('Invalid SNS signature detected', {
    messageId: message.MessageId,
    topicArn: message.TopicArn,
    sourceIp: event.requestContext?.identity?.sourceIp
  });
}
```

---

## 3. Timing-Safe Token Comparison (NON-BREAKING)

### What Changed

Token verification now uses `crypto.timingSafeEqual` for constant-time comparison.

### Why This Matters

Prevents timing attacks where an attacker measures response times to gradually determine the correct token hash.

### Migration Steps

**No changes required.** This is an internal implementation detail. Verify that:
1. All existing tests still pass ✓
2. Token verification behavior is unchanged ✓
3. No performance regression ✓

---

## 4. IDN/Punycode Email Normalization (NON-BREAKING)

### What Changed

Email normalization now converts internationalized domain names (IDN) to punycode.

### Why This Matters

Prevents homograph attacks where attackers use lookalike characters:
- `test@аpple.com` (Cyrillic 'а') vs `test@apple.com` (Latin 'a')
- Both now normalize to the same punycode representation

### Migration Steps

**No changes required.** This is transparent to callers. Verify that:
1. Email lookups still work correctly ✓
2. Subscriber deduplication works ✓
3. No existing subscribers duplicated ✓

---

## Validation Checklist

Before deploying to production, verify:

### Click Tracking URL Validation
- [ ] `trackClick` calls include `urlValidationConfig` parameter
- [ ] Campaign model includes `allowedDomains` field
- [ ] Database migration adds `allowed_domains` column
- [ ] Existing campaigns backfilled with default allowed domains
- [ ] Tests added for URL validation edge cases
- [ ] Monitoring alerts configured for INVALID_DOMAIN errors
- [ ] Security team notified about open redirect prevention

### SES Event Signature Verification
- [ ] SNS signature validation implemented in infrastructure layer
- [ ] OR SNS subscription uses HTTPS with automatic verification
- [ ] OR SNS VPC endpoint used to prevent internet exposure
- [ ] Tests verify that invalid signatures are rejected
- [ ] Monitoring alerts configured for signature validation failures
- [ ] Security logs capture attempted signature bypasses

### Timing-Safe Token Comparison
- [ ] All existing token verification tests pass
- [ ] No behavioral changes observed
- [ ] Performance is acceptable (should be negligible)

### IDN/Punycode Email Normalization
- [ ] Email normalization tests pass
- [ ] Existing subscriber lookups still work
- [ ] No duplicate subscribers created
- [ ] Homograph attack tests added

---

## Rollback Plan

If issues arise during deployment:

### Rollback Click Tracking Changes

1. **Revert infrastructure handlers** to previous version (without `urlValidationConfig`)
2. **Downgrade domain library** to previous version (v1.x.x)
3. **Investigate** validation failures in logs
4. **Fix configuration** (e.g., missing allowed domains)
5. **Re-deploy** with corrected configuration

### Rollback SES Event Changes

No rollback needed - this is documentation only.

### Rollback Token/Email Changes

These are backward-compatible. No rollback should be necessary.

---

## Support and Questions

For questions about this migration:

1. **Review** the security architecture analysis in the security-architect agent output
2. **Review** PLATFORM_INVARIANTS.md section 16 (Trust Boundaries)
3. **Review** README.md Security section
4. **Contact** the security team for threat model questions
5. **Create issue** in this repository for implementation questions

---

## Timeline Estimate

- **Click tracking URL validation:** 1-2 days (code + testing + deployment)
- **SES signature verification validation:** 30 minutes (if already implemented), 4 hours (if needs implementation)
- **Testing in staging:** 1 day
- **Production deployment:** 1 day
- **Monitoring period:** 1 week

**Total:** ~1 week for full migration

---

## Version Compatibility

| Domain Library Version | Infrastructure Changes Required |
|------------------------|--------------------------------|
| v1.x.x | None (pre-security fixes) |
| v2.0.0 | **Breaking:** Click tracking URL validation required |
| v2.0.0+ | Future versions maintain backward compatibility |

---

## Security Contact

For security concerns or questions about threat models:
- Review the security-tester agent output
- Review the security-architect agent output
- Contact your security team before making security-related changes
