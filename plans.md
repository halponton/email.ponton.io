# plans.md — email.ponton.io

## Goal
Wire email behaviour to AWS safely.

## Milestones
- Domains and API Gateway
- DynamoDB tables and GSIs
- Secrets Manager and SSM
- SES configuration
- Cognito for admin APIs
- Observability and retention jobs

Retention jobs must:
- Purge raw engagement events after 6 months
- Enforce CloudWatch log retention

Retention jobs must not:
- Modify subscriber records
- Modify campaign metadata
- Modify delivery records
- Modify audit events

## Definition of done
- All resources environment-scoped
- SES events ingested
- README.md fully updated
