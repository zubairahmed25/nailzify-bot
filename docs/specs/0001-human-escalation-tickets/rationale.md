# Human escalation tickets, rationale

## Context

The chat core exposes an `escalate_to_human` tool and the application has durable tickets, an embedded merchant queue, a notification outbox, SQS retries, delivery tracking, and customer email reply handling. Ticket email was moved from Amazon SES to Brevo, but the Brevo account was suspended during live testing. The ticket service therefore needs another provider without changing the working ticket model or merchant experience.

The replacement must preserve the controls already built around the provider. A ticket change and its notification intent remain atomic. Sends remain retryable and idempotent. Delivery events remain visible. Inbound replies still require an opaque ticket token, the expected sender, sender authentication checks, no attachments, and duplicate protection.

> ⚠️ Premise note: Replacing only the outbound send call would leave ticket replies and delivery states tied to Brevo. The provider boundary includes sending, delivery webhooks, inbound retrieval, credentials, DNS, and rollback.

## Options considered

### Option 1: Appeal the Brevo suspension and keep the current integration

Keep the current implementation and wait for Brevo to restore the account.

**Pros**:

1. No code migration.
2. Existing webhook and DNS configuration remains usable if the appeal succeeds.

**Cons**:

1. The timing and outcome are outside the project team's control.
2. Production ticket email remains unavailable while the account is suspended.

### Option 2: Replace Brevo directly with Resend

Move outbound delivery, delivery events, and inbound parsing to Resend in one release.

**Pros**:

1. One provider owns the complete ticket email path.
2. The integration surface is small and the existing provider neutral queue remains unchanged.

**Cons**:

1. A direct cutover combines code, webhook, credential, and DNS risk.
2. An incomplete domain setup can leave customer replies undeliverable.

### Option 3: Replace Brevo with Resend through a short staged migration

Deploy Resend support, prove outbound sending and signed webhooks, configure receiving, then remove Brevo after an observation window.

**Pros**:

1. Each part of the email path can be verified before obsolete resources are removed.
2. Existing tickets and queued notifications keep their current data shape.
3. The worker can be paused without losing tickets or queued notification intent.

**Cons**:

1. Old provider resources exist briefly after Resend becomes active.
2. The infrastructure remains more complex until cleanup is complete.

### Option 4: Use Resend only for outbound email

Send notifications through Resend but require customer replies through the widget.

**Pros**:

1. Smallest provider change.
2. No inbound DNS migration.

**Cons**:

1. Customers who reply to ticket email would not reach the ticket timeline.
2. It breaks the continuous support conversation required by the ticket feature.

## Rationale

Option 3 is the best fit. Resend removes the suspended Brevo account from the live path while keeping the change at the communication boundary. The existing outbox, queue, ticket store, retry behavior, and admin views remain provider neutral.

The worker uses Resend's REST API because Node provides `fetch`. An idempotency header prevents duplicate sends during queue retries. Provider neutral ticket and event identifiers are stored as email tags and returned on delivery webhooks. Those tags are trusted only after the webhook signature is verified, so provider events can update the correct outbox item without putting customer content in tags.

Resend signs webhook requests with Svix signatures. The handler verifies the raw request body before parsing it. For inbound mail, the webhook carries metadata and an email id. The handler retrieves the parsed message through the Resend API, rejects attachments, validates SPF, DKIM, and DMARC results, extracts only the new plain text reply, and passes that reply to the existing ticket processor.

## Cost analysis for 100 to 300 emails each month

The expected volume fits within Resend's free allowance at the time of this decision. AWS Lambda, DynamoDB, SQS, Secrets Manager, and CloudWatch remain in use. Their incremental cost at this volume should stay small. The main operational cost is maintaining webhook security, delivery mappings, DNS, and suppression behavior.

## Resend setup and operational requirements

1. Store the Resend API key in AWS Secrets Manager.
2. Verify `nailzify.com` as a sending domain and publish the DNS records Resend provides.
3. Configure `support@nailzify.com` as the sender.
4. Create one webhook for sent, delivered, delayed, bounced, complained, failed, suppressed, and received events.
5. Store the webhook signing secret in AWS Secrets Manager.
6. Verify `tickets.nailzify.com` for receiving and publish the Resend MX record.
7. Send an internal test ticket and confirm delivery updates reach the ticket timeline.
8. Reply to the test message and confirm the reply reaches the same ticket.
9. Monitor bounces, complaints, suppressed messages, webhook failures, and the notification dead letter queue.
10. Remove Brevo resources only after outbound and inbound tests pass in production.

## References

**Project sources**:

1. `services/notifications/src/worker.ts`, the notification worker and current provider adapter.
2. `services/notifications/src/delivery-update.ts`, provider neutral delivery state persistence.
3. `services/notifications/src/inbound-reply.ts`, secure reply processing.
4. `infra/lib/api-stack.ts`, notification Lambdas, queues, secrets, and webhook endpoint.
5. `packages/adapters/src/aws/secrets.ts`, cached Secrets Manager access.

**Practices and standards**:

1. Transactional outbox for reliable side effects.
2. At least once delivery with application idempotency.
3. Staged migration for a live provider replacement.
4. Signed webhook verification using the raw request body.
5. DKIM, SPF, and DMARC email authentication.
6. Personal data minimization and bounded retention.

**Links**:

1. Resend send email API: https://resend.com/docs/api-reference/emails/send-email
2. Resend received email API: https://resend.com/docs/api-reference/emails/retrieve-received-email
3. Resend webhook verification: https://resend.com/docs/webhooks/verify-webhooks-requests
4. Resend receiving guide: https://resend.com/docs/dashboard/receiving/introduction
5. Resend inbound email overview: https://www.resend.com/features/inbound
6. Resend webhook event visibility: https://www.resend.com/changelog/webhook-event-visibility
