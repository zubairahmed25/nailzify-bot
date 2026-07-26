# Phase 4 — RAG Retrieval Pipeline

Ingestion built the index. Retrieval decides what actually reaches the model. Two
failure modes to design against, and they pull in opposite directions:

- **Low recall** — the answer exists in your corpus but retrieval missed it. The bot says
  "I don't know" about something you documented. Annoying, visible, fixable.
- **Low precision** — retrieval returned mostly irrelevant chunks. The right answer is in
  there, buried in noise, and the model latches onto the wrong passage. **This is worse**,
  because the bot answers confidently and wrongly, and nobody notices until a customer
  complains.

Everything below is in service of maximizing both, and of making the model abstain when
neither is achievable.

---

## 4.1 The pipeline

```
customer message
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. QUERY UNDERSTANDING                                      │
│    • resolve pronouns against history ("does IT come in...")│
│    • classify intent → which plane(s) to search             │
│    • extract structured filters (shape, length, budget)     │
│    • generate query variants (multi-query)                  │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
        ┌──────────────────┴──────────────────┐
        ▼                                     ▼
┌───────────────────────┐          ┌──────────────────────────┐
│ 2a. KNOWLEDGE PLANE   │          │ 2b. CATALOG PLANE        │
│  hybrid search        │          │  vector search           │
│   • dense (vector)    │          │   + metadata filters     │
│   • sparse (BM25)     │          │   → product IDs only     │
│   • RRF fusion        │          │           ↓              │
│  → top 20 candidates  │          │  Shopify Storefront API  │
└───────────┬───────────┘          │  → live price/stock/URL  │
            ▼                      └────────────┬─────────────┘
┌───────────────────────┐                       │
│ 3. RERANK             │                       │
│  cross-encoder or LLM │                       │
│  → top 4              │                       │
└───────────┬───────────┘                       │
            └───────────────┬───────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. CONTEXT ASSEMBLY                                         │
│    ordered, labelled, token-budgeted, citation-tagged       │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. GENERATION  (Bedrock, streaming)                         │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 6. GROUNDING VERIFICATION (async, sampled)                  │
└─────────────────────────────────────────────────────────────┘
```

---

## 4.2 Step 1 — Query understanding

The raw customer message is usually a bad search query. Three transformations:

### Pronoun and context resolution

```
Turn 1: "Do you have almond shaped nails?"
Turn 2: "Do those come in short?"
```

Embedding `"Do those come in short?"` retrieves nothing useful — the query has no content
words. Rewrite against conversation history first:

```
→ "Do almond shaped press-on nails come in short length?"
```

Implementation: a fast Haiku 4.5 call with the last 4 turns, or a rules-based rewriter for
common patterns. ~200 ms and it fixes the single most common multi-turn failure. Skip it
and your bot appears to have amnesia on turn 2 of every conversation.

### Intent classification

Route to the right plane. A cheap Haiku classification, or let the main model decide via
tool selection (simpler, one fewer hop — see §4.7):

| Intent | Planes | Example |
|---|---|---|
| `policy` | knowledge | "What's your return window?" |
| `product_discovery` | catalog | "Something for a wedding, short and neutral" |
| `product_specific` | catalog | "Is the Autumn Almond set in stock?" |
| `how_to` | knowledge | "How do I remove them without damage?" |
| `mixed` | both | "Can I return these if the size is wrong?" |
| `chitchat` | none | "hi" |
| `escalate` | none | "I want a refund on order #1234" → hand to human |

`chitchat` matters more than it looks: not retrieving is a valid and cheap outcome. A bot
that runs a vector search on "hi" is wasting money and adding latency.

`escalate` matters most. The bot must know its own boundary. Anything touching a specific
order, a payment, or a complaint goes to a human. Define this explicitly — a concierge
that tries to handle a refund dispute is a liability.

### Filter extraction

```
"short almond nails for a wedding under $20"
→ query: "short almond press-on nails wedding elegant"
→ filters: { shape: "almond", length: "short", occasion: "bridal",
             priceBand: ["under-15", "15-25"] }
```

Metadata pre-filtering shrinks the candidate space before vector search runs, which
raises precision substantially. Use structured output (JSON Schema) so extraction is
reliable rather than a parsing exercise.

---

## 4.3 Step 2a — Hybrid search on the knowledge plane

**Why not pure vector search?** Semantic search is excellent at meaning and surprisingly
bad at exact tokens. Ask about "SKU NZ-4471" or "Klarna" or "30-day" and the dense vector
may drift to something *topically* similar while missing the literal match. Meanwhile
BM25 (classic keyword scoring) nails exact terms and completely misses paraphrase.

They fail in opposite directions, which is exactly why you combine them.

| Method | Strong at | Blind to |
|---|---|---|
| Dense (vector) | Paraphrase, synonyms, intent | Rare exact tokens, SKUs, proper nouns, numbers |
| Sparse (BM25) | Exact terms, product codes, names | "wear time" vs "how long do they last" |
| **Hybrid (both)** | Both | Costs one extra query |

**Fusion — use Reciprocal Rank Fusion (RRF):**

```
score(d) = Σ  1 / (k + rank_i(d))       k = 60 conventionally
        over each retrieval method i
```

RRF combines *ranks*, not *scores*. That's the key property: cosine similarity and BM25
scores live on incompatible scales, and normalizing them requires tuning a weight you'll
never get right across all query types. Ranks are directly comparable. RRF is
parameter-light, robust, and consistently beats hand-tuned weighted score blending.

**Implementation note.** Pinecone Serverless supports sparse vectors, so hybrid can live
in one system. If that proves awkward, run BM25 in-process over a document-title/section
index (the corpus is small enough — tens of thousands of chunks fit comfortably in Lambda
memory) and fuse in application code. Start with dense-only, add sparse when your eval set
shows the exact-match failure mode. **Don't build hybrid before you've measured that you
need it.**

---

## 4.4 Step 3 — Reranking

**The problem.** A single vector must compress an entire chunk's meaning into 1024 floats
*before it has seen your question*. That's a lossy compression optimized for the average
case. It's fast (it's why vector search scales), but it's approximate.

**The fix.** Take the top ~20 candidates and score each one against the query with a model
that reads *both together*. A cross-encoder attends to the query and the document jointly,
so it can tell that a chunk mentioning "returns" is actually about *exchange* eligibility,
not *return* eligibility — a distinction a bi-encoder's independent embeddings routinely
miss.

```
        Bi-encoder (retrieval)              Cross-encoder (reranking)
   embed(query) ─┐                      ┌── [query + document] ──┐
                 ├─ cosine → score      │       one model        │→ relevance
   embed(doc)  ──┘                      └───────────────────────┘
   ✅ precompute docs, fast              ❌ must run per pair, slow
   ❌ never sees them together           ✅ full cross-attention
```

**Options:**

| Approach | Latency | Notes |
|---|---|---|
| **Cohere Rerank** | ~100 ms | Purpose-built, excellent quality. Check current Bedrock availability in your region; otherwise call Cohere directly. |
| **LLM reranking (Haiku 4.5)** | ~300 ms | Prompt Haiku to score 20 candidates 0–10 with structured output. Works everywhere, more expensive, more flexible. |
| Skip reranking | 0 ms | Acceptable *only* if you retrieve k=4 directly and your eval set says quality holds. |

**Decision: retrieve 20 → rerank → keep top 4.** Reranking is typically the second-largest
single-step quality gain in a RAG system after contextual chunking. The retrieve-wide-then-
narrow pattern lets you set the vector search's recall generously without paying for the
precision loss.

**Also apply a relevance floor.** If the top reranked score is below a threshold, return
*nothing* and let the model say it doesn't know. Returning four weakly-relevant chunks is
strictly worse than returning zero — it invites the model to construct an answer from
material that doesn't contain one. This threshold is one of your most important
anti-hallucination knobs; tune it on your eval set.

---

## 4.5 Step 2b — Catalog retrieval and hydration

The two-plane rule made concrete:

```ts
// 1. Semantic shortlist — vectors, filters, IDs only.
const candidates = await vectorStore.query({
  namespace: "products",
  vector: await embed(rewrittenQuery, "search_query"),
  filter: { shape: "almond", length: "short", priceBand: { $in: ["under-15", "15-25"] } },
  topK: 12,
});
// candidates → [{ productId: "gid://shopify/Product/8123", score: 0.81 }, ...]

// 2. Hydrate from the source of truth. THIS is where price comes from.
const products = await shopify.getProductsByIds(candidates.map(c => c.productId));
// → { title, handle, url, image, priceRange, availableForSale,
//     variants: [{ title, price, availableForSale, quantityAvailable }] }

// 3. Filter on live truth, not on indexed truth.
const inStock = products.filter(p => p.availableForSale);

// 4. Only hydrated, in-stock products are ever shown to the model.
return inStock.slice(0, 4);
```

Four properties fall out of this, and each one is a bug class you never have to fix:

1. **Prices are always current.** They come from Shopify in this request.
2. **Sold-out products never get recommended.** Filtered on live availability.
3. **Deleted products degrade gracefully.** Shopify returns nothing for the ID; it drops
   out of the list. A stale vector cannot resurrect a dead product.
4. **The model physically cannot invent a price**, because the only price in its context
   arrived from Shopify moments ago.

**Performance.** Batch the hydration into one GraphQL call (`nodes(ids: [...])`), not N
calls. Cache Shopify responses in DynamoDB with a short TTL (60–120 s) — enough to absorb
a burst of similar questions, short enough that a price change surfaces almost
immediately. **Do not cache longer than a couple of minutes**; the whole point is
freshness.

**Failure mode.** If Shopify is unreachable, do **not** fall back to cached prices in the
answer. Say "I'm having trouble checking current pricing — here's the product page" and
link out. Degrading to a stale price is exactly the failure this architecture exists to
prevent, and it would be perverse to reintroduce it in the error path.

---

## 4.6 Step 4 — Context assembly

How you format retrieved material measurably affects answer quality.

```xml
<retrieved_knowledge>
  <source id="1" document="Return Policy" section="Eligibility" page="2">
    Returns are accepted within 30 days of delivery. Products must be unopened
    and in original packaging with all seals intact.
  </source>
  <source id="2" document="Sizing Guide" section="Measuring" page="1">
    Measure the widest part of each nail bed in millimetres...
  </source>
</retrieved_knowledge>

<live_products>
  <product id="A" handle="autumn-almond-short">
    <title>Autumn Almond — Short</title>
    <price currency="USD">18.00</price>
    <availability>in_stock</availability>
    <url>https://nailzify.com/products/autumn-almond-short</url>
    <attributes>shape: almond | length: short | finish: matte</attributes>
  </product>
</live_products>
```

**Why this shape:**

- **XML-ish tags** delimit sections unambiguously. Claude handles structured delimiters
  well, and it makes "cite source 1" a precise instruction rather than a hopeful one.
- **Separate blocks** for knowledge vs. live products, so the system prompt can hold them
  to different rules ("you may paraphrase knowledge; you must quote product facts exactly").
- **IDs** enable inline citations and post-hoc verification.
- **Explicit `<availability>`** means the model doesn't infer stock from prose.

**Ordering matters — the "lost in the middle" effect.** Models attend most reliably to
the beginning and end of a long context, and least reliably to the middle. With only 4
chunks it's a minor effect; if you ever expand to 10+, put the highest-ranked material
first and last, and the weakest in the middle.

**Token budget.** Cap retrieved context at ~2,500 tokens. Then measure whether more helps
— on most eval sets, going from 4 chunks to 10 costs 2.5× the input tokens for a small
single-digit accuracy change. That is a bad trade at scale.

---

## 4.7 Step 5 — Generation and the tool interface

**Design choice: let the model drive retrieval via tools, rather than always retrieving
before generating.**

The classic RAG shape is *always retrieve, then generate*. Giving the model tools instead
means it retrieves only when it needs to, can issue multiple targeted searches, and can
chain (search products → get details on one). It costs an extra round trip on turns that
need retrieval, and saves an entire retrieval on turns that don't ("hi", "thanks", "the
second one please").

### The tool surface

Deliberately small. Every tool is a permission you're granting, and the tool set defines
the maximum blast radius of a prompt-injection attack.

```jsonc
[
  {
    "name": "search_knowledge_base",
    "description": "Search Nailzify company documents — shipping policy, returns policy, sizing guide, nail care instructions, and FAQs. Call this whenever the customer asks about policies, procedures, shipping, returns, sizing, application, or care. Do not answer policy questions from memory.",
    "input_schema": {
      "type": "object",
      "properties": {
        "query":   { "type": "string", "description": "Natural-language search query" },
        "docType": { "type": "string", "enum": ["policy", "guide", "faq"] }
      },
      "required": ["query"],
      "additionalProperties": false
    }
  },
  {
    "name": "search_products",
    "description": "Find press-on nail products matching customer preferences. Returns live product data including current price and stock. Call this for any product discovery or recommendation request.",
    "input_schema": {
      "type": "object",
      "properties": {
        "query":     { "type": "string" },
        "shape":     { "type": "string", "enum": ["almond","coffin","square","stiletto","oval","squoval"] },
        "length":    { "type": "string", "enum": ["short","medium","long","extra-long"] },
        "occasion":  { "type": "string", "enum": ["everyday","bridal","party","professional","holiday"] },
        "maxPrice":  { "type": "number" },
        "style":     { "type": "string" }
      },
      "required": ["query"],
      "additionalProperties": false
    }
  },
  {
    "name": "get_product_details",
    "description": "Get full live details for one product by handle — all variants, per-variant stock, sizes, and current price.",
    "input_schema": {
      "type": "object",
      "properties": { "handle": { "type": "string" } },
      "required": ["handle"],
      "additionalProperties": false
    }
  },
  {
    "name": "escalate_to_human",
    "description": "Hand off to a human agent. Call this for order-specific issues, refund requests, complaints, damaged goods, or anything you cannot resolve from documentation.",
    "input_schema": {
      "type": "object",
      "properties": {
        "reason":  { "type": "string" },
        "summary": { "type": "string", "description": "Summary of the conversation for the agent" }
      },
      "required": ["reason", "summary"],
      "additionalProperties": false
    }
  }
]
```

**Tool design principles this reflects:**

1. **Descriptions are prompts.** The model chooses tools almost entirely from the
   description. `"Do not answer policy questions from memory"` inside the description does
   more work than the same sentence in the system prompt, because it's attached to the
   decision point. Be prescriptive about *when* to call, not just what it does.
2. **Enums over free text.** `shape: "almond"` is filterable. `shape: "kind of pointy"`
   is not. Constrain the model's output to your data model's vocabulary.
3. **`strict: true` + `additionalProperties: false`** guarantees the arguments validate
   against your schema — no defensive parsing in the handler.
4. **Every tool is read-only.** There is no `cancel_order`, no `apply_discount`, no
   `update_customer`. A perfectly executed prompt injection against this agent can, at
   worst, search your public product catalog. **This is the security boundary that
   matters**, and it's enforced by IAM and tool definitions, not by asking the model
   nicely.
5. **Small surface.** Four tools. Every tool you add makes selection harder and the prompt
   longer. Add a fifth only when you can name the customer question it unblocks.

### The system prompt

Structure it in layers, stable content first so it caches:

```
1. Identity & scope       — who you are, what Nailzify sells, what you don't do
2. Grounding rules        — the hard constraints (below)
3. Tool guidance          — when to reach for what
4. Recommendation method  — how to reason about shape/length/occasion/skin tone
5. Tone & format          — brand voice, length, formatting, emoji policy
6. Escalation triggers    — when to hand off to a human
```

The grounding rules, which are the load-bearing part:

```
- Never state a price, stock level, or product detail that did not come from a
  tool result in this conversation. If you have not called a tool, you do not
  know the price.
- Never state a policy detail that did not come from search_knowledge_base.
- If retrieval returns nothing relevant, say you don't have that information and
  offer to connect the customer with the team. Do not construct a plausible answer.
- Cite the source document when answering a policy question.
- Product recommendations must come only from search_products results in this turn.
  Never recommend a product from memory or from an earlier conversation.
- If a customer asks about their specific order, payment, or a complaint, call
  escalate_to_human. Do not attempt to resolve it.
```

**Prompt caching.** Sections 1–6 plus the tool definitions are byte-stable across every
request. Mark the end of that block with `cache_control` and repeated turns bill the
prefix at ~0.1×. Two Bedrock-specific cautions:

- **Bedrock does not support top-level automatic caching** — place `cache_control` on the
  specific content block manually.
- **The minimum cacheable prefix is model-dependent**: ~1024 tokens for Sonnet 5, ~4096
  for Haiku 4.5. Below the minimum it silently doesn't cache. Verify with
  `usage.cache_read_input_tokens` — if it's zero across repeated requests, something in
  your prefix is changing (a timestamp, a session ID, unsorted JSON) or you're under the
  minimum.

**The single most common caching bug:** interpolating the current date or a session ID
into the system prompt. That one byte change invalidates the entire cached prefix on every
request. Put volatile values in the *user* turn, after the last cache breakpoint.

---

## 4.8 Step 6 — Grounding verification

Prompts and architecture make hallucination unlikely. Verification tells you when it
happened anyway.

**Async, sampled (~5% of turns), out of the request path:**

1. Take the generated answer and the retrieved context.
2. Ask a cheap model: *"Is every factual claim in this answer supported by the provided
   sources? List any unsupported claims."*
3. Log the result as a CloudWatch metric. Alarm if the unsupported-claim rate crosses a
   threshold.

This is an **LLM-as-judge** evaluator. It's imperfect — it will disagree with a human
sometimes — but it turns "we think the bot is accurate" into a number you can watch on a
dashboard and regression-test against. That shift is the point.

**What FAANG does differently:** the same idea, industrialized. A golden eval set run on
every prompt change in CI, offline judges plus human review on a sampled slice, and
online metrics (deflection rate, escalation rate, thumbs-down rate) as the real signal.
The engineering discipline is treating prompt and retrieval changes as **code changes that
require passing tests** — not as tweaks you eyeball once and ship. Build the eval set
early; it's the artifact that lets you improve the system deliberately instead of by vibes.

---

## 4.9 What to measure

| Metric | How | Target |
|---|---|---|
| Recall@5 | Eval set: is the gold chunk in the top 5? | > 0.90 |
| Precision@4 | Fraction of returned chunks that are relevant | > 0.75 |
| Retrieval latency p95 | X-Ray subsegment | < 400 ms |
| Time to first token | Client-side timing | < 1.2 s |
| Grounding pass rate | Sampled LLM judge | > 0.95 |
| Abstention rate | "I don't know" / total | 5–15% (0% means it's making things up) |
| Escalation rate | `escalate_to_human` calls / conversations | monitor for drift |
| Tokens per conversation | Bedrock usage | drives cost |

**On abstention rate:** a bot that never says "I don't know" is not a well-informed bot,
it's an overconfident one. Some non-zero abstention rate is a health signal, not a defect.

---

Next: [Phase 5 — Chat request lifecycle](05-chat-lifecycle.md)
