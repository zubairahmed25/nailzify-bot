# Phase 6 — Database Design

Three stores, three jobs:

| Store | Holds | Truth for |
|---|---|---|
| **DynamoDB** | Sessions, messages, product cache, ingestion jobs, feedback | Conversation state |
| **Pinecone** | Vectors + retrieval metadata | Nothing — it's an *index*, not a database |
| **Shopify** | Products, prices, inventory, orders | All commerce data |

That third row is the design's spine. **Shopify is the system of record for commerce, and
we never try to become a second one.** Every caching decision below is subordinate to
that.

---

## 6.1 DynamoDB single-table design

### Why one table

The instinct from relational modelling is one table per entity. DynamoDB inverts this,
and the reasoning is worth internalizing because it's the main conceptual jump when
learning NoSQL:

DynamoDB has no joins. In a relational model you normalize, then join at query time. In
DynamoDB you **pre-join at write time** by co-locating related items under the same
partition key. Loading a session and all its messages is then *one query*, not a join, not
N round trips.

```
PK = SESSION#01JQZ...   SK = META              ← session metadata
PK = SESSION#01JQZ...   SK = MSG#1712...#001   ← first message
PK = SESSION#01JQZ...   SK = MSG#1712...#002   ← second message
```

One `Query` on `PK = SESSION#01JQZ...` returns all of it, sorted, in ~10 ms. That is the
payoff, and it's why the schema looks strange at first.

**When single-table is the wrong call:** if your access patterns are genuinely unknown or
change weekly, the rigidity hurts — a new query shape can require a new GSI or a backfill.
For this system the patterns are known and stable, so the trade is clearly favourable.

### Access patterns (derive the schema from these, never the reverse)

| # | Pattern | Key |
|---|---|---|
| 1 | Load conversation history | `Query PK = SESSION#<id>, SK begins_with MSG#`, limit 20, desc |
| 2 | Get session metadata | `GetItem PK = SESSION#<id>, SK = META` |
| 3 | Append a message | `PutItem` |
| 4 | Expire old sessions | TTL — no code |
| 5 | Get cached product metadata | `GetItem PK = PRODUCT#<id>, SK = META` |
| 6 | Get ingestion job status | `GetItem PK = JOB#<id>, SK = META` |
| 7 | List a customer's sessions | GSI1: `PK = CUSTOMER#<id>` |
| 8 | Recent feedback for review | GSI2: `PK = FEEDBACK#<yyyy-mm-dd>` |

Patterns 7 and 8 need a different partition key than the base table, which is exactly what
a Global Secondary Index is for. **Every GSI is a full copy of the projected attributes**
with its own write cost — add one only when an access pattern demands it, and project only
the attributes you actually read (`KEYS_ONLY` or `INCLUDE`, rarely `ALL`).

### Table: `nailzify-app`

```
Partition key : PK  (string)
Sort key      : SK  (string)
Billing       : PAY_PER_REQUEST          ← on-demand; ~free at low traffic
TTL attribute : expiresAt                ← epoch seconds
PITR          : enabled                  ← point-in-time recovery, 35 days
Encryption    : AWS-managed KMS
GSI1          : GSI1PK / GSI1SK          ← customer → sessions
GSI2          : GSI2PK / GSI2SK          ← date → feedback
```

**On-demand vs provisioned:** on-demand costs more per request but nothing when idle, and
requires no capacity planning. At a few thousand requests a month the bill is under a
dollar. Switch to provisioned with auto-scaling only when sustained traffic makes the
per-request premium exceed the reserved cost — a good problem to have.

### Item shapes

**Session metadata**
```jsonc
{
  "PK": "SESSION#01JQZ8K2M4",
  "SK": "META",
  "entityType": "Session",
  "createdAt":  "2026-07-26T14:02:11Z",
  "lastActiveAt": "2026-07-26T14:09:47Z",
  "customerId": "gid://shopify/Customer/7712",   // null if not logged in
  "shopDomain": "nailzify.myshopify.com",
  "locale": "en-US",
  "turnCount": 6,
  "tokensUsed": 14320,
  "summary": "Customer is looking for short almond nails for a September wedding, budget under $25. Has narrow nail beds.",
  "version": 6,                                   // optimistic concurrency
  "escalated": false,
  "expiresAt": 1756...                            // +30 days

  // GSI1 — list a customer's sessions
  "GSI1PK": "CUSTOMER#gid://shopify/Customer/7712",
  "GSI1SK": "SESSION#2026-07-26T14:02:11Z"
}
```

`summary` is the rolling compression of turns older than the recent window (Phase 5.5). It
is what keeps prompt size — and therefore cost — bounded on a long conversation.

**Message**
```jsonc
{
  "PK": "SESSION#01JQZ8K2M4",
  "SK": "MSG#2026-07-26T14:09:47.221Z#0007",
  "entityType": "Message",
  "messageId": "01JQZ9...",           // client-generated, for idempotency
  "role": "assistant",
  "content": "Our sizing guide recommends measuring...",
  "createdAt": "2026-07-26T14:09:47.221Z",

  // Provenance — this is what makes bad answers debuggable weeks later
  "toolCalls": [
    { "name": "search_knowledge_base", "input": { "query": "nail sizing measurement" },
      "latencyMs": 214, "resultCount": 4 }
  ],
  "retrievedChunkIds": ["sizing-guide#s1#c0", "sizing-guide#s1#c1"],
  "citations": [{ "sourceId": 1, "documentId": "sizing-guide", "page": 1 }],
  "model": "anthropic.claude-sonnet-5",
  "usage": { "inputTokens": 3211, "outputTokens": 187, "cacheReadInputTokens": 2890 },
  "latencyMs": 1840,
  "expiresAt": 1756...
}
```

**The `retrievedChunkIds` field is the highest-value debugging attribute in the schema.**
When a customer reports a wrong answer, you can reconstruct exactly what the model was
shown. Without it you're guessing at a non-deterministic system, which is not debugging.

The sort key `MSG#<ISO-timestamp>#<zero-padded-seq>` sorts lexicographically in
chronological order. The sequence suffix breaks ties when two messages land in the same
millisecond — a rare-but-real ordering bug if you use the timestamp alone.

**Product cache** — display metadata only, never authoritative pricing
```jsonc
{
  "PK": "PRODUCT#gid://shopify/Product/8123",
  "SK": "META",
  "entityType": "ProductCache",
  "handle": "autumn-almond-short",
  "title": "Autumn Almond — Short",
  "shape": "almond",
  "length": "short",
  "finish": "matte",
  "occasions": ["everyday", "professional"],
  "priceBand": "15-25",              // coarse bucket for filtering, NOT for display
  "imageUrl": "https://cdn.shopify.com/...",
  "productUrl": "https://nailzify.com/products/autumn-almond-short",
  "lastSyncedAt": "2026-07-26T03:00:00Z",
  "embeddingVersion": "cohere-embed-v4-2026-07"
}
```

> ⚠️ **No `price` field. No `inventoryQuantity` field.** Not "cached with a short TTL" —
> *absent*. If the attribute doesn't exist, no future maintainer can accidentally read it
> and render a stale price. The schema enforces the architecture. This is worth more than
> a comment saying "don't use this."

**Ingestion job**
```jsonc
{
  "PK": "JOB#0f3a91c2",
  "SK": "META",
  "entityType": "IngestionJob",
  "documentId": "shipping-policy",
  "sourceUri": "s3://nailzify-documents/raw/policies/shipping-policy.pdf",
  "status": "COMPLETED",             // PENDING|EXTRACTING|CHUNKING|EMBEDDING|INDEXING|COMPLETED|FAILED
  "chunkCount": 34,
  "vectorsUpserted": 34,
  "checksum": "sha256:9f2c...",       // skip re-ingest if unchanged
  "startedAt": "2026-07-26T03:00:02Z",
  "completedAt": "2026-07-26T03:01:44Z",
  "error": null,
  "expiresAt": 1764...                // 90 days
}
```

**Feedback**
```jsonc
{
  "PK": "SESSION#01JQZ8K2M4",
  "SK": "FEEDBACK#2026-07-26T14:10:02Z",
  "entityType": "Feedback",
  "messageSK": "MSG#2026-07-26T14:09:47.221Z#0007",
  "rating": "down",
  "comment": "This didn't answer my question",
  "GSI2PK": "FEEDBACK#2026-07-26",
  "GSI2SK": "down#14:10:02Z"
}
```

Thumbs up/down is the cheapest quality signal you will ever collect, and thumbs-down items
are your best source of new eval-set questions. GSI2 partitions by date so a daily review
job reads one partition.

---

## 6.2 TTL strategy

| Item | TTL | Rationale |
|---|---|---|
| Session metadata | 30 days | Long enough to investigate a complaint |
| Message | 30 days | Same; also a data-minimization posture |
| Ingestion job | 90 days | Operational history |
| Product cache | none | Overwritten by the nightly sync |
| Feedback | none | Training/eval signal — keep it |

**Why TTL matters beyond tidiness.** Customer messages are personal data. Automatic
expiry is a GDPR/CCPA data-minimization control implemented as a table attribute rather
than a cron job you have to remember to write. Deletion is free and doesn't consume write
capacity.

**Caveat:** DynamoDB TTL deletion is *eventually* consistent — items can linger up to 48
hours past expiry. If you need hard guarantees for a deletion request, delete explicitly
rather than relying on TTL.

---

## 6.3 Pinecone schema

```
Index      : nailzify-prod
Dimension  : 1024                 (must exactly match the embedding model)
Metric     : cosine
Cloud      : AWS us-east-1        (co-located with Lambda — cuts ~30 ms)
Namespaces : knowledge | products
```

**Knowledge vector**
```jsonc
{
  "id": "returns-policy#s3#c2",     // {documentId}#{section}#{chunk} — deterministic
  "values": [/* 1024 floats */],
  "metadata": {
    "text": "Items must be returned in original packaging...",
    "contextHeader": "[Nailzify Return Policy — Section 3: Condition Requirements...]",
    "documentId": "returns-policy",
    "title": "Return Policy",
    "section": "Condition Requirements",
    "page": 3,
    "docType": "policy",
    "topics": ["returns", "condition"],
    "version": "2026-03-01",
    "embeddingModel": "cohere.embed-v4:0"
  }
}
```

**Product vector**
```jsonc
{
  "id": "gid://shopify/Product/8123",
  "values": [/* 1024 floats */],
  "metadata": {
    "productId": "gid://shopify/Product/8123",
    "handle": "autumn-almond-short",
    "title": "Autumn Almond — Short",
    "shape": "almond",
    "length": "short",
    "finish": "matte",
    "occasions": ["everyday", "professional"],
    "priceBand": "15-25",
    "embeddingModel": "cohere.embed-v4:0"
    // no price, no inventory — see 6.1
  }
}
```

**Metadata design rules:**

- Only store what you **filter on** or **display**. Metadata counts against storage cost
  and, in some engines, against query performance.
- Keep values low-cardinality for filters — `shape: "almond"` filters well;
  `description: "<800 words>"` does not and shouldn't be a filter field.
- `embeddingModel` on every vector makes a model migration auditable: you can query for
  vectors still on the old model instead of guessing.
- Store the **original** `text` for display, not the contextualized version you embedded.

---

## 6.4 Consistency model

Different data has different freshness requirements, and matching them deliberately is
most of what "data modelling" means in practice.

| Data | Consistency | Why |
|---|---|---|
| Price, inventory | **Strong — live fetch, every time** | Wrong here = a broken customer promise |
| Product existence | Live fetch | Deleted products must vanish immediately |
| Product descriptive attributes | Eventual (~24 h) | A tag typo fixed today can surface tomorrow |
| Policy documents | Eventual (minutes after upload) | Policies change rarely |
| Conversation history | Strongly consistent read within a session | Turn N must see turn N−1 |
| Product cache | Eventual | Display metadata only, never a fact the customer relies on |

Use `ConsistentRead: true` on the history query. It costs double the read units, and at
this volume that's fractions of a cent — cheap insurance against a customer seeing the bot
forget the message they just sent.

---

## 6.5 Backup and recovery

| Store | Mechanism | RPO |
|---|---|---|
| DynamoDB | Point-in-time recovery (35 days) + on-demand backups before schema changes | ~5 min |
| Pinecone | **Rebuildable from S3** — the source documents are the real backup | Full re-ingest, ~30 min |
| S3 documents | Versioning + cross-region replication for prod | ~15 min |

Pinecone is the interesting row. **We deliberately don't back it up.** Vectors are derived
data — a pure function of (source documents, chunking config, embedding model). As long as
S3 has the documents and the pipeline is in git, the index is reproducible. Backing up
derived data is usually a smell; make it reproducible instead.

This is the same reasoning that says you don't back up `node_modules`. It's also what makes
"change the embedding model" a routine operation rather than a crisis.

---

## 6.6 Data protection

- **Encryption at rest** — DynamoDB (KMS), S3 (SSE-S3 or SSE-KMS), Pinecone (provider-managed).
- **Encryption in transit** — TLS everywhere, no exceptions.
- **PII minimization** — store `customerId` (an opaque Shopify GID), never name, email, or
  address. If a customer types their address into chat, redact it before persisting.
- **Deletion request** — one query on GSI1 (`CUSTOMER#<id>`) returns every session; delete
  the partitions. Design for this on day one; retrofitting it is painful.
- **Vector store contains company text** — Pinecone metadata holds your policy content.
  Include it in your data inventory and vendor review.

---

Next: [Phase 7 — Backend structure](07-backend.md)
