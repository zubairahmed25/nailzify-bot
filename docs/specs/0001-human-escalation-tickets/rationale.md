# Human escalation tickets, rationale

## Context

The chat core already exposes an `escalate_to_human` tool. Today it only marks the session as escalated and returns a handoff message. No durable ticket, admin queue, email notification, owner, status history, or delivery retry exists.

The current system is a TypeScript monorepo on AWS. It uses Lambda, DynamoDB, S3, CloudFront, CloudWatch, Bedrock, CDK, a storefront widget, and a Shopify authenticated merchant admin app. The support design should reuse those boundaries and avoid a second database or an unrelated deployment tool.

The important goal is not to copy every Zendesk screen. The goal is to preserve the support properties that prevent lost requests: one durable record, explicit ownership and status, a public conversation, private notes, event history, reliable notifications, and time based reminders. The merchant must see and operate the complete workflow inside the existing embedded Shopify admin app where Knowledge Base PDFs are already managed.

## What Zendesk gets right

Zendesk uses one ticket as the shared record across email, forms, messaging, chat, calls, and API channels. The requester is the customer asking for help. A ticket can belong to one group and one assignee. Public comments form the customer conversation. Private comments support internal work. Events record status, assignment, automation, and notification changes.

Its default status categories are `new`, `open`, `pending`, `hold`, `solved`, and `closed`. Solved is reversible when a customer responds. Closed is final, so a later response becomes a follow up. This distinction prevents old records from changing forever while still keeping a customer from reaching a dead end.

Zendesk separates immediate rules from time based rules. Triggers run after a ticket is created or updated. Automations evaluate elapsed time on a schedule. Views are saved queue filters. Macros are repeatable agent actions. The proposed Nailzify design copies triggers as code, one scheduled stale ticket job, and basic views. It does not build a general rules editor or macros in the first release.

Email is part of the ticket conversation. Agent public comments produce customer email. Customer email replies become ticket comments. A reply delimiter separates the new text from quoted history. Notification delivery and ticket events remain visible for diagnosis.

## Options considered

### Option 1: Extend the current application with Amazon SES

Build the ticket workflow in the current app and use SES for outbound messages and inbound customer replies.

**Pros**:

1. Reuses Lambda, DynamoDB, CDK, CloudWatch, Shopify admin authentication, and the existing UI.
2. Lowest recurring cost.
3. Full control over the customer and merchant experience.
4. No per agent license.

**Cons**:

1. The team owns ticket lifecycle, email parsing, retries, deliverability, and operations.
2. More engineering work than integrating a mature help desk.

### Option 2: Amazon WorkMail plus a small ticket database

Use WorkMail for agent mailboxes and still build ticket records and the merchant admin workflow.

**Pros**:

1. Familiar IMAP and Outlook style mailbox access.
2. Simple human email use.

**Cons**:

1. Costs $4 per agent each month.
2. Does not provide ticket state, assignment, audit history, views, triggers, or transcript linkage.
3. Email clients become another place where support state can diverge.

### Option 3: Buy Zendesk or another help desk and integrate it

Create tickets through the provider API and let agents use the provider workspace.

**Pros**:

1. Mature routing, email, SLAs, macros, reporting, and operations.
2. Less custom support software to maintain.

**Cons**:

1. Recurring per agent cost and external product dependency.
2. A second admin experience outside Shopify.
3. The requested goal is to build and demonstrate this capability in the current AWS project.

### Option 4: Outbound notification email only

Create a ticket and alert the merchant, but force all customer replies through the widget.

**Pros**:

1. Smallest implementation.
2. Avoids inbound MIME parsing and DNS receiving rules.

**Cons**:

1. Customers naturally reply to support email and those replies would be lost or confusing.
2. It does not produce the Zendesk style continuous conversation the feature is meant to mimic.

## Rationale

Option 1 is the best fit. The application already contains almost every required runtime boundary. SES adds the missing communication channel without a monthly license. The existing Shopify admin app remains the only merchant workspace, with Knowledge Base and Tickets as sections of the same embedded application. The main cost is engineering ownership, not AWS usage.

The design uses customer confirmation before ticket creation because the model should not perform an external side effect on its own. This preserves the current security rule that the model proposes and a person confirms. It also collects the contact email that the current Shopify App Proxy context does not provide.

The outbox and queue are necessary even at low volume. A ticket must not disappear because SES had a temporary error, and an email retry must not create a second customer comment. Reliability is the reason for the queue, not scale.

## Cost analysis for 100 tickets each month

Assumptions per ticket:

1. Five outbound messages, customer acknowledgement, merchant alert, two merchant replies, and solved notice.
2. Two inbound customer replies.
3. Average message size of 32 KB.
4. No email attachments.
5. Shared SES IPs. No dedicated IP, Virtual Deliverability Manager, Global Endpoints, or Mail Manager open ingress endpoint.

| Item | Monthly units | Rate | Estimated cost |
|---|---:|---:|---:|
| SES outbound email | 500 | $0.10 per 1,000 | $0.0500 |
| SES inbound email | 200 | $0.10 per 1,000 | $0.0200 |
| SES inbound chunks | 25 chunks | $0.09 per 1,000 chunks | $0.0023 |
| SES outbound data | About 0.015 GB | $0.12 per GB | $0.0018 |
| **Estimated SES total** | | | **$0.0741 per month** |

The selected email service is therefore safely under ten cents each month for this workload. The estimate excludes domain registration because Nailzify already owns a domain. It also excludes optional SES products with fixed fees because this workload does not need them.

Incremental Lambda and SQS charges should be zero while the account remains within their standing monthly free usage. DynamoDB and S3 activity at this volume is a fraction of one cent to a few cents, depending on current account free usage and retention. CloudWatch custom alarms may cost more than the email itself, so prefer existing service metrics and add only alarms that drive a real response.

For comparison, one WorkMail user costs $4 each month. Three merchant users cost $12 each month before the custom ticket system is considered. WorkMail solves mailbox access, not ticket workflow.

## SES setup and operational requirements

1. Verify the sending domain and enable DKIM.
2. Publish SPF and DMARC records with correct domain alignment.
3. Request production access. The SES sandbox can send only to verified recipients and is limited to 200 messages per day.
4. Use a dedicated support subdomain for inbound mail and publish its MX record.
5. Keep the custom MAIL FROM subdomain separate from the inbound support subdomain.
6. Configure bounce, complaint, reject, delivery delay, and delivery events.
7. Use the account suppression list for hard bounces and complaints.
8. Use shared IPs. Dedicated IPs are unnecessary and actively wasteful at this volume.
9. Keep SES, Lambda, SQS, SNS, and receipt rule resources in `us-east-1`, matching the current app.

## References

**Project sources**:

1. `packages/core/src/prompts/tools.ts`, existing `escalate_to_human` definition.
2. `packages/core/src/application/tool-registry.ts`, current in memory escalation artifact.
3. `packages/core/src/application/handle-message.ts`, current session escalation persistence and stream contract.
4. `services/admin/src/security/verify-session-token.ts`, merchant identity and authorization source.
5. `infra/lib/data-stack.ts`, existing DynamoDB and S3 state boundaries.
6. `infra/lib/api-stack.ts`, existing Lambda, CloudFront, IAM, and admin service boundaries.

**Practices and standards**:

1. Transactional outbox for reliable side effects.
2. At least once delivery with application idempotency.
3. Least privilege IAM.
4. DKIM, SPF, and DMARC email authentication.
5. Personal data minimization and bounded retention.

**Links**:

1. Zendesk ticket API and core ticket properties: https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/
2. Zendesk routing, views, triggers, automations, groups, and assignment: https://support.zendesk.com/hc/en-us/articles/4408831658650-Routing-and-automation-options-for-incoming-tickets
3. Zendesk trigger behavior: https://support.zendesk.com/hc/en-us/articles/4408822236058-About-Zendesk-triggers-and-how-they-work
4. Zendesk ticket conversations and event history: https://support.zendesk.com/hc/en-us/articles/4408882997530-Lesson-3-Solving-tickets
5. Zendesk email reply delimiter and comments: https://support.zendesk.com/hc/en-us/articles/4408886168090-Customizing-your-email-notifications
6. Amazon SES pricing: https://aws.amazon.com/ses/pricing/
7. Amazon SES receiving concepts and receipt rules: https://docs.aws.amazon.com/ses/latest/dg/receiving-email-concepts.html
8. Amazon SES regional receiving requirements: https://docs.aws.amazon.com/ses/latest/dg/regions.html
9. Amazon SES production access and sandbox limits: https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html
10. Amazon SES bounce and complaint events: https://docs.aws.amazon.com/ses/latest/dg/monitor-sending-activity-using-notifications.html
11. Amazon SES DMARC guidance: https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html
12. Amazon WorkMail product pricing: https://aws.amazon.com/workmail/
13. Amazon Lambda pricing: https://aws.amazon.com/lambda/pricing/
14. Amazon SQS pricing: https://aws.amazon.com/sqs/pricing/
15. Amazon DynamoDB pricing: https://aws.amazon.com/dynamodb/pricing/
