# Secure customer order lookup, rationale

## Context

The storefront chat can currently answer catalog and knowledge questions, but it intentionally has no access to customer orders. Specific order questions therefore move to human support. The application already receives a Shopify signed App Proxy request and may receive a signed in customer identifier, but that identifier alone does not grant buyer scoped Customer Account API access.

The new feature must retrieve live order information without exposing store wide credentials, leaking one customer's data to another, putting private order data into model context, or turning the chat into an order mutation interface.

## Confirmed product decisions

1. The first release is read only.
2. Shopify's existing passwordless email code authenticates the customer.
3. The widget shows up to five recent orders and lets the customer select one.
4. The selected order card shows order number, date, item names and quantities, total, payment status, fulfillment status, and tracking.
5. Order payloads are not stored in the application database or conversation history.
6. Missing or failed results offer an optional support ticket.
7. Order context is attached to a ticket only with explicit customer permission.
8. The card uses the existing widget design system.
9. One quiet retry precedes the deterministic unavailable state.

## Options considered

### Option 1: Customer Account API with buyer authentication

Shopify authenticates the buyer. The application receives a buyer scoped access token and reads that buyer's orders through the Customer Account API.

**Advantages**:

1. Shopify enforces the buyer data boundary.
2. The backend does not need a store wide order credential.
3. The authentication experience is Shopify's existing passwordless account flow.
4. The API provides order, fulfillment, and tracking data intended for customer experiences.

**Costs**:

1. Requires OAuth, PKCE, state, nonce, callback, token expiry, and encrypted token storage.
2. Requires Customer Account API scopes and protected customer data approval.
3. Requires careful return to the existing storefront conversation.

### Option 2: Admin API using the signed App Proxy customer identifier

The backend uses a Shopify Admin API credential with `read_orders`, queries the customer from the signed App Proxy identity, and filters orders in application code.

**Advantages**:

1. Smaller authentication implementation.
2. Familiar Admin GraphQL order schema.

**Costs**:

1. The credential can read orders across the store.
2. A filtering defect or compromised function has a much larger breach radius.
3. It weakens the existing adapter boundary that deliberately keeps Storefront access separate from Admin access.
4. Shopify limits Admin API order access to the latest 60 days by default unless broader access is approved.

### Option 3: Link to the Shopify customer account order page

The chat recognizes order intent and sends the customer to their existing Shopify account page.

**Advantages**:

1. Almost no private data enters the chat application.
2. Shopify owns the full order experience.

**Costs**:

1. It does not satisfy the requirement to retrieve order status inside chat.
2. The customer loses conversational continuity.
3. It offers little improvement over the existing account link.

### Option 4: Order number plus email lookup

The shopper enters an order number and email address. The application treats the pair as proof of ownership.

**Advantages**:

1. Familiar guest order lookup pattern.
2. No account redirect.

**Costs**:

1. Order numbers and emails are discoverable and reusable identifiers, not strong authentication.
2. Enumeration, phishing, and shared mailbox risks are materially higher.
3. The application would need its own verification and abuse prevention system.

## Decision rationale

Option 1 is selected because least privilege is the load bearing requirement. Shopify's Customer Account API authenticates the buyer rather than the merchant application, and it is designed to expose that buyer's account information, including orders and fulfillment data.

The application still verifies its own boundaries. It validates OAuth state, PKCE, nonce, identity token claims, shop, chat session binding, token expiry, App Proxy signature, and customer match. Shopify's authorization is necessary but not treated as sufficient for an application session without these checks.

Private order payloads bypass the language model because the model does not need them to render a deterministic status card. This reduces hallucination risk, limits data processing, prevents order details from entering conversation summaries, and makes missing fields explicit.

## Data and retention rationale

Live Shopify data remains the source of truth. Copying orders into DynamoDB would create staleness, deletion, retention, and customer access obligations without improving the first release. Only the short lived encrypted access token and privacy safe audit metadata are stored.

The 15 minute session limit is an application security control, not the duration of the Shopify customer account login. A customer with an active Shopify account session may be able to authenticate again with little friction, while a stolen application session loses usefulness quickly.

## Reference decisions

1. Use Shopify discovery endpoints instead of hardcoded authentication or GraphQL endpoints.
2. Use Shopify OAuth 2.0 with PKCE and OpenID Connect validation for the buyer flow.
3. Request only order read access and only the protected customer fields required by the implementation.
4. Query only the fields needed by the approved order card.
5. Use Shopify supplied tracking URLs instead of constructing carrier URLs.
6. Do not add `read_orders` or `read_all_orders` Admin API access for this feature.

## References

### Project sources

1. `services/api/src/security/verify-app-proxy.ts`, existing Shopify App Proxy signature and signed customer identifier verification.
2. `services/api/src/handler.ts`, existing authenticated storefront request boundary and SSE response.
3. `packages/adapters/src/shopify/storefront-client.ts`, existing least privilege Storefront API adapter boundary.
4. `packages/core/src/prompts/system-prompt.ts`, current statement that the assistant cannot access customer orders.
5. `packages/core/src/application/human-handoff-intent.ts`, current order issue handoff routing.
6. `web/widget/src/persistence.ts`, current tab scoped conversation restoration.
7. `packages/adapters/src/dynamodb/conversation-repo.ts`, current session and retention model.
8. `infra/lib/data-stack.ts`, existing DynamoDB table and deletion indexes.

### Shopify sources

1. Customer Account API overview and authentication: https://shopify.dev/docs/api/customer/latest
2. Customer Account API authentication tutorial: https://shopify.dev/docs/storefronts/headless/building-with-the-customer-account-api/authenticate-customers
3. Shopify API authentication comparison: https://shopify.dev/docs/api/usage/authentication
4. Customer order object: https://shopify.dev/docs/api/customer/latest/objects/order
5. Customer tracking information object: https://shopify.dev/docs/api/customer/latest/objects/TrackingInformation
6. Shopify customer account passwordless sign in: https://help.shopify.com/en/manual/customers/customer-accounts
7. Admin API order access and 60 day default window: https://shopify.dev/docs/api/admin-graphql/latest/objects/Order

## Premise checks for implementation

1. Confirm the production store uses current Shopify customer accounts rather than legacy accounts.
2. Confirm the app configuration can register customer authentication redirect URIs.
3. Confirm Shopify grants the required protected customer data access before production enablement.
4. Confirm the current stable Customer Account API schema names for the approved logical fields during implementation.
5. Confirm App Proxy requests after customer sign in include the expected signed customer identifier for the production theme configuration.
