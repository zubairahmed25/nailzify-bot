# Phase 5 — Chat Request Lifecycle

One message, end to end, with a latency budget. This is where the pieces from Phases 1–4
become a sequence of real operations you can profile.

---

## 5.1 Sequence

```
Customer                Shopify           CloudFront/WAF        Lambda            Bedrock      Pinecone   Shopify API   DynamoDB
   │                    App Proxy                                 │                  │            │           │            │
   │─(1) type message──────►│                                     │                  │            │           │            │
   │                        │─(2) HMAC sign + forward──►│         │                  │            │           │            │
   │                        │                            │─(3)───►│                  │            │           │            │
   │                        │                            │        │─(4) verify HMAC  │            │           │            │
   │                        │                            │        │─(5) load history───────────────────────────────────────►│
   │                        │                            │        │◄──────────────────────────────────────── last N turns ──│
   │                        │                            │        │─(6) build prompt │            │           │            │
   │                        │                            │        │─(7) invoke ─────►│            │           │            │
   │                        │                            │        │◄── tool_use ─────│            │           │            │
   │                        │                            │        │─(8a) embed query►│            │           │            │
   │                        │                            │        │─(8b) vector search──────────►│           │            │
   │                        │                            │        │─(8c) rerank ────►│            │           │            │
   │                        │                            │        │─(8d) hydrate ────────────────────────────►│            │
   │                        │                            │        │─(9) tool_result ►│            │           │            │
   │◄══(10) SSE tokens ═════╪════════════════════════════╪════════╪◄══ stream ═══════│            │           │            │
   │                        │                            │        │─(11) persist turn ─────────────────────────────────────►│
   │                        │                            │        │─(12) emit metrics│            │           │            │
```

---

## 5.2 Step by step

### (1) The widget sends the message

The widget POSTs to a path on **the Shopify domain**, not to AWS:

```
POST https://nailzify.com/apps/nailzify-chat/message
Content-Type: application/json

{ "sessionId": "01JQZ...", "message": "Do these fit small nail beds?" }
```

**Why through Shopify and not straight to our API?** Three things fall out for free:

- **Same-origin.** No CORS preflight, no cross-origin cookie problems.
- **Authenticated identity.** Shopify appends `logged_in_customer_id` if the customer is
  signed in — an identity signal we could never trust from a browser-supplied value.
- **HMAC signature.** Every forwarded request carries a signature computed with a shared
  secret only Shopify and we know. That is what makes the endpoint unforgeable.

`sessionId` is a client-generated UUIDv7 held in `sessionStorage` — it survives page
navigation within the visit and dies when the tab closes. Sortable by time, which is
convenient for DynamoDB.

### (2)–(3) App Proxy → WAF → CloudFront → Lambda

Shopify forwards to the configured proxy URL, appending query parameters and a
`signature`. WAF applies rate limits. CloudFront routes `/api/*` to the Lambda Function
URL.

### (4) Verify — do this before anything else

```ts
// Reject before spending a single token.
if (!verifyShopifyProxyHmac(request, await getSecret("shopify/proxy-secret"))) {
  return unauthorized();
}
```

**Use a timing-safe comparison** (`crypto.timingSafeEqual`), not `===`. A naive string
compare leaks the correct signature byte by byte through response timing. This is a real,
practical attack against HMAC verification and the mitigation is one function call.

Then: validate the body against a schema (Zod), enforce a message length cap, and check
the per-session turn budget in DynamoDB. Cheapest checks first — every millisecond spent
before rejecting a bad request is wasted, and every token spent is money.

### (5) Load conversation history

One DynamoDB query: `PK = SESSION#<sessionId>`, sorted by `SK`, limit ~20 items,
descending.

**Windowing strategy.** Send the model the last **10 turns verbatim**. If the conversation
runs longer, keep a rolling summary of everything before that (generated with Haiku,
stored on the session item) plus the recent turns. This keeps prompt size bounded and
predictable — which matters because prompt size is cost, and unbounded prompt growth is
how a chatbot's per-conversation cost quietly triples.

**Concept — conversation memory.** The Bedrock/Messages API is **stateless**. It has no
memory of previous calls. "Conversation memory" is entirely a thing *you* implement by
resending history each turn. Every message you resend is billed as input tokens again,
which is precisely why prompt caching matters so much for chat: the stable prefix
(system + tools + older turns) bills at ~0.1× on cache hits.

### (6) Build the prompt

```ts
const messages = [
  ...(summary ? [{ role: "user", content: `[Earlier conversation summary]\n${summary}` }] : []),
  ...recentTurns,
  { role: "user", content: userMessage },
];
```

Cache-layout rules, in order of how often they're violated:

- **Never** interpolate a timestamp, session ID, or customer ID into the system prompt.
  One changed byte invalidates the whole cached prefix on every single request.
- Keep tool definitions in a fixed order (sort by name) — array order is part of the
  cache key.
- Serialize any JSON in the prompt deterministically (sorted keys).
- Volatile per-request context goes in the **user** turn, after the last cache breakpoint.

### (7) First Bedrock call

```ts
const stream = await bedrock.messages.stream({
  model: "anthropic.claude-sonnet-5",
  max_tokens: 2048,
  system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
  tools: TOOLS,
  messages,
});
```

The model responds with either text (answer directly — chitchat, clarification) or
`tool_use` blocks. Roughly 70% of substantive turns will request a tool.

**Parallel tool calls.** The model may emit several `tool_use` blocks in one response
("show me almond nails and tell me the return policy"). Execute them **concurrently** with
`Promise.all`, and return **all** `tool_result` blocks in a **single** user message.
Splitting results across multiple messages silently teaches the model to stop making
parallel calls — a subtle performance regression with no error to catch it.

### (8) Execute tools

For `search_products` — the four sub-steps, in order, with typical timings:

| Sub-step | Operation | Latency |
|---|---|---|
| 8a | Embed the query (Bedrock, Cohere `search_query`) | ~80 ms |
| 8b | Vector search + metadata filter (Pinecone) | ~50 ms |
| 8c | Rerank top 20 → top 4 | ~100–300 ms |
| 8d | Hydrate live from Shopify Storefront GraphQL | ~120 ms |

Run 8a/8b for the knowledge plane and the catalog plane **concurrently** when both are
requested. They share no state.

Every tool handler returns a discriminated union, never throws across the boundary:

```ts
type ToolResult<T> =
  | { ok: true;  data: T }
  | { ok: false; error: string; retryable: boolean };
```

A failed tool comes back to the model as a `tool_result` with `is_error: true` and a
human-readable message. The model then says *"I'm having trouble checking stock right
now"* — which is a good customer experience. **Never drop a `tool_result` for a
`tool_use` block**: the API requires one result per call, and omitting one is a hard error
that surfaces as a 400 rather than a graceful degradation.

### (9)–(10) Second Bedrock call, streaming to the customer

Tool results go back; the model composes the answer. This call streams.

```ts
// Lambda Function URL, RESPONSE_STREAM invoke mode
export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const http = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });

  for await (const chunk of stream) {
    if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
      http.write(`data: ${JSON.stringify({ type: "token", text: chunk.delta.text })}\n\n`);
    }
  }
  http.write(`data: ${JSON.stringify({ type: "done", citations, products })}\n\n`);
  http.end();
});
```

**Why streaming is not a nice-to-have.** A full answer takes 3–5 seconds to generate. Sent
as one response, the customer watches a spinner for 4 seconds. Streamed, the first word
appears in under a second and reads at roughly the speed they read. Same total time,
completely different experience — and measurably lower abandonment.

**This is why we use a Lambda Function URL instead of API Gateway.** API Gateway buffers
the entire response body; it cannot stream. Choosing API Gateway here would silently cost
you the single biggest UX win available.

### (11) Persist

Two DynamoDB writes (batched): the user turn and the assistant turn, each with a TTL
30 days out. Include the retrieved chunk IDs and tool calls on the assistant item — that's
what makes "why did the bot say that?" answerable three weeks later.

Do this **after** the stream ends so it never adds to perceived latency.

### (12) Emit metrics

Structured JSON log line + CloudWatch EMF metrics: latency per stage, token counts, tools
called, retrieval scores, whether the model abstained.

---

## 5.3 Latency budget

Target: **< 1.2 s to first token**, < 4 s to complete.

| Stage | Budget | Notes |
|---|---|---|
| App Proxy + WAF + CloudFront | 60 ms | Mostly network |
| HMAC verify + validation | 5 ms | |
| Load history (DynamoDB) | 15 ms | Single-digit ms query + overhead |
| Bedrock call 1 (to `tool_use`) | 400 ms | Cache hit on the prefix helps a lot |
| Tool execution (parallel) | 300 ms | Dominated by rerank + Shopify |
| Bedrock call 2 → first token | 350 ms | |
| **Total to first token** | **≈ 1.1 s** | |
| Remaining stream | 2–3 s | Perceived as "typing" |

**Where to look when it's slow:**

1. **Cold start** (~600 ms) — bundle with esbuild, keep dependencies lean, consider
   provisioned concurrency during peak hours. Measure the real number before paying for it.
2. **Reranking** — the most expensive tool sub-step. Drop it for simple policy lookups
   where the eval set says quality holds.
3. **Two Bedrock round trips** — inherent to tool use. You could skip the tool loop by
   always retrieving first, but you'd pay retrieval cost on every "thanks" and lose
   multi-hop reasoning. Not worth it.
4. **Secrets Manager on every invoke** — a classic ~30 ms self-inflicted wound. Cache the
   secret at module scope with a TTL.

---

## 5.4 Failure paths

Every dependency needs a defined behaviour, written down before it fails at 2 AM.

| Failure | Behaviour |
|---|---|
| Bedrock throttled (429) | Retry with jitter (2 attempts). Then: "I'm getting a lot of questions right now — try again in a moment?" |
| Bedrock 5xx | Retry once, then fall back to Haiku 4.5. Degraded quality beats no answer. |
| Pinecone unreachable | Answer without knowledge retrieval, explicitly scoped: "I can't look that up right now, but I can help with products." Never guess the policy. |
| Shopify API down | Do **not** serve cached prices. "I can't check live pricing — here's the product page." |
| DynamoDB throttled | On-demand mode makes this rare. Proceed with an empty history rather than failing the turn. |
| Tool handler throws | Caught at the boundary → `tool_result` with `is_error: true`. The model apologizes gracefully. |
| Model returns malformed tool args | `strict: true` prevents most of it. Otherwise return a validation error as `tool_result` and let the model retry. |
| Stream breaks mid-response | Client reconnects with the session ID; partial content already rendered is preserved. |

**The principle:** every failure produces a sentence a customer can read, never a stack
trace and never a confident guess. Degrading to a plausible-sounding invented answer is
the worst possible failure mode for this system — it's the one thing the whole
architecture exists to prevent.

---

## 5.5 Idempotency and concurrency

- The widget sends a client-generated `messageId`. A conditional DynamoDB write
  (`attribute_not_exists`) makes duplicate submissions (double-click, retry) safe.
- A customer opening two tabs gets two `sessionId`s and two independent conversations.
  That's correct behaviour, not a bug.
- Concurrent turns in one session are serialized with a conditional write on a session
  version attribute. Rare, but a race here produces interleaved nonsense.

---

Next: [Phase 6 — Data model](06-data-model.md)
