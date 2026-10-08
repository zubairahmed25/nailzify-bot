# Secure customer order lookup, verification plan

## Purpose

This feature handles protected customer order data and authentication credentials. It is not complete when the happy path renders. Completion requires evidence that customer isolation, non-persistence, field minimization, model bypass, and failure behavior hold under negative conditions.

## Automated proof matrix

| Acceptance criterion | Required proof |
|---|---|
| **AC-1** | Router tests distinguish live order requests from general policies and order mutation requests. The knowledge retriever is not called for live order state. |
| **AC-2** | Widget and callback integration test begins Shopify authentication, validates the callback, returns to the original storefront URL, and restores the same chat session. |
| **AC-3** | Adapter contract test returns at most five orders. Cross customer and forged order identifiers return the same safe not found response and emit no data. |
| **AC-4** | Schema tests prove every approved field maps correctly for fulfilled, unfulfilled, partially fulfilled, canceled, refunded, and multi fulfillment orders. |
| **AC-5** | GraphQL query snapshot and runtime schema tests fail if forbidden fields are selected or returned. |
| **AC-6** | Repository and prompt spy tests prove order payloads are not passed to the model, conversation repository, summaries, browser persistence, or analytics. |
| **AC-7** | Audit repository tests assert the exact allowlist of stored metadata and reject order content keys. |
| **AC-8** | Timeout, rate limit, and `5xx` tests prove exactly one retry, bounded delay, and deterministic fallback without model invocation. |
| **AC-9** | Missing tracking tests render a successful no tracking state and never render fabricated carrier, URL, or date values. |
| **AC-10** | Mutation intent tests route cancel, return, refund, exchange, and address change requests to optional human support without calling an order mutation. |
| **AC-11** | Ticket tests prove no context is attached without explicit consent and approved minimized context is revalidated before attachment. |
| **AC-12** | Security tests cover expired state, state mismatch, callback replay, invalid issuer, invalid audience, nonce mismatch, PKCE mismatch, expired token, wrong shop, wrong customer, and revoked token. |
| **AC-13** | Component accessibility tests cover keyboard selection, visible focus, live status announcements, semantic labels, tracking link name, and narrow viewport behavior. |
| **AC-14** | Continuous integration runs unit, contract, integration, component, and infrastructure assertions for the feature. |

## Unit tests

1. Classify `Where is my order?`, `Has order 123 shipped?`, and the order quick action as live order lookup.
2. Classify `What is your shipping policy?` as knowledge retrieval.
3. Classify `Cancel my order`, `Change my address`, and `Refund this` as human support actions.
4. Map every supported Shopify order and fulfillment status to customer facing copy.
5. Preserve unknown statuses as safe generic copy rather than guessing.
6. Minimize Shopify responses through an explicit field allowlist.
7. Reject unsafe tracking URL schemes.
8. Produce privacy safe audit events for success and every normalized failure category.
9. Apply one retry only to allowed transient errors.

## Authentication and authorization tests

1. State, nonce, and PKCE values use a cryptographically secure source and meet required entropy.
2. Challenges expire after five minutes and can be consumed once.
3. Callback validation occurs before token exchange or storage.
4. Identity token signature, issuer, audience, nonce, issued time, and expiry are validated.
5. The return URL is selected from an allowlist and cannot become an open redirect.
6. Discovered endpoints are accepted only for the configured Shopify store and approved Shopify account hosts.
7. Stored access tokens are encrypted with KMS and never returned from an API.
8. Order sessions expire after at most 15 minutes and are deleted by TTL.
9. Shop, customer, and chat session mismatches fail before an order response is emitted.
10. App Proxy signature verification remains mandatory for storefront order endpoints.

## Adapter contract tests

Use recorded schema shaped fixtures with all personal values synthetic.

1. Recent orders are sorted newest first and limited to five.
2. An account with no orders returns an empty list.
3. A selected order belongs to the authenticated API context.
4. Multiple fulfillments and tracking numbers render without losing status information.
5. Missing fulfillment and tracking values remain absent.
6. Currency code remains attached to totals.
7. GraphQL partial data with errors fails closed.
8. Malformed response data emits no partial order event.
9. Rate limit guidance is normalized for the application retry policy.

## Persistence and privacy tests

1. Spy on every model call and assert no order payload or order identifier appears in input.
2. Spy on conversation writes and assert no order card or order detail event is written.
3. Inspect browser `sessionStorage` and `localStorage` after lookup and assert no order content or token exists.
4. Inspect API and CloudFront response headers for `Cache-Control: no-store`.
5. Inspect structured logs, metrics dimensions, and traces for forbidden fields.
6. Inspect DynamoDB challenge, session, and audit records against the field allowlists in the specification.
7. Confirm customer deletion removes active order authentication records associated with the customer.

## Widget tests

1. Unauthenticated order intent renders the sign in action.
2. Authentication return restores the existing conversation and opens the recent order selector.
3. Five recent orders can be selected by pointer and keyboard.
4. An order card displays all and only available approved fields.
5. Tracking opens the Shopify supplied URL with safe external link attributes.
6. Closing the widget clears visible order payloads.
7. Expiry clears order payloads and returns to the sign in state.
8. Empty, missing tracking, unavailable, and not found states use deterministic copy.
9. `Contact support` opens the existing ticket confirmation flow.
10. Order context consent starts unchecked and names the fields that will be attached.

## Infrastructure assertions

1. The feature flag defaults to disabled.
2. Callback and lookup routes have no shared cache behavior.
3. The dedicated KMS key grants encrypt and decrypt only to the required Lambda roles.
4. DynamoDB TTL is enabled for challenge and customer order session records.
5. Lambda logs have the existing retention and data protection behavior.
6. No Admin API order scope or store wide order secret is introduced.
7. Alarms cover elevated authentication failure, customer mismatch, Shopify unavailable, and order lookup error rates without customer dimensions.

## Manual development store scenarios

Use synthetic customers and orders only.

1. Newest order is unfulfilled and has no tracking.
2. Order is fulfilled with one carrier and tracking link.
3. Order has multiple fulfillments.
4. Order is partially fulfilled.
5. Order is canceled.
6. Order is partially or fully refunded.
7. Customer has more than five orders.
8. Customer has no orders.
9. Customer signs out and a second customer signs in within the same browser tab.
10. Shopify is throttled or temporarily unavailable.
11. Customer denies or abandons authentication.
12. Customer asks for cancellation after viewing an order and creates a ticket with and without context consent.

For each scenario, inspect the rendered UI, DynamoDB records, browser storage, Lambda logs, model traces, and stored conversation transcript.

## Production smoke verification

Run with a merchant controlled test customer and test order after the feature is enabled for internal traffic.

1. Start from an anonymous storefront session.
2. Ask for order status and complete Shopify's email code sign in.
3. Confirm return to the same chat with no lost messages.
4. Confirm only the test customer's recent orders appear.
5. Open the test order and compare every displayed value with Shopify.
6. Confirm order contents are absent from the stored conversation, browser storage, logs, traces, and DynamoDB audit event.
7. Expire or revoke the order session and confirm safe reauthentication.
8. Disable the feature flag and confirm the existing support path remains available.

## Release gate

Do not enable production customer traffic until:

1. Shopify protected customer data access is approved.
2. All automated proof matrix rows pass.
3. The development store manual scenarios pass.
4. A privacy review confirms the field and storage allowlists.
5. A security review confirms OAuth, OIDC, PKCE, state, nonce, KMS, replay protection, and customer isolation.
6. The production smoke verification passes for a merchant controlled account.
