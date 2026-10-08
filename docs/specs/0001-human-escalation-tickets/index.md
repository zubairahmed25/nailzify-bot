# 0001. Human escalation tickets

**Date**: 2026-08-23
**Status**: In Progress

## Summary

Turn the existing `escalate_to_human` signal into a durable support ticket that the merchant can manage in the existing Shopify admin app. Use DynamoDB for ticket state, Resend for ticket email, and reliable background processing for notifications. The first release copies the useful parts of Zendesk without trying to copy the whole product.

## Requirements

**User stories**:

1. As a customer, I want the bot to create a support request when it cannot safely answer so that a person can help me.
2. As a merchant, I want one queue with the question, transcript, customer contact, owner, priority, and status so that I can resolve the issue.
3. As a customer, I want replies by email or chat to stay attached to the same ticket so that I do not repeat the problem.
4. As a merchant, I want an audit history and alerts for stale tickets so that requests do not disappear.

**Acceptance criteria**:

1. **AC-1**: A model handoff does not create a ticket by itself. The widget shows a confirmation form, collects a valid contact email, and creates exactly one ticket after the customer submits it.
2. **AC-2**: A created ticket contains the customer question, model handoff reason and summary, session id, contact email, source channel, status, priority, timestamps, and an immutable event history. It contains the chat transcript only when the customer consents to include it.
3. **AC-3**: A created ticket appears in a Tickets section inside the same embedded Shopify admin app where the merchant manages Knowledge Base uploads. It immediately sends one acknowledgement to the customer and one alert to the merchant team.
4. **AC-4**: Without leaving the embedded Shopify admin app, the merchant can assign a ticket, set priority, add a public email reply or private note, and move it through `new`, `open`, `pending`, `hold`, `solved`, and `closed` under the transition rules in this spec.
5. **AC-5**: A public merchant reply is stored before email delivery is attempted. The ticket timeline shows queued, sent, delivered, delayed, bounced, complained, and failed delivery states. Email delivery retries without creating duplicate comments or duplicate logical notifications.
6. **AC-6**: A valid customer email reply becomes one public comment on the matching ticket. A reply to a solved ticket reopens it. A reply to a closed ticket creates a linked follow up ticket.
7. **AC-7**: Invalid reply tokens, mismatched senders, failed spam checks, messages with attachments, and duplicate inbound message ids do not add public comments. They are rejected with a reason in logs.
8. **AC-8**: Only a merchant user with a valid Shopify admin session token can list tickets, view transcripts, assign work, write replies or notes, and change status.
9. **AC-9**: Failed notification processing reaches a dead letter queue and raises an operational alarm. Ticket creation remains successful and visible even if email is temporarily unavailable.
10. **AC-10**: Ticket counts, first response time, resolution time, reopen rate, and notification failures are observable without logging message bodies or email addresses.

## Decision

**Chosen option**: Keep the current ticket service and use Resend for ticket email.

Keep the existing TypeScript, Lambda, DynamoDB, CDK, Shopify admin authentication, CloudWatch, SQS, and ticket data model. Send transactional email through the Resend REST API. Receive delivery events and customer replies through signed Resend webhooks. Store the API key and webhook signing secret in AWS Secrets Manager.

## Feature design

### Scope

The first release includes ticket creation, transcript capture, customer contact, assignment, priority, public replies, private notes, status history, email notifications, customer email replies, email delivery states, queue filters, retry handling, and basic stale ticket reminders. Every merchant action and email related view lives inside the existing embedded Shopify admin app.

The first release does not include omnichannel voice, live agent chat, workforce capacity routing, skills routing, macros, custom ticket forms, ticket merge, CSAT surveys, file attachments, a separate merchant mailbox, or a general rules builder.

### Data model sketch

Use the existing DynamoDB application table. Ticket metadata and its timeline share one partition.

| Entity | Key | Important fields | Relationship |
|---|---|---|---|
| Ticket | `PK=TICKET#<ulid>`, `SK=META` | `ticketId`, `sessionId`, `requesterEmail`, `requesterName`, `subject`, `reason`, `summary`, `status`, `priority`, `assigneeUserId`, `createdAt`, `updatedAt`, `firstRespondedAt`, `solvedAt`, `closedAt`, `version`, `replyTokenHash` | One ticket has many comments and events |
| Comment | `PK=TICKET#<ulid>`, `SK=COMMENT#<time>#<id>` | `commentId`, `authorType`, `authorId`, `body`, `visibility`, `channel`, `createdAt`, `inboundMessageId`, `outboundMessageId`, `deliveryStatus`, `deliveryUpdatedAt`, `deliveryFailureReason` | Belongs to one ticket |
| Event | `PK=TICKET#<ulid>`, `SK=EVENT#<time>#<id>` | `eventId`, `actorType`, `actorId`, `eventType`, `before`, `after`, `createdAt` | Belongs to one ticket |
| Notification job | `PK=TICKET#<ulid>`, `SK=OUTBOX#<eventId>#<recipientType>` | `jobId`, `template`, `recipient`, `status`, `attempts`, `createdAt` | Produced by one ticket event |

Add `GSI3` to ticket metadata only.

1. `GSI3PK=SHOP#<shop>#STATUS#<status>`
2. `GSI3SK=<updatedAt>#<ticketId>`

This supports the merchant queue by status and recency. Assignee and priority are filtered in memory at the expected volume. Add another index only when measured volume makes that necessary.

Store the contact email in the encrypted DynamoDB table for display. Store a keyed hash of the normalized email for equality matching. Do not put email, message bodies, or transcript text into global secondary index keys, logs, metrics, or email tags.

### State transitions

1. `new` means nobody has started work.
2. `open` means the merchant owns the next action.
3. `pending` means the customer owns the next action.
4. `hold` means another internal or external party owns the next action.
5. `solved` means the merchant believes the issue is resolved. A customer reply moves it to `open`.
6. `closed` is final. A later customer reply creates a new ticket linked by `followUpToTicketId`.

An EventBridge scheduled Lambda moves `solved` tickets to `closed` after seven days. This period is a product assumption and should be confirmed before implementation.

### Customer flow

1. The model searches documents and tools first.
2. If it still cannot answer safely, or the request is an order issue, refund, payment problem, complaint, or damaged delivery, it calls `escalate_to_human` with a reason and summary.
3. The assistant says that a person can help. The widget opens a compact form with email, optional name, optional added detail, and consent to include the transcript.
4. The customer submits the form. The API creates one ticket with an idempotency key based on the session and escalation event.
5. The widget shows the ticket number and expected response window. The customer and merchant receive email.
6. Merchant replies appear in the ticket timeline and are emailed to the customer.
7. Customer email replies are received by Resend and added to the same timeline.

### Merchant flow

1. The existing embedded Shopify admin app adds top level `Knowledge Base` and `Tickets` navigation. `Knowledge Base` keeps the current PDF upload experience. `Tickets` uses the same app shell, session authentication, CloudFront distribution, and admin Lambda boundary.
2. The default Tickets view shows unsolved tickets sorted by oldest unhandled ticket first.
3. Filters include status, priority, assignee, and updated date.
4. The ticket detail view shows customer context, transcript when consented, public email conversation, private notes, status history, priority, and assignee.
5. Every inbound customer email appears as a public timeline comment with sender, received time, and channel.
6. Every outbound merchant email appears in the same timeline with recipient, queued time, send time, current delivery state, and a clear failure reason when delivery fails.
7. The merchant writes and sends customer email from the ticket detail view. A public reply stores the comment and selected status in one DynamoDB transaction. A background worker sends the email.
8. A private note never sends email and is never exposed to the customer.
9. Bounce, complaint, delay, and permanent failure events are visible on the affected message and in the ticket event history. The merchant can retry a retryable failure from the ticket page without creating another comment.
10. Merchant alert email may link directly to the embedded Shopify admin ticket page, but it is only a notification. All ticket work happens in Shopify admin.

### Email flow

Use the Resend email API for outbound ticket messages. Keep the notification queue, retry policy, ticket storage, and application region unchanged.

Outbound messages use `support@nailzify.com`. Customer replies use a random, signed address such as `reply+<opaque-token>@tickets.nailzify.com`. Resend receives mail for the verified `tickets.nailzify.com` subdomain. The token maps to one ticket and is stored only as a hash. The subject also contains the human ticket number, but subject parsing is never the authority for routing.

Resend posts received email metadata to the webhook Lambda. After signature verification, the processor retrieves the parsed message through the Resend API. It rejects messages with attachments or failed sender authentication, validates the opaque reply token, matches the sender to the requester, deduplicates by the inbound message id, and stores only the extracted plain text reply as a public comment.

Resend webhooks publish sent, delivered, delayed, bounced, complained, failed, and suppressed events. Each outbound request includes provider neutral ticket and event identifiers in Resend tags. The event processor trusts those tags only after the webhook signature is verified, resolves the stored outbox item, and updates the related outbound comment. Resend suppression prevents future delivery after permanent failures, while the ticket shows the merchant that another contact path is required.

### Reliable notification processing

Do not send email inside the customer request transaction. The transaction writes the ticket change and an outbox record together. A DynamoDB Stream handler sends the outbox event to SQS. A notification Lambda sends through Resend and records the Resend email id. SQS retries temporary failures and moves exhausted jobs to a dead letter queue.

Every notification has a deterministic idempotency key using ticket id, event id, template, and recipient. The email worker may run more than once, but only one logical notification is recorded.

### API surface

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/tickets` | POST | session id, escalation id, email, name, added detail, transcript consent | ticket id, status, created time | Shopify App Proxy signature | `400`, `401`, `409`, `422` |
| `/admin/api/tickets` | GET | cursor, status, priority, assignee | ticket summaries, next cursor | Shopify admin session token | `401`, `403` |
| `/admin/api/tickets/{id}` | GET | ticket id | metadata, comments, events, transcript | Shopify admin session token | `401`, `404` |
| `/admin/api/tickets/{id}` | PATCH | expected version, status, priority, assignee | updated ticket | Shopify admin session token | `401`, `404`, `409`, `422` |
| `/admin/api/tickets/{id}/comments` | POST | expected version, body, public or private, next status | comment id, ticket status | Shopify admin session token | `401`, `404`, `409`, `422` |
| `/admin/api/tickets/{id}/notifications/{jobId}/retry` | POST | expected ticket version, notification job id | queued delivery state | Shopify admin session token | `401`, `404`, `409`, `422` |
| `/webhooks/resend` | POST | signed Resend event with delivery or received email metadata | stored comment, updated delivery state, or rejection | Svix signature | invalid signature, invalid token, duplicate, sender mismatch, authentication failure, attachment |

### Value sourcing

| Action | Value produced or displayed | Source |
|---|---|---|
| Create ticket | Customer contact | Explicit widget form input |
| Create ticket | Handoff reason and summary | Existing `escalate_to_human` tool call |
| Create ticket | Transcript | Existing conversation repository for the session |
| Create ticket | Shop | Verified Shopify App Proxy request |
| Admin update | Merchant actor | Verified Shopify session token `sub` claim |
| Admin queue | Status and recency | Ticket metadata and `GSI3` |
| Send email | Recipient and template | Ticket metadata and outbox event |
| Receive reply | Ticket identity | Opaque recipient token, never subject text |
| Receive reply | Customer identity | Normalized sender compared with ticket requester |
| Show outbound delivery state | Delivery state and timestamp | Resend delivery webhook matched through the signed job reference |
| Retry failed email | Retry eligibility | Notification job state and last Resend failure category |
| Close stale solved ticket | Age | `solvedAt` plus the configured seven day period |

### Key invariants

1. The model may propose a handoff, but only a customer confirmation creates a ticket.
2. One escalation event creates at most one ticket.
3. Every public message has exactly one ticket and one author.
4. Private notes never leave the admin boundary.
5. A ticket update and its notification intent are committed together.
6. Closed tickets are immutable except for creating a linked follow up ticket.
7. Every status, assignment, priority, and public reply change creates an event record.

### Security model

Customer email and message content are personal data. Encrypt storage, use TLS, minimize retention, and support deletion through the existing customer deletion path. Do not store raw inbound email. Store only the extracted reply after it passes the inbound security checks.

Merchant actions require the existing Shopify admin session token and use its `sub` claim as the actor. Customer ticket creation requires the existing Shopify App Proxy signature. Reply tokens use at least 128 bits of randomness and are stored as hashes. Rate limit ticket creation per session and source address.

Do not rely on sender address alone for routing. Require a valid opaque ticket token, expected sender, acceptable SPF, DKIM, and DMARC results, no attachments, and a valid webhook signature. Escape all email and comment HTML before display.

### Configuration required

1. `RESEND_FROM_ADDRESS`, the verified sender identity.
2. `RESEND_API_KEY_SECRET_ARN`, the Secrets Manager entry containing the Resend API key.
3. `RESEND_WEBHOOK_SECRET_ARN`, the Secrets Manager entry containing the Svix signing secret.
4. `SUPPORT_REPLY_DOMAIN`, the Resend inbound receiving subdomain.
5. `TICKET_EMAIL_PROVIDER`, either `brevo` or `resend` during migration, then `resend` after cleanup.
6. `TICKET_NOTIFICATION_QUEUE_URL`, the SQS queue.
7. `MERCHANT_SUPPORT_RECIPIENTS`, the initial merchant alert addresses.
8. `TICKET_CLOSE_AFTER_DAYS`, default seven.

### Observability

Emit counts and timings for ticket created, first response, solved, reopened, email sent, email bounced, email complained, inbound rejected, queue retry, and dead letter depth. Logs contain ticket id, event id, status, channel, result, latency, and a correlation id. Logs do not contain email addresses, reply tokens, transcript text, or comment bodies.

Alarm on any dead letter message, sustained notification failure, elevated bounce or complaint rate, and tickets left in `new` beyond the chosen service target.

### Critical test scenarios

1. The bot escalates, the customer confirms, one ticket appears in admin, and both notifications are queued, verifies **AC-1**, **AC-2**, and **AC-3**.
2. A retried create request returns the original ticket and creates no duplicate, verifies **AC-1**.
3. A merchant public reply stores before Resend is invoked and a worker retry does not duplicate it, verifies **AC-5**.
4. A valid customer reply reopens a solved ticket, while a reply to a closed ticket creates a linked follow up, verifies **AC-6**.
5. A spoofed sender, invalid token, failed sender authentication, attachment, and duplicate message id produce no public comment, verifies **AC-7**.
6. A storefront user cannot call merchant ticket APIs, verifies **AC-8**.
7. Resend failure leaves the ticket visible and moves the exhausted job to the dead letter queue, verifies **AC-9**.

## Build plan

Use a tracer bullet approach. First ship the thinnest complete path from model handoff to customer confirmation, durable ticket, admin queue, and merchant alert. Then add conversation replies and lifecycle behavior.

1. Add ticket domain types, state rules, repository port, DynamoDB adapter, `GSI3`, and idempotent creation transaction, satisfies **AC-1**, **AC-2**, and **AC-4**.
2. Add widget escalation confirmation and ticket creation endpoint, then add the smallest admin queue and detail page, satisfies **AC-1**, **AC-2**, **AC-3**, and **AC-8**.
3. Replace the Brevo send adapter with the Resend email API, add API key secret access, preserve SQS and dead letter handling, and record Resend email ids, satisfies **AC-3**, **AC-5**, and **AC-9**.
4. Add assignment, priority, public replies, private notes, optimistic concurrency, event history, and delivery status presentation inside the embedded Shopify admin ticket detail view, satisfies **AC-4**, **AC-5**, **AC-8**, and **AC-10**.
5. Add signed Resend delivery and inbound webhook handling, secure reply tokens, sender authentication and attachment checks, sender checks, deduplication, delivery state mapping, and solved ticket reopening, satisfies **AC-5**, **AC-6**, **AC-7**, and **AC-10**.
6. Add scheduled close behavior, linked follow up tickets, stale ticket reminders, metrics, alarms, and operating runbooks, satisfies **AC-4**, **AC-6**, **AC-9**, and **AC-10**.

## Consequences

**Positive**:

1. The existing handoff signal becomes a real, recoverable customer support workflow.
2. The merchant works from the existing Shopify admin app.
3. Resend can handle the current 100 to 300 monthly messages on its free allowance.
4. Ticket history and notification delivery are auditable.

**Negative and tradeoffs**:

1. Resend becomes an external dependency for sending, receiving, and delivery events.
2. The team owns ticket workflow behavior instead of buying it from Zendesk.
3. DynamoDB access patterns must be chosen before adding indexes.
4. A complete Zendesk rules engine is deliberately excluded.

**Neutral**:

1. CDK remains the infrastructure source of truth. Terraform is not introduced for this feature.
2. The existing conversation table gains ticket records and one new global secondary index.

## Follow-up

1. Confirm the customer response promise shown in the widget, such as within one business day.
2. Confirm the solved to closed delay. This spec assumes seven days.
3. Confirm the merchant notification addresses and whether assignment is pull based or automatic.
4. Verify `nailzify.com` for sending and `tickets.nailzify.com` for receiving in Resend, then publish the required DNS records.
5. Decide whether customer and merchant attachments belong in a later release.

## Rationale

Reasoning, Zendesk research, provider comparison, and cost analysis are in [rationale.md](rationale.md).

## Migration plan

**Strategy**: Feature flagged strangler replacement.

**Phases**:

1. Deploy the Resend send adapter and signed webhook handler while Brevo remains configured but inactive.
2. Store the Resend API key and webhook signing secret in AWS Secrets Manager.
3. Verify the Resend sender domain, create the webhook, and send internal test notifications through Resend.
4. Configure `tickets.nailzify.com` for Resend receiving, then verify reply routing, sender authentication rejection, attachment rejection, and deduplication.
5. Switch ticket email to Resend and monitor failures, bounces, complaints, and the dead letter queue.
6. Remove Brevo code, secrets, webhook configuration, and DNS records after the observation window.

**Rollback**: Switch the email provider flag back to Brevo only if that account is restored. Otherwise, pause the email worker while keeping tickets and queued notifications intact.

**Risks**: Incorrect DNS can break inbound mail. A forged webhook could change delivery state or add a comment if signature checks are bypassed. Resend stores received email long enough for the application to retrieve it, so the processor must fetch, validate, extract, and discard message content promptly. The staged rollout isolates each risk.
