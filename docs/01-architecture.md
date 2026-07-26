# Phase 1 — High-Level Architecture

## 1.1 What we are actually building

Strip away the buzzwords and the system does four things:

1. Take a customer message from a widget inside the Shopify storefront.
2. Decide what knowledge it needs — company policy, live product data, or neither.
3. Fetch that knowledge from an authoritative source.
4. Have a language model compose an answer *constrained to what was fetched*.

Everything else — vector databases, embeddings, Step Functions, streaming — is
implementation detail in service of those four steps. Hold onto that when the diagram
starts to look intimidating. A junior engineer builds the diagram; a senior engineer can
say which box is load-bearing and which is a convenience.

---

## 1.2 The two-plane model

This is the most important decision in the project, so it comes first.

### The naive design (and why it fails in production)

The tutorial version of "Shopify AI chatbot" looks like this:

```
All content (products + policies) → chunk → embed → one vector index
                                                          ↓
                          customer question → similarity search → LLM → answer
```

It demos beautifully. It fails in production within about a week, for a reason that has
nothing to do with the model:

> **An embedding is a snapshot.** When you embed *"Autumn Almond press-ons, $18.00, 12 in
> stock, sizes XS–L"*, you have frozen four facts into a 1024-dimensional vector. Price
> changes on Black Friday. Stock hits zero. A variant is discontinued. The vector doesn't
> know. Retrieval returns it with high confidence, the model reads "$18.00" and states it
> as fact, and you have now quoted a price you don't honour.

You cannot prompt your way out of this. "Only use current information" is a wish, not a
constraint — the model has no way to know the retrieved text is stale.

### The design we use

Split retrieval by **volatility of the underlying data**.

```
┌──────────────────── KNOWLEDGE PLANE (slow-changing) ────────────────────┐
│  shipping-policy.pdf, returns.pdf, sizing-guide.pdf, nail-care.md, FAQ   │
│      ↓ chunk + embed                                                     │
│  Pinecone namespace: "knowledge"                                         │
│      ↓ semantic search                                                   │
│  Returns: text passages + source citation                                │
│  Truth model: the document IS the truth. Safe to embed.                  │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────── CATALOG PLANE (fast-changing) ──────────────────────┐
│  Shopify products                                                        │
│      ↓ nightly sync: embed ONLY stable descriptive text                  │
│        (title, description, shape, length, style, occasion, tags)        │
│  Pinecone namespace: "products"                                          │
│      ↓ semantic search → returns PRODUCT IDs ONLY, never prices          │
│      ↓                                                                   │
│  Shopify Storefront API (live) ← hydrate ids → price, stock, variants,   │
│                                                 image, URL                │
│  Truth model: Shopify IS the truth. Vectors are only an index.           │
└──────────────────────────────────────────────────────────────────────────┘
```

The vector index for products answers *"which products are conceptually relevant?"* It
never answers *"how much does it cost?"* Those are different questions and they deserve
different systems.

**What we gain:** prices and stock are correct by construction. A sale that starts at
09:00 is reflected in the bot at 09:00 with zero re-indexing.

**What we trade:** one extra network hop (Shopify Storefront API, ~80–150 ms) on any turn
that mentions a product, and a slightly more complex retrieval path. Worth it. This is
the trade every serious commerce assistant makes.

**What FAANG does differently:** the same thing, with more machinery. Amazon's product
Q&A, Google Shopping's assistant, and Meta's shop agents all treat the semantic index as
a *candidate generator* and a separate serving system as the *source of truth for
attributes*. In recommender-systems language this is the classic **retrieval → ranking →
hydration** funnel. We are building a small version of a very standard pattern.

---

## 1.3 System diagram

```
                          ┌─────────────────────────────┐
                          │   Nailzify Shopify Store    │
                          │   (customer's browser)      │
                          │                             │
                          │  ┌───────────────────────┐  │
                          │  │  React chat widget    │  │   Theme App Extension
                          │  │  (app embed block)    │  │   — no theme.liquid edits
                          │  └───────────┬───────────┘  │
                          └──────────────┼──────────────┘
                                         │
                    (1) POST /apps/nailzify-chat/message
                                         │
                          ┌──────────────▼──────────────┐
                          │   Shopify App Proxy         │
                          │   • HMAC-signs every request│
                          │   • injects logged_in_      │
                          │     customer_id             │
                          └──────────────┬──────────────┘
                                         │  (2) HTTPS, signed
┌────────────────────────────────────────┼─────────────────────────────────────┐
│  AWS  us-east-1                        │                                     │
│                          ┌─────────────▼─────────────┐                       │
│                          │  AWS WAF                  │  rate limits, bots    │
│                          └─────────────┬─────────────┘                       │
│                          ┌─────────────▼─────────────┐                       │
│                          │  CloudFront               │  TLS, edge cache      │
│                          │   /assets/* → S3 (widget) │                       │
│                          │   /api/*    → Lambda FURL │                       │
│                          └──────┬───────────────┬────┘                       │
│                                 │               │                            │
│                    ┌────────────▼───┐    ┌──────▼────────────────────────┐   │
│                    │ S3: widget     │    │ Lambda: chat-api              │   │
│                    │ bundle (JS/CSS)│    │ RESPONSE_STREAM mode → SSE    │   │
│                    └────────────────┘    │ Node 22, ARM64, TypeScript    │   │
│                                          └──┬────┬────┬────┬────┬────────┘   │
│                        ┌────────────────────┘    │    │    │    │            │
│                        │        ┌────────────────┘    │    │    └──────────┐ │
│                        │        │        ┌────────────┘    │               │ │
│                        ▼        ▼        ▼                 ▼               ▼ │
│              ┌──────────────┐ ┌──────┐ ┌─────────────┐ ┌────────┐ ┌─────────┐│
│              │  DynamoDB    │ │ Bed- │ │  Pinecone   │ │Secrets │ │CloudWtch││
│              │  • sessions  │ │ rock │ │  Serverless │ │Manager │ │ + X-Ray ││
│              │  • messages  │ │      │ │ ns:knowledge│ │        │ │         ││
│              │  • products  │ │Sonnet│ │ ns:products │ │Shopify │ │ logs    ││
│              │    cache     │ │Haiku │ │             │ │  token │ │ metrics ││
│              │  • jobs      │ │Embed │ │             │ │Pinecone│ │ traces  ││
│              └──────────────┘ └──────┘ └─────────────┘ └────────┘ └─────────┘│
│                                                                              │
│  ── INGESTION (asynchronous, never in the request path) ───────────────────  │
│                                                                              │
│   S3 upload ──► EventBridge ──► Step Functions ──► Lambda: extract           │
│   (docs/raw/)                    state machine   ──► Lambda: chunk           │
│                                                  ──► Lambda: embed (Bedrock) │
│                                                  ──► Lambda: upsert (Pinecone)│
│                                          │                                   │
│                                          └──► SQS DLQ on failure             │
│                                                                              │
│   EventBridge Scheduler (nightly 03:00) ──► Step Functions: product-sync     │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         │ (3) live product hydration
                          ┌──────────────▼──────────────┐
                          │  Shopify Storefront API     │
                          │  (GraphQL) — price, stock,  │
                          │  variants, images, URLs     │
                          └─────────────────────────────┘
```

---

## 1.4 Request flow in one paragraph

A customer types into the widget. The widget POSTs to a path on the *Shopify* domain
(`/apps/nailzify-chat/message`), which Shopify's App Proxy forwards to our CloudFront
distribution after signing it with HMAC and attaching the logged-in customer ID. WAF
screens it, CloudFront routes `/api/*` to a Lambda Function URL running in response-stream
mode. The Lambda verifies the HMAC signature, loads the last N turns of the conversation
from DynamoDB, and calls Bedrock with a cached system prompt and a set of tool
definitions. The model decides which tools it needs — `search_knowledge_base` for policy
questions, `search_products` + `get_product_details` for recommendations — and the Lambda
executes them, hitting Pinecone and the Shopify Storefront API. Results go back to the
model, which composes an answer that streams token-by-token over SSE straight into the
widget. The turn is persisted to DynamoDB with a TTL. Total wall-clock: 1.5–3 seconds to
first token.

Phase 5 walks each of those steps in detail with a latency budget.

---

## 1.5 What is deliberately NOT in this architecture

Knowing what you left out — and why — is as much a part of design as what you put in.

| Not included | Why not |
|---|---|
| **VPC + NAT Gateway** | Lambdas talk only to AWS APIs and public HTTPS endpoints. A VPC would add ~$32/mo per NAT Gateway, cold-start ENI attachment latency, and operational burden, and buys us nothing since there's no private database. Add a VPC only when you introduce RDS/ElastiCache or a compliance requirement demands it. |
| **Kubernetes / ECS / Fargate** | Traffic is spiky and low-volume: a storefront chatbot is idle most of the day. Serverless bills you for requests, not idle capacity. Revisit at sustained >50 req/s where always-on containers become cheaper than per-invocation billing. |
| **Amazon OpenSearch Serverless** | The natural AWS-native vector store, and Bedrock Knowledge Bases' default. But its minimum billable capacity historically runs several hundred dollars per month whether you serve one query or a million — brutal for a small store. See Phase 2 for the full comparison and the migration path. |
| **A separate microservice per concern** | Premature. Four Lambdas with clean internal boundaries beat twelve Lambdas with a distributed-monolith call graph. Modularize the *code* (Phase 7); keep the *deployment* consolidated until a boundary demonstrably needs independent scaling. |
| **Fine-tuning a model** | RAG solves knowledge injection. Fine-tuning solves *behaviour and format*, not facts — and a fine-tuned model still can't know today's price. Almost never the right first move. |
| **Conversation memory across sessions** | Phase 1 scope is per-session memory. Cross-session personalization needs a customer identity story and a privacy review — it's Phase 12. |

---

## 1.6 Design principles this system holds to

1. **The model is a renderer, not a database.** Every fact in an answer traces to a tool
   result from this turn. If no tool returned it, the model says it doesn't know.
2. **Volatile data is never embedded.** Prices, inventory, and promotions are fetched
   live. Only stable descriptive text goes into vectors.
3. **Nothing expensive happens in the request path.** Parsing, chunking, and embedding are
   asynchronous. A customer never waits on a PDF.
4. **The blast radius of a bad answer is bounded.** The bot can read; it cannot write. It
   has no tool that mutates an order, a customer record, or inventory.
5. **Every external dependency has a failure mode with a defined behaviour.** Pinecone
   down → degrade to product-free policy answers. Shopify down → "I can't check stock
   right now." Never a stack trace, never a confident guess.

---

## 1.7 Concepts introduced here

**RAG (Retrieval-Augmented Generation)** — instead of hoping a model memorized your
shipping policy during training, you retrieve the relevant passage at question time and
paste it into the prompt. The model's job shifts from *recall* to *reading comprehension*,
which it is dramatically better at. RAG is not a model feature; it is a system you build
around the model.

**Embedding** — a function that maps text to a fixed-length vector of floats such that
semantically similar text lands nearby in that space. "How long do press-ons last?" and
"press-on nail wear time" produce vectors close to each other even with zero shared words.
This is why semantic search beats keyword search for natural questions. Phase 3 goes deep.

**Tool use / function calling** — you describe functions to the model in JSON Schema; it
responds not with prose but with a structured request to call one. Your code executes it
and returns the result. This is the mechanism that lets a language model touch live
systems safely — *you* control what functions exist and what they're allowed to do.

**Grounding** — the property that every claim in a generated answer is supported by
provided source material. Achieved through architecture (only give the model true facts)
plus prompting (instruct it to abstain) plus verification (Phase 4). Not achievable
through prompting alone.

---

Next: [Phase 2 — AWS services](02-aws-services.md)
