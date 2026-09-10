# Human escalation tickets, rationale

## Context

The chat core already exposes an `escalate_to_human` tool and the application now has durable tickets, an embedded merchant queue, a notification outbox, SQS retries, and customer email reply handling. Ticket email currently depends on Amazon SES for outbound delivery, delivery events, and inbound receiving.

Amazon did not approve the requested SES production access. Ticket email therefore needs another provider without changing the working ticket model or merchant experience. The expected volume is only 100 to 300 messages each month, so a managed transactional provider with a useful free allowance is a better operational fit than continuing an uncertain approval process.

The replacement must preserve the controls already built around the provider. A ticket change and its notification intent remain atomic. Sends remain retryable and idempotent. Delivery events remain visible. Inbound replies still require an opaque ticket token, the expected sender, spam controls, and duplicate protection.

> ⚠️ Premise note: Replacing only the outbound send call would leave ticket replies and delivery states tied to SES. The provider boundary includes sending, delivery webhooks, inbound parsing, credentials, DNS, and rollback.

## Options considered

### Option 1: Fix SES production access

Keep the current implementation and continue the AWS review process.

**Pros**:

1. No code migration.
2. Lowest direct message cost.

**Cons**:

1. Approval timing and outcome are outside the project team's control.
2. Ticket email cannot be used in production until access is granted.

### Option 2: Replace SES directly with Brevo

Move outbound delivery, delivery events, and inbound parsing to Brevo in one release.

**Pros**:

1. One provider owns the complete ticket email path.
2. The free allowance is far above the expected volume.

**Cons**:

1. A direct cutover combines code, webhook, credential, and DNS risk.
2. Rollback becomes difficult after the receiving MX records change.

### Option 3: Replace SES with Brevo through a short strangler migration

Add Brevo beside SES, prove sending and webhooks, switch receiving DNS, then remove SES after an observation window.

**Pros**:

1. Each part of the email path can be verified before SES is removed.
2. Existing tickets and queued notifications keep their current data shape.
3. Rollback remains available during the risky part of the cutover.

**Cons**:

1. Two provider paths exist briefly.
2. The infrastructure remains more complex until cleanup is complete.

### Option 4: Use Brevo only for outbound email

Send notifications through Brevo but require customer replies through the widget.

**Pros**:

1. Smallest provider change.
2. No inbound DNS migration.

**Cons**:

1. Customers who reply to ticket email would not reach the ticket timeline.
2. It breaks the continuous support conversation required by the ticket feature.

## Rationale

Option 3 is the best fit. Brevo removes the SES production access blocker and its free daily allowance is comfortably above the current monthly volume. The short strangler migration preserves a working rollback path while DNS and webhook behavior are proven.

The existing outbox and queue remain provider neutral. Brevo is added only at the communication boundary. The worker uses the transactional REST API because Node already provides `fetch`, which avoids a provider SDK dependency. Brevo custom webhook headers provide a shared secret for webhook authentication. An opaque signed job reference in `X-Mailin-custom` correlates delivery events without exposing ticket content or customer data.

Brevo inbound parsing returns structured content, so the application no longer needs SES receipt rules, raw MIME storage in S3, or `mailparser`. Inbound messages with attachments are rejected because ticket attachments are outside the current scope and Brevo does not provide the same virus verdict contract as SES.

## Cost analysis for 100 to 300 emails each month

Brevo's free plan allows up to 300 sends each day. This workload fits without a monthly email fee. Free plan messages may include Brevo branding, so the account can move to a paid plan later if removing that branding matters.

AWS Lambda, DynamoDB, SQS, Secrets Manager, and CloudWatch remain in use. Their incremental cost at this volume should stay small. The main operational cost is maintaining webhook security, delivery mappings, DNS, and suppression behavior.

## Brevo setup and operational requirements

1. Create a Brevo API key and store it in the existing AWS Secrets Manager boundary.
2. Verify `nailzify.com` as a sending domain and publish the Brevo DKIM, SPF, and DMARC records.
3. Configure `support@nailzify.com` as the sender.
4. Create a transactional webhook for sent, delivered, deferred, soft bounce, hard bounce, blocked, invalid address, spam, and unsubscribe events.
5. Add the generated shared credential as a custom header on each Brevo webhook.
6. Confirm inbound parsing is enabled for the Brevo account.
7. Verify `tickets.nailzify.com`, then publish MX priority 10 for `inbound1.sendinblue.com` and priority 20 for `inbound2.sendinblue.com`. Keep `reply.nailzify.com` reserved for Brevo's sending return path.
8. Create the inbound webhook for `tickets.nailzify.com`.
9. Keep the SES path available until outbound, delivery, and inbound tests pass in production.
10. Monitor hard bounces, complaints, invalid addresses, webhook failures, and the notification dead letter queue.

## References

**Project sources**:

1. `services/notifications/src/worker.ts`, current SES outbound adapter and SQS worker.
2. `services/notifications/src/delivery-events.ts`, current delivery status mapping.
3. `services/notifications/src/inbound.ts`, current secure reply processing.
4. `infra/lib/api-stack.ts`, current SES resources, Lambda functions, and permissions.
5. `packages/adapters/src/aws/secrets.ts`, existing cached Secrets Manager provider.

**Practices and standards**:

1. Transactional outbox for reliable side effects.
2. At least once delivery with application idempotency.
3. Strangler migration for a live provider replacement.
4. Shared secret authentication for provider webhooks.
5. DKIM, SPF, and DMARC email authentication.
6. Personal data minimization and bounded retention.

**Links**:

1. Brevo transactional email API: https://developers.brevo.com/docs/send-a-transactional-email
2. Brevo transactional webhooks: https://developers.brevo.com/docs/transactional-webhooks
3. Brevo webhook setup and security: https://developers.brevo.com/docs/how-to-use-webhooks
4. Brevo inbound parse webhooks: https://developers.brevo.com/docs/inbound-parse-webhooks
5. Brevo plan limits: https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan
6. Brevo automatic hard bounce blocklisting: https://help.brevo.com/hc/en-us/articles/209435165-What-are-soft-bounces-and-hard-bounces-in-email
