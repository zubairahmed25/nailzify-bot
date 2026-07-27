# Phase 12 — Future Enhancements

Ordered by value per unit of effort, not by how impressive they sound. The temptation with
an AI project is to build the flashy thing first; the discipline is to build the thing that
moves a metric.

**Before any of this: ship Phases 1–11 and run them for a month.** Real conversations will
tell you which of these matters, and they will surprise you. Building image search before
you know whether customers even ask about images is how projects accumulate features
nobody uses.

---

## 12.1 Analytics & conversation intelligence — do this first

**Effort: low. Value: highest.** This is the least glamorous item on the list and the one
that determines whether the project survives a budget review.

Every conversation is unstructured market research you're currently throwing away.

**Pipeline:**
```
DynamoDB Streams → Firehose → S3 (Parquet, partitioned by date) → Athena → QuickSight
```

Nightly, run a cheap classification pass over each conversation and store:

| Extracted | Why the business cares |
|---|---|
| Intent distribution | What customers actually want to know |
| **Unanswered questions** | **Directly becomes your content roadmap** |
| Product interest not in catalog | Merchandising signal — demand you're not serving |
| Sentiment trajectory | Where conversations go wrong |
| Deflection rate | Support tickets avoided → the ROI number |
| Chat → PDP → purchase attribution | Revenue influenced → the *other* ROI number |

The unanswered-questions report is the highest-value artifact here. If forty people asked
about gel-removal safety and your corpus has nothing on it, you now know exactly what
document to write next — and after writing it, the bot answers forty questions a month
that previously escalated.

**Feed the loop:** unanswered questions → new documents → re-ingest → measurably fewer
abstentions. That closed loop is what turns the bot from a static asset into one that
improves.

---

## 12.2 Customer personalization

**Effort: medium. Value: high. Prerequisite: a privacy review.**

You already capture `customerId` from the App Proxy (Phase 8.1). Build a preference
profile:

```jsonc
{
  "PK": "CUSTOMER#gid://shopify/Customer/7712",
  "SK": "PROFILE",
  "nailBedWidthMm": [8, 9, 9, 8, 7],       // stated once, remembered forever
  "preferredShapes": ["almond", "oval"],
  "preferredLengths": ["short"],
  "avoidedStyles": ["glitter"],
  "typicalBudget": "15-25",
  "skinToneNote": "warm undertone",
  "purchaseHistory": ["autumn-almond-short"],
  "consentGivenAt": "2026-07-26T14:02:11Z"   // ← required
}
```

The payoff is real: *"Based on your measurements from last time, you're a size 4 on the
thumb"* is a genuinely better experience than asking again.

**The rules that make this safe:**
- **Explicit consent**, stored with a timestamp. Not buried in a policy.
- **Visible and editable** — the customer can see and clear their profile.
- **Deletion honoured** — one query on GSI1 removes everything.
- **Never infer sensitive attributes.** Skin tone is a stated preference for colour
  matching, volunteered by the customer, never inferred from a photo or a name. This
  distinction is not pedantic; getting it wrong is a serious harm and a serious liability.
- **Don't be creepy.** Reference remembered details naturally, not as a demonstration that
  you've been watching.

---

## 12.3 Multimodal support

**Effort: medium. Value: high for this specific product.**

Press-on nails are a visual purchase. Customers will want to send photos:

| Use case | Approach |
|---|---|
| "Will these fit my nails?" | Photo + a reference object (a coin) → Claude vision estimates nail bed width |
| "Something like this" (screenshot) | Vision describes it → semantic product search |
| "Is this how I apply it?" | Vision checks application against the care guide |
| "These lifted after 2 days" | Vision + troubleshooting from documentation |

Claude on Bedrock accepts images directly in the message content — no separate service.

```ts
messages: [{
  role: "user",
  content: [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
    { type: "text", text: "Will these fit? The coin is a US quarter." },
  ],
}]
```

**Engineering considerations:**
- Upload direct to S3 via a presigned URL; never route image bytes through Lambda.
- Cap size and dimensions client-side; resize before upload (images are billed as tokens
  and a full-resolution phone photo is expensive).
- Short S3 lifecycle (24 h) — customer photos are not something to retain.
- **Be careful about medical claims.** "Your nail looks infected" is not a statement a
  retail chatbot should make. Add an explicit boundary to the system prompt.

---

## 12.4 Image similarity search

**Effort: medium-high. Value: high. This is the fun one — build it third, not first.**

Your account already has `amazon.nova-2-multimodal-embeddings-v1:0`, which embeds text
*and* images into the **same vector space**. That's the unlock: a photo and a description
become directly comparable.

```
Ingest:  every product image → Nova 2 embedding → Pinecone ns:product-images
Query:   customer photo      → Nova 2 embedding → nearest neighbours → product IDs
                                                        ↓
                              hydrate live from Shopify  ← same two-plane rule as always
```

Note the last line. **Image search changes the retrieval mechanism, not the architecture.**
Candidates come from vectors; prices still come from Shopify. Every new retrieval modality
plugs into the same funnel, which is the payoff for getting the abstraction right in Phase 1.

Two ways to build it, and the choice is a genuine trade:

| Approach | Trade |
|---|---|
| **Direct image embedding** (Nova 2) | Captures visual style — colour, finish, pattern — that words miss. One vector per image. |
| **Vision → text → embed** (Claude describes, then embed the description) | Reuses your existing text index. More interpretable and debuggable. Loses fine visual nuance. |

Start with vision → text (no new index, works today). Move to direct embeddings when you
can measure that visual nuance is what's failing.

---

## 12.5 Advanced recommendations

**Effort: medium. Value: medium — and the naive version is a trap.**

The obvious move is collaborative filtering ("customers who bought X also bought Y"). It
works, but it needs volume, and it cold-starts badly on new products — exactly the
products a boutique store most wants to move.

Better sequence for a store this size:

1. **Rule-augmented LLM (now).** Encode domain expertise in the system prompt: which shapes
   flatter which nail beds, which lengths suit which lifestyles, colour theory for
   undertones. This is *knowledge*, and RAG is good at knowledge. Write it into a document
   and ingest it — then the recommendation logic is editable by a merchandiser, not a
   developer. That's a real advantage.
2. **Hybrid with behavioural signals (at volume).** Blend semantic relevance with
   conversion rate and return rate per product. A product with a 40% return rate should
   rank lower regardless of semantic fit — return rate is a strong quality signal you
   already have.
3. **Collaborative filtering (at real volume).** Amazon Personalize or a home-grown
   matrix-factorization model. Only worth it with thousands of transactions.

Note step 1 is available today and is probably 80% of the value. The nail-fitting domain
knowledge is genuinely specialized and genuinely helpful — it's the kind of thing a good
in-store assistant knows and a generic chatbot doesn't.

---

## 12.6 Agentic workflows

**Effort: high. Value: high. Risk: high. Do this last, and deliberately.**

Today the bot is read-only, which is what makes it safe (Phase 10.6). Agentic means letting
it *act*. That's a genuine capability jump and a genuine risk jump, and the two arrive
together.

**Candidate actions, ordered by risk:**

| Action | Risk | Guardrail |
|---|---|---|
| Look up order status | Low | Read-only; verify order ownership against the authenticated `customerId` |
| Start a return (create an RMA draft) | Medium | Human approves before it's finalized |
| Add to cart | Medium | Customer confirms in the UI; never silent |
| Apply a discount code | **High** | Pre-approved codes only, from an allowlist, with rate limits |
| Issue a refund | **Very high** | Don't. Escalate to a human. |

**Non-negotiable rules if you go here:**

1. **Every write action is confirmed by the customer in the UI**, not by the model deciding
   it's fine. The model *proposes*; the human *disposes*.
2. **Idempotency keys on every mutation.** A retried tool call must not create two returns.
3. **Full audit trail** — who, what, when, and the conversation that led to it.
4. **Per-action IAM scoping.** The order-status tool gets read on orders. Nothing gets
   write on payments.
5. **Re-read Phase 10.6 first.** Every capability you add is a capability a prompt
   injection can attempt to reach. The read-only surface is currently your strongest
   security property, and you'd be trading it away.

**The mature pattern:** the model drafts, a human approves, the system executes. That
captures most of the value at a fraction of the risk, and it's what most serious commerce
deployments actually run.

---

## 12.7 Other candidates

| Enhancement | Effort | Value | Notes |
|---|---|---|---|
| **Proactive engagement** | Low | Medium | Trigger on exit intent or long dwell on a PDP. Test carefully — intrusive chat popups measurably hurt conversion. |
| **Multilingual** | Low | Depends | Bedrock models are multilingual out of the box; use `cohere.embed-multilingual-v3` and store `locale`. Nearly free if you already sell internationally. |
| **Voice** | Medium | Low | Amazon Transcribe + Polly. Rarely used on storefronts. Skip. |
| **Human handoff (live)** | Medium | High | Escalation currently drops a ticket. Real-time handoff to Gorgias/Zendesk with full transcript is a big CX win. **Probably the best next item after analytics.** |
| **A/B testing prompts** | Medium | High | Route a percentage to a variant, compare conversion and CSAT. This is how you improve deliberately instead of by intuition. |
| **Semantic caching** | Low | Medium | Cache answers to semantically-similar questions. Careful: never cache anything containing a price or a stock level. |
| **Fine-tuning / distillation** | High | Low→Medium | Once you have thousands of good conversations, distil Sonnet's behaviour into Haiku for the common path. A cost play at scale, not a quality play. |

---

## 12.8 Suggested sequence

```
Month 1–2   Ship Phases 1–11. Get real conversations.
Month 3     Analytics (12.1) + live human handoff (12.7)
            ← the two that prove and protect the project's value
Month 4     Multimodal photo input (12.3) — high value for a visual product
Month 5     Personalization (12.2), with the privacy review done properly
Month 6     Image similarity search (12.4)
Month 7+    Recommendation sophistication (12.5), then agentic (12.6) — carefully
```

**The meta-lesson, and the thing that separates engineers who ship AI systems from ones
who demo them:** the hard part was never the model. It's retrieval quality, data
freshness, cost control, observability, and knowing what to build next. Everything in
Phases 1–11 exists to make those tractable. Phase 12 is what you get to build once they
are.

---

## Learning path from here

You said you want to become an AI Infrastructure Engineer. This project touches most of
the surface area. Where to push deeper:

| Area | Next step |
|---|---|
| **AWS** | Get the Solutions Architect Associate. Then read the Well-Architected Framework and audit this system against all six pillars — you'll find real gaps. |
| **RAG** | Build the eval harness *first* on your next project. Read the contextual-retrieval and RAG-survey literature. Learn to reason about recall/precision trade-offs numerically. |
| **Vector databases** | Understand HNSW vs. IVF index structures and their recall/latency/memory trade-offs. Then implement a toy ANN index — it demystifies the whole category. |
| **Embeddings** | Read the MTEB benchmark methodology. Understand *why* asymmetric embedding (Phase 3.6) works. Learn when fine-tuning an embedding model beats a better retriever. |
| **Prompt engineering** | Treat prompts as versioned code with tests. The skill is not clever wording — it's building the measurement loop that tells you whether wording helped. |
| **LLM orchestration** | Build a tool-use loop by hand once (Phase 7.4) before reaching for a framework. Frameworks hide the loop, and the loop is where the bugs live. |
| **Scalability** | Learn to identify the actual bottleneck. Here it's tokens and rate limits, not CPU. That reframing generalizes. |
| **Security** | Study prompt injection seriously. Internalize that capability restriction beats prompt hardening, every time. |
| **Cost** | Instrument cost per conversation from day one. Engineers who can say "this feature costs $0.04 per conversation" get listened to in a way that engineers who say "it's fast" do not. |

The most valuable habit from this whole project: **measure before optimizing, and make the
architecture enforce the invariant rather than trusting a prompt to.** The two-plane split
in Phase 1 is that idea in its purest form — it's not a clever prompt that stops the bot
quoting stale prices, it's the fact that stale prices are never in the room.
