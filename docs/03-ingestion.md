# Phase 3 — Data Ingestion Pipeline

> **The rule:** nothing in this phase happens while a customer is waiting. Ingestion is
> entirely asynchronous. If a customer ever waits on a PDF parse, the design is wrong.

Retrieval quality is capped by ingestion quality. You cannot fix bad chunking with a
better model or a cleverer prompt — if the sentence answering the question got split
across two chunks, no amount of prompt engineering recovers it. **This is the phase where
RAG systems are actually won or lost**, and it's the phase most tutorials skip in four
lines. Spend your time here.

---

## 3.1 Pipeline overview

```
   ┌─────────────────────────────────────────────────────────────────┐
   │  Admin uploads shipping-policy.pdf                              │
   │  → S3: nailzify-documents/raw/policies/shipping-policy.pdf      │
   └────────────────────────────┬────────────────────────────────────┘
                                │ S3 ObjectCreated event
                                ▼
                         ┌──────────────┐
                         │ EventBridge  │
                         └──────┬───────┘
                                ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │  Step Functions: DocumentIngestion                              │
   │                                                                 │
   │   1. Extract   ──► text + structure + page numbers              │
   │        ↓                                                        │
   │   2. Normalize ──► clean whitespace, drop headers/footers        │
   │        ↓                                                        │
   │   3. Chunk     ──► structure-aware splits + overlap             │
   │        ↓                                                        │
   │   4. Enrich    ──► contextual header per chunk (LLM), metadata  │
   │        ↓                                                        │
   │   5. Embed     ──► Bedrock, batched  (Map state, concurrency 5) │
   │        ↓                                                        │
   │   6. Upsert    ──► Pinecone ns:knowledge  +  DynamoDB job state │
   │        ↓                                                        │
   │   7. Verify    ──► smoke-query the new chunks, record metrics   │
   │                                                                 │
   │   any failure ──► SQS DLQ + CloudWatch alarm                    │
   └─────────────────────────────────────────────────────────────────┘
```

The product-catalog pipeline is the same machine with a different source (Shopify
GraphQL instead of S3) and a different target namespace. Phase 3.8.

---

## 3.2 Step 1 — Extraction

**Problem.** A PDF is a page-description format, not a document format. Its internal
representation is "draw this glyph at this coordinate." Naive extraction of a
two-column sizing chart returns interleaved nonsense.

**Options, ranked by how much they cost and how much they help:**

| Approach | Quality | Cost | Use when |
|---|---|---|---|
| `pdf-parse` / `pdfjs-dist` (Node) | Fine for single-column prose | Free | Text-native, simple layout — most policy docs |
| **Amazon Textract** | Excellent — tables, forms, reading order, layout blocks | ~$1.50 / 1000 pages | Sizing charts, scanned docs, multi-column |
| **Claude vision via Bedrock** | Excellent, and *interprets* rather than transcribes | ~$3–8 / 1000 pages | Complex diagrams, nail-shape illustrations |
| Unstructured.io | Very good, many formats | Free (OSS) / paid | Heterogeneous corpora |

**Decision: `pdf-parse` first, Textract when a document contains tables.** Route on a
cheap heuristic — if extracted text has a low character-to-page ratio (suggesting an
image-based PDF) or the filename/prefix marks it as a chart, send it to Textract.

That heuristic matters for Nailzify specifically: **your sizing guide is almost certainly
a table**, and a mangled sizing table is the single most damaging extraction failure in
this corpus. Getting "size M = 14mm" wrong produces a customer with nails that don't fit.

**Preserve during extraction:**
- Page number → citations become "Shipping Policy, p. 2", which is checkable
- Heading hierarchy → feeds contextual enrichment in step 4
- Table structure as markdown → LLMs read markdown tables reliably
- `sourceUri`, `documentTitle`, `lastModified`

**Concept — why extraction quality compounds.** Every downstream stage inherits
extraction errors and cannot detect them. A garbled table produces a plausible-looking
embedding of garbled text, which retrieves confidently for size questions, and the model
faithfully renders nonsense. **Garbage in, confidently-worded garbage out.** Budget real
time here.

---

## 3.3 Step 2 — Normalization

Cheap, unglamorous, high-return:

- Collapse runs of whitespace and stray newlines mid-sentence
- Strip repeated headers/footers ("Nailzify · Page 3 of 12" in every chunk is pure noise
  that dilutes every embedding)
- Normalize unicode (curly quotes, non-breaking spaces, ligatures)
- Drop boilerplate legal blocks that appear in every document
- Keep semantic markdown (`##`, lists, tables) — it survives embedding usefully and helps
  the model parse structure

**Why this matters:** boilerplate repeated across every chunk makes all your chunks
slightly similar to each other, which flattens the similarity distribution and degrades
retrieval precision. Removing it is one of the highest ROI/effort ratios in the pipeline.

---

## 3.4 Step 3 — Chunking

The most consequential decision in RAG, and the one with the most cargo-culting.

**Why chunk at all?** Two reasons, and only two. (a) Embedding models have input limits,
and quality degrades well before the hard limit — a vector summarizing 8,000 tokens is a
blurry average that matches everything weakly and nothing strongly. (b) You want to inject
*only relevant* text into the prompt; retrieving a 30-page PDF to answer one question
wastes tokens and buries the answer in noise.

### Strategies

| Strategy | How | Verdict |
|---|---|---|
| Fixed-size (e.g. 512 tokens) | Split every N tokens | Simple, and it will cut a sentence in half. Baseline only. |
| Fixed + overlap | N tokens, 10–20% overlap | The standard safe default. Overlap means a boundary-straddling sentence appears intact in one chunk. |
| **Recursive character** | Split on `\n\n` → `\n` → `. ` → ` `, respecting a max size | **Good general default.** Prefers natural boundaries, falls back gracefully. |
| **Structure-aware** | Split on markdown headings; keep sections intact | **Best for our corpus.** Policy documents already have semantic sections. |
| Semantic | Embed sentences, split where similarity drops | Elegant, expensive, marginal gain over structure-aware on well-structured docs. |
| Late chunking | Embed whole doc, pool over spans | Research-grade; excellent context preservation. Watch this space. |

**Decision: structure-aware with a size ceiling and overlap.**

```
Primary split:    markdown headings (## / ###)
If section > 800 tokens:  recursive-character split within the section
Overlap:          120 tokens
Minimum chunk:    100 tokens  (below that, merge into a neighbour)
Hard maximum:     1000 tokens
```

**Why ~800 tokens?** It's a tuned trade-off, not a magic number:
- **Too small (128–256):** high precision, but the answer's supporting context gets
  amputated. "Returns accepted within 30 days" retrieves without "…of delivery, provided
  the product is unopened."
- **Too large (2000+):** the embedding blurs. A chunk covering shipping *and* returns
  *and* exchanges is a weak match for all three.
- **~600–800 with overlap** keeps a policy clause and its qualifiers together while
  staying focused enough for a sharp vector.

**You must measure this.** Build a 30–50 question eval set from real customer questions
(pull them from your existing support inbox — that's your highest-value asset here), then
sweep chunk sizes and measure recall@5. Do this once; it takes an afternoon and it's the
difference between a bot that works and one that mostly works.

### Contextual retrieval (do this — it's the biggest single quality win)

A chunk pulled out of a document loses its context. Consider a chunk reading:

> "Items must be returned in original packaging with all seals intact."

Returned *what*? Under what policy? Within what window? The embedding has no idea, and
neither will the model.

**The fix:** before embedding, prepend a short LLM-generated situating header describing
where the chunk sits in its document.

```
[Nailzify Return Policy — Section 3: Condition Requirements.
 Applies to unopened press-on nail sets returned within the 30-day window.]

Items must be returned in original packaging with all seals intact.
```

Embed the combined text. Store the original for display.

This technique (published by Anthropic as "contextual retrieval") reduces retrieval
failure rate substantially — commonly cited around 35% with contextual embeddings, and
around 50% when combined with contextual BM25. It costs one cheap Haiku call per chunk at
ingest time — for a 40-document corpus, a few dollars, once. **Best cost-to-quality ratio
of anything in this pipeline.** Use prompt caching on the full document text across all
chunks of that document and the cost drops further.

---

## 3.5 Step 4 — Metadata enrichment

Attach filterable metadata to every chunk. This is what makes retrieval *precise* rather
than merely *semantic*.

```jsonc
{
  "chunkId":     "shipping-policy#s3#c2",
  "documentId":  "shipping-policy",
  "title":       "Shipping Policy",
  "section":     "International Shipping",
  "page":        4,
  "docType":     "policy",          // policy | guide | faq | product
  "topics":      ["shipping", "international", "customs"],
  "sourceUri":   "s3://nailzify-documents/raw/policies/shipping-policy.pdf",
  "version":     "2026-03-01",
  "checksum":    "sha256:…",
  "tokenCount":  742
}
```

**Why it earns its keep:**
- **Filtered search.** "Do you ship to the UK?" → pre-filter `docType = policy` before
  vector search. Smaller candidate set, higher precision.
- **Citations.** "According to our Shipping Policy (p. 4)…" — checkable by the customer,
  and the strongest available signal that the bot isn't making things up.
- **Surgical invalidation.** Updated the returns policy? `deleteByFilter({documentId:
  "returns-policy"})` then re-ingest. No full rebuild.
- **Debugging.** When an answer is wrong, metadata tells you exactly which chunk misled
  the model.
- **`checksum`** enables skip-if-unchanged, so re-running ingestion is cheap and safe.

---

## 3.6 Step 5 — Embedding

**Concept.** An embedding model maps text to a vector such that semantic similarity
becomes geometric proximity. "How long do press-ons last?" and "press-on nail wear
duration" produce nearby vectors despite sharing almost no words. Similarity is measured
by cosine distance — the angle between vectors, ignoring magnitude.

The mental model that helps: the model has learned a coordinate system for *meaning*.
Dimension 400 isn't "nail-related," but the *direction* the vector points encodes topic,
tone, specificity, and entity all at once.

**Model choice — verified against the live API in this account:**

| Model | Dims | Notes |
|---|---|---|
| `cohere.embed-v4:0` | **1536 by default**, configurable | **Chosen.** Supports asymmetric `input_type`; strong retrieval benchmarks. |
| `amazon.titan-embed-text-v2:0` | 256/512/1024 | Cheapest. Configurable dims trade a little accuracy for a lot of storage. Solid fallback. |

> ⚠️ **Cohere v4 returns 1536 dimensions by default, not 1024.** An earlier draft
> of this document assumed 1024, which would have failed every upsert against a
> 1024-dimension index with a dimension mismatch.
>
> The adapter therefore pins `output_dimension: 1024` explicitly rather than
> relying on the default. Two reasons: it matches the index, and — more
> importantly — an explicit value means the adapter's declared `dimensions` and
> the vectors it actually returns can never drift apart. Cohere v4 uses
> Matryoshka representations, so truncating to 1024 costs very little retrieval
> quality while saving ~33% vector storage.
>
> **General lesson:** verify wire formats and dimensions against the real API
> before building on them. A dimension mismatch is a loud failure; a *silently
> wrong* assumption about response shape is worse.
| `cohere.embed-multilingual-v3` | 1024 | If you sell internationally and get non-English questions. |
| `amazon.nova-2-multimodal-embeddings-v1:0` | — | Text *and* images in one space. The Phase 12 image-search unlock. |

**The asymmetric-embedding detail most people miss.** Cohere lets you tag input:

- At ingest: `input_type: "search_document"`
- At query time: `input_type: "search_query"`

Documents and questions have different shapes — a question is short and interrogative, a
policy chunk is long and declarative. Telling the model which side it's embedding
measurably improves matching. **Getting this backwards silently degrades retrieval with
no error**, and it's a genuinely common bug. Encode it in the adapter so it can't be got
wrong by a caller.

**Operational notes:**
- Batch (Cohere accepts up to 96 texts per call) — fewer round trips, better throughput.
- Step Functions `Map` with `MaxConcurrency: 5` to stay under Bedrock TPM limits, with
  exponential backoff on `ThrottlingException`.
- Embeddings are deterministic per model version. Store `embeddingModel` and
  `embeddingVersion` on each vector — **changing embedding models requires re-embedding
  everything**, because vectors from different models are not comparable. Recording the
  version is what makes that migration auditable instead of terrifying.
- Normalize to unit length if your store doesn't (Pinecone cosine metric handles it).

---

## 3.7 Step 6 — Indexing

**Pinecone configuration:**

```
Index:      nailzify-prod
Dimension:  1024                 (must match the embedding model exactly)
Metric:     cosine
Type:       Serverless (AWS us-east-1)   ← co-locate with Lambda to cut latency
Namespaces: knowledge | products
```

**Why namespaces rather than two indexes?** Namespaces are logical partitions inside one
index. Queries scope to one namespace, so there's no cross-contamination, but you manage
one resource and one bill. They also make environment isolation trivial:
`knowledge-dev`, `knowledge-prod`.

**Upsert semantics.** IDs are deterministic: `{documentId}#{sectionIndex}#{chunkIndex}`.
Same document re-ingested → same IDs → overwrite, not duplicate. **Idempotency by design**
is what lets you safely retry a half-failed pipeline run.

**Handling deletions.** Deleting the S3 object doesn't remove vectors. Handle it
explicitly: on `ObjectRemoved`, `deleteByFilter({ documentId })`. Also run a weekly
reconciliation job comparing S3 keys to distinct `documentId`s in Pinecone. Orphaned
vectors from a deleted policy are a real failure mode — the bot quotes a policy you no
longer have.

**Vector payload:**

```jsonc
{
  "id": "shipping-policy#s3#c2",
  "values": [0.021, -0.118, ...],           // 1024 floats
  "metadata": {
    "text": "Items must be returned in...",  // the ORIGINAL chunk, not the contextualized one
    "contextHeader": "[Nailzify Return Policy — Section 3...]",
    "documentId": "returns-policy",
    "title": "Return Policy",
    "section": "Condition Requirements",
    "page": 3,
    "docType": "policy",
    "version": "2026-03-01"
  }
}
```

Note: **embed** `contextHeader + text`, but **store and display** `text`. The header is a
retrieval aid, not something to show a customer.

---

## 3.8 The product catalog pipeline

Same machine, different source, and one critical rule.

```
EventBridge Scheduler (03:00 daily)  ──┐
Shopify products/update webhook      ──┴──► Step Functions: ProductSync
                                              │
                                              ├─ Fetch catalog (Shopify GraphQL, paginated)
                                              ├─ For each product, build the EMBED TEXT:
                                              │     title + description + productType
                                              │     + metafields: shape, style,
                                              │       colour, finish
                                              │     + occasion + skinToneNotes
                                              │     ⛔ NO price. NO inventory. NO variant SKUs.
                                              ├─ Embed  (Bedrock)
                                              ├─ Upsert → Pinecone ns:products
                                              │     metadata: { productId, handle, title,
                                              │                 shape, length, style,
                                              │                 priceBand, ... }
                                              └─ Upsert → DynamoDB product cache
                                                    (display metadata only — a warm cache,
                                                     never the source of truth for price)
```

**The rule, restated because it is the whole design:** the product vector encodes *what
this product is like*, never *what it costs or whether it's in stock*. The vector answers
"is this relevant?" The Shopify Storefront API answers "what is true about it right now?"

**`priceBand` is a deliberate exception.** We store a coarse bucket (`under-15`, `15-25`,
`25-plus`) as metadata so "show me something under $20" can pre-filter. A band is stable
across ordinary price movements in a way an exact price is not — and the *exact* price
still comes from the live hydration call. If you run a sale that moves a product across a
band boundary, the nightly sync corrects it, and the worst case is a slightly imperfect
candidate set — never a wrong price shown to a customer.

---

## 3.9 Failure handling

| Failure | Handling |
|---|---|
| Extraction returns empty/garbage | Fail the run, alarm, DLQ. **Never index empty chunks** — they match everything weakly and poison retrieval. |
| Bedrock throttles | Step Functions retry, exponential backoff + jitter, 5 attempts |
| Pinecone upsert partial failure | Retry the failed batch; IDs are deterministic so retry is safe |
| Document > Lambda limits | Step Functions Map state fans out; each Lambda handles a slice |
| Two ingests of the same doc race | Idempotent IDs make last-write-win correct |
| Ingest succeeds, quality is bad | **Step 7 verification** — smoke-query known questions against the new chunks; alarm on recall regression |

That last row is the one people skip. A pipeline that reports success while producing
useless vectors is worse than one that fails loudly, because you find out from a customer.

---

## 3.10 Operational runbook

**Adding a document:** drop it in `s3://nailzify-documents/raw/<category>/`. Done. The
pipeline handles the rest. Watch the Step Functions execution.

**Updating a document:** upload the new version to the same key. S3 versioning keeps the
old one; deterministic IDs mean vectors overwrite cleanly.

**Removing a document:** delete the S3 object. The `ObjectRemoved` handler purges vectors
by `documentId`.

**Changing embedding models:** re-embed everything into a *new* namespace, verify against
the eval set, then flip the namespace the query path reads from. Blue/green for vectors —
never mix models in one namespace.

---

Next: [Phase 4 — Retrieval pipeline](04-retrieval.md)
