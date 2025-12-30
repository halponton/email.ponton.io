import * as cdk from 'aws-cdk-lib';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../config/environments';

/**
 * Props for SESIdentityConstruct
 */
export interface SESIdentityProps {
  /** Environment configuration */
  readonly config: EnvironmentConfig;

  /** Route53 hosted zone for DNS record creation */
  readonly hostedZone: route53.IHostedZone;
}

/**
 * SES Identity Construct
 *
 * Creates SES domain identity with DKIM, SPF, and DMARC configuration.
 *
 * Components:
 * 1. SES Email Identity for email.ponton.io
 * 2. DKIM configuration using SES Easy DKIM (AWS-managed 2048-bit keys)
 * 3. DKIM CNAME records in Route53
 * 4. SPF record for sender authentication
 * 5. DMARC record for email policy
 *
 * Security Architecture:
 * - DKIM: AWS-managed Easy DKIM (2048-bit RSA keys, automatic rotation)
 * - SPF: Hard fail policy (-all) for strict sender validation
 * - DMARC: Start with p=none for monitoring, upgrade to p=quarantine/reject later
 *
 * Per PLATFORM_INVARIANTS.md:
 * - SES sandbox mode in dev (verified recipients only)
 * - Production mode in prod (can send to any recipient)
 * - Single verified domain: email.ponton.io
 *
 * DNS Records Created:
 * - 3 DKIM CNAME records (AWS Easy DKIM tokens)
 * - 1 SPF TXT record (v=spf1 include:amazonses.com -all)
 * - 1 DMARC TXT record (_dmarc.email.ponton.io)
 * - 1 MAIL FROM MX record (bounce.email.ponton.io → feedback-smtp.<region>.amazonses.com)
 * - 1 MAIL FROM SPF TXT record (bounce.email.ponton.io)
 *
 * Important Notes:
 * - DKIM records are created explicitly in Route53 using identity.dkimRecords
 * - SPF and DMARC records must be explicitly created as Route53 records
 * - DNS propagation may take 5-15 minutes
 * - SES identity verification typically completes within 72 hours (usually minutes)
 */
export class SESIdentityConstruct extends Construct {
  /** SES email identity for the domain */
  public readonly emailIdentity: ses.EmailIdentity;

  constructor(scope: Construct, id: string, props: SESIdentityProps) {
    super(scope, id);

    const { config, hostedZone } = props;

    /**
     * SES Email Identity
     *
     * Creates a verified domain identity for email.ponton.io with:
     * - DKIM signing enabled (Easy DKIM with 2048-bit keys)
     * - DKIM CNAME records created in Route53
     *
     * Easy DKIM benefits:
     * - AWS manages key generation and rotation
     * - 2048-bit RSA keys (stronger than manual 1024-bit)
     * - DNS records managed in Route53 via CDK
     * - No manual key management required
     *
     * MAIL FROM domain:
     * - Uses subdomain: bounce.email.ponton.io
     * - Handles bounce processing and SPF alignment
     * - Requires MX and SPF records for the subdomain
     */
    const mailFromDomain = `bounce.${config.ses.verifiedDomain}`;

    this.emailIdentity = new ses.EmailIdentity(this, 'EmailIdentity', {
      identity: ses.Identity.domain(config.ses.verifiedDomain),
      mailFromDomain,
      dkimSigning: config.ses.enableDkim,
    });

    // Create DKIM CNAME records using the full token name from SES to avoid duplicate zone suffixes.
    this.emailIdentity.dkimRecords.forEach((record, index) => {
      new route53.CfnRecordSet(this, `DkimRecord${index + 1}`, {
        hostedZoneId: hostedZone.hostedZoneId,
        name: record.name,
        type: 'CNAME',
        resourceRecords: [record.value],
        ttl: cdk.Duration.minutes(5).toSeconds().toString(),
        comment: 'DKIM record for SES Easy DKIM',
      });
    });

    /**
     * SPF Record
     *
     * Sender Policy Framework (SPF) prevents email spoofing by declaring
     * which mail servers are authorized to send email for this domain.
     *
     * Record: v=spf1 include:amazonses.com -all
     * - v=spf1: SPF version 1
     * - include:amazonses.com: Authorize SES to send email for this domain
     * - -all: Hard fail for unauthorized senders (strict policy)
     *
     * Security rationale for -all (hard fail):
     * - Prevents unauthorized servers from sending as email.ponton.io
     * - Reduces risk of domain spoofing
     * - Improves email deliverability (ISPs trust strict SPF)
     *
     * Alternative policies NOT used:
     * - ~all (soft fail): Too permissive, allows spoofing with warning
     * - ?all (neutral): No protection, defeats purpose of SPF
     *
     * Note: This SPF record authorizes only SES. If additional mail servers
     * are added later, they must be included in this record.
     */
    new route53.TxtRecord(this, 'SpfRecord', {
      zone: hostedZone,
      recordName: config.ses.verifiedDomain,
      values: ['v=spf1 include:amazonses.com -all'],
      ttl: cdk.Duration.minutes(5),
      comment: 'SPF record for SES email sending (hard fail policy)',
    });

    /**
     * MAIL FROM MX Record
     *
     * Required for custom MAIL FROM domains in SES.
     * Routes bounces to the Amazon SES feedback endpoint.
     */
    new route53.MxRecord(this, 'MailFromMxRecord', {
      zone: hostedZone,
      recordName: mailFromDomain,
      values: [
        {
          priority: 10,
          hostName: `feedback-smtp.${config.region}.amazonses.com`,
        },
      ],
      ttl: cdk.Duration.minutes(5),
      comment: 'MAIL FROM MX record for SES bounce handling',
    });

    /**
     * MAIL FROM SPF Record
     *
     * Required for custom MAIL FROM domains in SES.
     * Authorizes SES to send from the MAIL FROM subdomain.
     */
    new route53.TxtRecord(this, 'MailFromSpfRecord', {
      zone: hostedZone,
      recordName: mailFromDomain,
      values: ['v=spf1 include:amazonses.com -all'],
      ttl: cdk.Duration.minutes(5),
      comment: 'MAIL FROM SPF record for SES',
    });

    /**
     * DMARC Record
     *
     * Domain-based Message Authentication, Reporting & Conformance (DMARC)
     * provides policy for handling emails that fail SPF/DKIM checks.
     *
     * Record: v=DMARC1; p=none; rua=mailto:dmarc-reports@email.ponton.io
     * - v=DMARC1: DMARC version 1
     * - p=none: Start with monitoring mode (no enforcement)
     * - rua=mailto:...: Aggregate reports sent to this address
     *
     * Policy evolution strategy:
     * 1. Start with p=none (monitoring): Collect reports, identify legitimate sources
     * 2. After 30 days, upgrade to p=quarantine: Quarantine suspicious emails
     * 3. After 60 days, upgrade to p=reject: Reject unauthorized emails
     *
     * Security rationale for starting with p=none:
     * - Prevents blocking legitimate email during initial setup
     * - Allows time to identify and fix SPF/DKIM misconfigurations
     * - Aggregate reports provide visibility into email authentication
     *
     * Production readiness checklist:
     * - [ ] Monitor DMARC reports for 30 days
     * - [ ] Verify all legitimate sources pass SPF/DKIM
     * - [ ] Update to p=quarantine for 30 days
     * - [ ] Monitor for false positives
     * - [ ] Update to p=reject for maximum protection
     *
     * Note: The rua email address (dmarc-reports@email.ponton.io) must be
     * created as a verified SES identity or forwarded to an external monitoring
     * service. This is handled separately from infrastructure setup.
     */
    new route53.TxtRecord(this, 'DmarcRecord', {
      zone: hostedZone,
      recordName: `_dmarc.${config.ses.verifiedDomain}`,
      values: [
        `v=DMARC1; p=none; rua=mailto:dmarc-reports@${config.ses.verifiedDomain}`,
      ],
      ttl: cdk.Duration.minutes(5),
      comment: 'DMARC record for email authentication (monitoring mode)',
    });

    // Add tags
    cdk.Tags.of(this).add('Environment', config.env);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Project', 'email.ponton.io');
  }
}
