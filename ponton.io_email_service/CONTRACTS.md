# Contracts Snapshot

## Subscriber States
PENDING
SUBSCRIBED
BOUNCED
UNSUBSCRIBED (terminal)
SUPPRESSED (terminal)

## Terminal Transitions
- UNSUBSCRIBED: user intent
- SUPPRESSED: complaint / admin / sustained bounce

## Hashing Rules
- Plaintext email retained only in PENDING, SUBSCRIBED, BOUNCED
- Plaintext removed and hashed on UNSUBSCRIBED or SUPPRESSED

## Retry Rules
- Hard bounce → BOUNCED
- 3 attempts per campaign
- 2 failed campaigns (6 bounces) → SUPPRESSED

## Audit Events (allow-list)
SUBSCRIBE_REQUESTED
SUBSCRIBE_CONFIRMED
UNSUBSCRIBED
SUBSCRIBER_BOUNCED
BOUNCE_RECOVERED
SUPPRESSED_BOUNCE
SUPPRESSED_COMPLAINT
EMAIL_HASHED
EMAIL_CLICKED
EMAIL_OPENED
EMAIL_DELIVERED