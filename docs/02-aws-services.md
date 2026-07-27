# Phase 2 — AWS Services

Every service below is examined the same way:

> **Problem** → what breaks without it · **Why this one** → the decision ·
> **Alternatives** → what else exists · **Trade-offs** → what we give up ·
> **Delete it?** → what actually happens if we remove it

If you can't answer all five for a service, you don't need the service yet. That is the
single most useful discipline in cloud architecture, and it's how you avoid the $4,000/mo
bill for a system serving 200 users.

---

## 2.0 A decision you should make before any of this: Bedrock vs. Claude Platform on AWS

You said "prefer Amazon Bedrock." Worth knowing there are now **two** ways to run Claude
inside AWS, and they are not the same product:

| | **Amazon Bedrock** | **Claude Platform on AWS** |
|---|---|---|
| Operated by | AWS (partner-operated) | Anthropic, delivered through AWS |
| Auth | AWS SigV4 / IAM | AWS SigV4 / IAM |
| Billing | AWS bill | AWS Marketplace |
| Model IDs | `anthropic.claude-sonnet-5` (prefixed) | `claude-sonnet-5` (bare) |
| Feature parity | Subset; features land later | **Same-day parity with the first-party API** |
| Not available | Batches API, Files API, server-side web search/fetch, code execution, automatic prompt caching, task budgets | — |

**Recommendation: build on Bedrock, but write the model client behind an interface**
(`packages/core/src/ports/llm.ts`). Bedrock gives you the most familiar IAM/VPC/CloudWatch
story and everything this project needs today: streaming, tool use, manual prompt caching,
adaptive thinking, effort control. If you later want a feature Bedrock lags on, swapping
the adapter is a one-file change instead of a refactor.

Concretely, in TypeScript:

```ts
// Bedrock
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
const client = new AnthropicBedrockMantle({ awsRegion: "us-east-1" });
// model: "anthropic.claude-sonnet-5"

// Claude Platform on AWS — same call surface, bare model IDs
// import AnthropicAws from "@anthropic-ai/aws-sdk";
// const client = new AnthropicAws();   // needs AWS_REGION + ANTHROPIC_AWS_WORKSPACE_ID
// model: "claude-sonnet-5"
```

Same `client.messages.create(...)` surface either way. That's the whole point of putting
it behind a port.

---

## 2.1 Amazon Bedrock — model inference

**Problem.** You need a language model that can reason over retrieved text and call tools,
plus an embedding model that turns text into vectors. You do not want to own GPUs.

**Why this one.** Bedrock is a managed, multi-model inference API inside your AWS account
boundary. That matters for three practical reasons: requests authenticate with IAM (no
third-party API key to rotate and leak), usage lands on your existing AWS bill and
Cost Explorer, and invocation logging drops into CloudWatch/S3 with one config setting.
For a store handling customer messages, keeping inference inside the account you already
audit is a real compliance simplification.

> ### ⚠️ Two gates before any Claude model works — both measured
>
> **1. Model IDs must be inference profiles, not bare IDs.**
>
> ```
> anthropic.claude-sonnet-4-6      -> ValidationException
> us.anthropic.claude-sonnet-4-6   -> reaches the model
> ```
>
> Current Claude models on Bedrock require a **cross-region inference profile**.
> `us.` routes across US regions for capacity; `global.` routes worldwide. The
> error (`ValidationException`) does not say "use a profile", which makes this
> the most common Bedrock model-ID mistake.
>
> Note the two Bedrock surfaces take **different** ID formats:
>
> | Client | Path | Model ID format |
> |---|---|---|
> | `AnthropicBedrock` | `InvokeModel` | `us.` / `global.` profile IDs |
> | `AnthropicBedrockMantle` | Messages endpoint | bare `anthropic.` IDs |
>
> Mantle returns 404 for profile-prefixed IDs. Pick one and stay consistent.
>
> **2. Listing is not access.** Both `list-foundation-models` and
> `list-inference-profiles` report models the account **cannot invoke** — the
> latter even shows them as `ACTIVE`. On this account every Claude model
> currently fails with one of:
>
> - `404 Model use case details have not been submitted for this account` —
>   cleared by a form in the Bedrock console (Model access → Anthropic use case
>   details), then ~15 minutes to propagate.
> - `403 <model> is not available for this account` — a separate per-model
>   access grant. Claude 5 models sit behind this one.
>
> Cohere embed/rerank are unaffected, which is why the retrieval pipeline
> verified fine while the LLM path did not. **Verify by invoking, never by
> listing** — run `npx vite-node scripts/verify-llm.ts`.

**Model selection.** Verify each against your account before relying on it:

| Job | Model | Bedrock ID | Price /1M in–out | Why |
|---|---|---|---|---|
| Main conversation | Claude Sonnet 5 | `us.anthropic.claude-sonnet-5` ⚠️ | $3 / $15 | Near-Opus quality on tool use and instruction-following at a third the cost. The default for production chat. |
| Cheap turns / routing / classification | Claude Haiku 4.5 | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | $1 / $5 | "Do you ship to Canada?" doesn't need a frontier model. Route simple intents here — see §2.13 cost model. |
| Hardest reasoning (optional) | Claude Opus 5 | `us.anthropic.claude-opus-5` ⚠️ | $5 / $25 | Reserve for offline eval-set grading or a complex-recommendation escalation path, not the default. |
| Embeddings | Cohere Embed v4 | `cohere.embed-v4:0` | ~$0.10 / 1M | Strong retrieval quality, supports `input_type` (`search_document` vs `search_query`) which measurably improves recall — see Phase 3. |
| Embeddings (alt) | Titan Text v2 | `amazon.titan-embed-text-v2:0` | ~$0.02 / 1M | Cheapest; configurable output dimensions (256/512/1024) for storage savings. |
| Future: image embeddings | Nova 2 Multimodal | `amazon.nova-2-multimodal-embeddings-v1:0` | — | Same vector space for text and images → "find nails like this photo." Phase 12. |

**Alternatives.**
- *OpenAI / Anthropic first-party API directly* — simpler signup, more features sooner, but pulls a third-party API key into your secret rotation story and puts inference cost outside AWS billing.
- *SageMaker with a self-hosted open model (Llama, Mistral)* — you own the weights and the latency, and cost becomes fixed rather than per-token. Break-even is roughly "sustained heavy load, 24/7." At a few thousand conversations a month you'd pay for idle GPUs. Also: you inherit the eval, safety, and upgrade burden.
- *Amazon Nova models* — cheaper, AWS-native, weaker at multi-step tool use in my experience. Reasonable for pure classification sub-tasks.

**Trade-offs.** Vendor coupling to Bedrock's API shape (mitigated by the port). Regional
model availability varies — `us-east-1` has the widest selection, which is why we're
there. Bedrock lags first-party Anthropic on newer features (see §2.0 table).

**Delete it?** No product. This is the only irreplaceable component.

---

## 2.2 AWS Lambda — compute

**Problem.** Something has to run your orchestration code: verify the request, load
history, call Bedrock, execute tools, stream the response.

**Why this one.** The workload is the textbook serverless shape — bursty, low average
utilization, per-request isolation, no long-lived state. A storefront chatbot might see
zero traffic for six hours and then forty concurrent conversations during a product drop.
With Lambda you pay for exactly the milliseconds you consume.

Three configuration decisions that matter more than people expect:

1. **`arm64` (Graviton2)** — ~20% cheaper per GB-second than x86 at equal or better
   performance for Node. There is no reason to choose x86 for a new Node Lambda.
2. **Function URL with `RESPONSE_STREAM` invoke mode** — *this is the important one.*
   API Gateway **cannot** stream a response body. If you put API Gateway in front of your
   chat endpoint, the customer stares at a spinner for 4 seconds and then the entire
   answer appears at once. With a streaming Function URL you emit SSE and the first token
   lands in ~800 ms. Perceived latency drops by roughly 4×, and perceived latency is the
   only latency a customer experiences.
3. **Memory = 1024 MB.** Lambda allocates CPU proportionally to memory. This function is
   mostly I/O-bound waiting on Bedrock, but JSON parsing and SSE framing benefit from the
   extra vCPU share. Tune with AWS Lambda Power Tuning; 1024 is a good starting point.

**Alternatives.**
- *ECS Fargate / App Runner* — always-on containers, no cold starts, and cheaper past a sustained-load crossover point (roughly >50 req/s continuous). Also removes the 15-minute execution ceiling. Costs you ~$30–50/mo minimum even at zero traffic.
- *EC2* — cheapest per unit of compute at scale, most expensive in engineering time. Not for a team of one.
- *Lambda@Edge / CloudFront Functions* — for the auth check, tempting. But no VPC, tiny memory limits, no streaming, and deployment propagation takes minutes. Wrong tool.

**Trade-offs.** Cold starts (~400–900 ms for a Node bundle this size) — mitigated with
esbuild bundling, minimal dependencies, and optionally provisioned concurrency during
known-busy windows. The 15-minute ceiling is irrelevant for chat and handled by Step
Functions for ingestion.

**Delete it?** You'd need a container platform, and you'd pay for idle. For this traffic
profile that's strictly worse.

---

## 2.3 Amazon CloudFront + AWS WAF — edge

**Problem.** Three separate ones: (a) serve the widget JS/CSS globally with low latency,
(b) put one stable HTTPS origin in front of Lambda, (c) stop someone from discovering
your endpoint and burning $900 of Bedrock tokens overnight.

**Why this one.** CloudFront solves (a) and (b) with one distribution and two origins —
S3 for `/assets/*`, the Lambda Function URL for `/api/*`. WAF attaches to that
distribution and solves (c).

**(c) deserves emphasis.** Your Lambda calls a metered LLM. An unprotected LLM endpoint is
a *financial* vulnerability, not just a security one — this is sometimes called "denial of
wallet." The controls, in layers:

| Layer | Control |
|---|---|
| WAF | Rate-based rule: block an IP exceeding N requests / 5 min |
| WAF | AWS Managed Rules — common exploits, bad inputs, optional Bot Control |
| App | HMAC verification of the Shopify App Proxy signature (rejects anything not originating from your storefront) |
| App | Per-session turn cap in DynamoDB, per-session token budget |
| Account | Bedrock provisioned-throughput / budget alarms with an automated kill switch |

Do not skip the app-layer controls because you have WAF. WAF stops volume; HMAC stops
*forgery*; the session cap stops one legitimate-looking client from looping forever.

**Alternatives.**
- *API Gateway with usage plans + API keys* — good throttling primitives, but no response streaming, and API keys in a public storefront widget are not secrets.
- *Cloudflare in front of everything* — excellent WAF, often cheaper, but adds a second vendor and splits your observability.
- *Lambda Function URL exposed directly* — works, saves money, but then you have no WAF, no CDN for assets, no custom domain, and your Lambda URL is public.

**Trade-offs.** CloudFront distribution changes take several minutes to propagate. WAF
adds ~$5/mo baseline plus per-request charges. Both are worth it.

**Delete it?** You lose your only defence against cost-based abuse. Realistically the
system gets scraped within weeks. Don't.

---

## 2.4 Amazon DynamoDB — operational state

**Problem.** Conversation memory has to live somewhere. So do ingestion job states and the
product-metadata cache.

**Why this one.** Every access pattern in this system is a key lookup:

| Pattern | Query |
|---|---|
| Load a conversation | all messages for `sessionId`, ordered by time |
| Append a turn | write one item |
| Expire old sessions | automatic, no code |
| Fetch cached product metadata | get by `productId` |
| Check ingestion job status | get by `jobId` |

There is not one join, aggregate, or ad-hoc filter in that list. That's DynamoDB's exact
sweet spot: single-digit-millisecond point reads, on-demand billing that costs literally
nothing at low traffic, and **native TTL** — you write an epoch timestamp on the item and
DynamoDB deletes it for free. Session expiry, a feature you'd otherwise build a cron job
for, becomes an attribute.

**Alternatives.**
- *RDS / Aurora PostgreSQL* — real SQL, joins, and you could co-locate `pgvector` to replace Pinecone. Genuinely attractive later. Today it means a VPC, a NAT Gateway (~$32/mo), connection-pool management from Lambda (RDS Proxy, another ~$15/mo), and patching windows. ~$60/mo before your first query.
- *ElastiCache Redis* — fastest, but in-memory means durability work, plus a VPC and always-on node cost.
- *S3 as a session store* — technically works, ~100 ms latency, no TTL semantics, no conditional writes. Don't.

**Trade-offs.** You must design the table around access patterns up front — adding a new
query shape later can mean a new GSI or a backfill. Analytics queries are painful (which
is why Phase 10 exports to S3 for Athena instead). No joins, ever.

**Delete it?** The bot forgets everything between messages. "What size did I say?" becomes
unanswerable. Conversation memory *is* the product for a concierge.

---

## 2.5 Pinecone Serverless — vector database

This is the one place we deliberately leave AWS-native services, so it gets the longest
justification.

**Problem.** Given a question, find the k most semantically similar text chunks out of
tens of thousands. That is approximate nearest-neighbour search over high-dimensional
vectors, and it needs a purpose-built index (HNSW or IVF) — a `WHERE` clause won't do it.

**Why this one.** Honestly: **cost at small scale, and zero operational surface.**
Pinecone Serverless bills on storage + read/write units with a usable free tier. Your
corpus — call it 40 documents and 800 products, maybe 15k vectors — costs single-digit
dollars per month, often zero. It is also a first-class supported vector store for Bedrock
Knowledge Bases, so choosing it doesn't lock you out of the managed-RAG path later.

**The alternatives, honestly compared.**

| Option | Cost at our scale | Ops burden | Verdict |
|---|---|---|---|
| **Pinecone Serverless** | ~$0–15/mo | None | ✅ **Chosen.** Cheapest path to a working system. |
| **OpenSearch Serverless (AOSS)** | High — minimum billable OCU capacity applies whether you serve 1 query or 1M | Low | The AWS-native answer and Bedrock KB's default. The minimum-capacity floor is the problem at this scale, not the technology. Revisit when hybrid BM25+vector search in one engine is worth the floor. |
| **Aurora PostgreSQL Serverless v2 + `pgvector`** | ~$45+/mo (0.5 ACU floor) | Medium | Very appealing *if you already run Aurora* — one database for everything, real SQL filters alongside vector search. We don't, and standing up a VPC for it inverts the cost argument. **This is the most likely migration target once relational data appears.** |
| **S3 Vectors** | Very low | Very low | AWS's cost-optimized vector storage tier, integrates with Bedrock KB. Genuinely promising for exactly this use case — **verify current GA status and region availability in your account before committing**, and treat it as the leading candidate for a Phase-2 migration. |
| **Self-hosted (Qdrant/Weaviate/Milvus on ECS)** | ~$40+/mo + your time | High | You now operate a stateful database. No. |
| **Bedrock Knowledge Bases (fully managed RAG)** | Depends on backing store | Lowest | Wraps chunk+embed+index+retrieve into one API. Gets you 80% in an afternoon — but you give up control of chunking strategy, hybrid search, reranking, and the two-plane split that is the core of this design. Excellent for the knowledge plane specifically; consider it there. |

**Trade-offs.** A non-AWS dependency: separate API key (→ Secrets Manager), separate
status page, separate bill, and network egress from Lambda to Pinecone's endpoint. Data
residency is a question you must be able to answer if a customer asks. And Pinecone stores
your document *text* in metadata — treat it as a system holding company data.

**Mitigation — and this is the actual engineering advice:** define
`packages/core/src/ports/vector-store.ts` with `upsert`, `query`, `deleteByFilter`. Every
option in that table implements those three methods. Migration becomes an adapter swap and
a re-index job, not a rewrite. Never let a vendor SDK type leak into your domain layer.

**Delete it?** No semantic search. You fall back to keyword matching, which fails the
moment a customer phrases a question in their own words — which is always.

---

## 2.6 Amazon S3 — object storage

**Problem.** Source PDFs need a durable home. The widget bundle needs an origin. Analytics
exports need a destination.

**Why this one.** 11 nines of durability, effectively free at this volume, and — critically
— **S3 emits events**. Dropping a PDF into `s3://nailzify-docs/raw/` fires an EventBridge
notification that starts the ingestion state machine. Upload *is* the trigger. No polling,
no queue to babysit, no "click here to reindex" button.

**Buckets and why they're separate:**

| Bucket | Contents | Notes |
|---|---|---|
| `nailzify-documents` | `raw/`, `processed/` | Versioning ON — a bad re-upload is recoverable. Lifecycle: raw → Glacier IR after 90 days. |
| `nailzify-widget-assets` | Built JS/CSS | CloudFront OAC only; no public access. Content-hashed filenames + immutable cache headers. |
| `nailzify-analytics` | Conversation exports (Parquet) | Partitioned by date for Athena. Phase 10. |

Separate buckets because they have different lifecycle policies, different access
principals, and different blast radii. One bucket with prefixes is a smaller thing to get
wrong, but it's a single IAM boundary.

**Alternatives.** EFS (needs a VPC, costs more, solves a problem we don't have). Storing
documents in DynamoDB (400 KB item limit — PDFs don't fit).

**Trade-offs.** Eventual consistency on some operations. Public-access misconfiguration is
the single most common cloud data leak — Block Public Access at the account level, always,
and serve via CloudFront Origin Access Control.

**Delete it?** No durable document store, no event trigger, no CDN origin.

---

## 2.7 AWS Step Functions — ingestion orchestration

**Problem.** Ingesting a document is five steps that can each fail independently: download,
extract text, chunk, embed (a paid API call that can throttle), upsert. A 200-page PDF can
exceed Lambda's 15-minute limit. And when step 4 of 5 fails at 2 AM you need to know *which
document, which step, and why* — without adding logging to find out.

**Why this one.** Step Functions is a managed state machine. You declare the steps and the
transitions; AWS handles retries with exponential backoff, error branches, parallelism
(Map state over chunk batches), and — the underrated part — **a visual execution history
where a failed run shows you the exact failing state and its input/output**. That last
feature is worth the service on its own the first time you debug a production ingest.

The Standard workflow also runs up to a year, so document size stops being a constraint.

**Alternatives.**
- *One giant Lambda doing all five steps* — hits the 15-min limit, and a failure at step 4 re-runs steps 1–3 (re-paying for embeddings). The retry semantics are the killer.
- *SQS chain between Lambdas* — works, and is cheaper for very high volume, but you now hand-build state tracking, error correlation, and observability. You are writing Step Functions badly.
- *Airflow / MWAA* — a real orchestrator with a real price tag (~$350+/mo). Wildly oversized for one pipeline.
- *EventBridge Pipes* — good for simple source→transform→target; too thin for branching with retries.

**Trade-offs.** Per-state-transition billing (irrelevant at our volume). ASL (Amazon States
Language) is a JSON DSL with a learning curve — CDK's `stepfunctions` constructs hide most
of it. Local testing is awkward.

**Delete it?** Ingestion becomes a fragile script whose failures are invisible. It'll work
for the first ten documents and then silently drop one.

---

## 2.8 Amazon EventBridge — event routing & scheduling

**Two distinct jobs, same service.**

*Event bus:* S3 `ObjectCreated` on `raw/*` → start the ingestion state machine. The value
is decoupling — S3 doesn't know Step Functions exists. Tomorrow you add a second consumer
(notify Slack on upload) by adding a rule, touching nothing else.

*Scheduler:* nightly product-catalog sync at 03:00 — pull the Shopify catalog, embed the
descriptive text, refresh the `products` namespace and the DynamoDB metadata cache.

**Why this one.** EventBridge Scheduler replaced CloudWatch Events rules for scheduling:
one-time or recurring, timezone-aware (with DST handling), built-in retry and DLQ, and it
invokes 270+ AWS targets directly with no glue Lambda.

**Alternatives.** CloudWatch Events (legacy, no timezone support). A cron on EC2 (a server
to own). Shopify webhooks — actually **complementary**: use `products/update` webhooks for
near-real-time invalidation of individual products, with the nightly job as a
reconciliation sweep. Belt and braces; webhooks get missed.

**Trade-offs.** At-least-once delivery, so consumers must be idempotent — an upsert keyed
on product ID is naturally idempotent, which is why the pipeline is designed that way.

**Delete it?** Manual reindexing. New products stay invisible to the bot until someone
remembers.

---

## 2.9 AWS Secrets Manager — credentials

**Problem.** Three secrets: Shopify Admin API token, Pinecone API key, Shopify App Proxy
shared secret. None can be in code, in environment variables in the console, or in git.

**Why this one.** Encrypted at rest with KMS, IAM-gated per-secret, **automatic rotation**
with a Lambda, and full CloudTrail audit of every read. The rotation story is what
separates it from the cheaper option.

**Alternatives.**
- *SSM Parameter Store SecureString* — free tier vs. $0.40/secret/month, and honestly fine for a small project. It lacks native rotation and cross-region replication. **For three secrets, $1.20/mo buys rotation and a cleaner audit trail — take it.** For fifty low-risk config values, use Parameter Store.
- *Lambda environment variables* — encrypted at rest, but visible to anyone with console read access, no rotation, and they end up in CloudFormation templates. Fine for `LOG_LEVEL`, never for a token.

**Trade-offs.** $0.40/secret/month plus API-call charges. **Cache the value in the Lambda
execution context** — fetching a secret on every invocation adds ~30 ms and real cost. Use
the AWS Parameters and Secrets Lambda Extension or a module-scope cache with a TTL.

**Delete it?** Secrets end up in environment variables or, eventually, in a commit. This is
how breaches happen.

---

## 2.10 Amazon SQS — buffering and dead letters

**Problem.** Bedrock embedding calls throttle under burst. Step Functions retries help, but
after exhausting retries a failed chunk should land somewhere inspectable, not vanish.

**Why this one.** A DLQ on the ingestion state machine and on async Lambda invocations gives
you a durable "here is exactly what failed and its full payload" queue. Fix the bug, redrive
the queue, done. Without it, failures are a CloudWatch log line you have to reconstruct.

**Alternatives.** SNS (pub/sub, not a durable work queue). Kinesis (ordered streaming at
high throughput — overkill). No DLQ at all (silent data loss; you find out when a customer
asks about a policy the bot has never heard of).

**Trade-offs.** Almost none at this scale. Standard queues are at-least-once and unordered
— fine, because upserts are idempotent.

**Delete it?** Silent failures. The worst kind of failure in a RAG system, because the bot
doesn't error — it just confidently doesn't know something.

---

## 2.11 CloudWatch + AWS X-Ray — observability

**Problem.** "The bot gave a wrong answer to a customer yesterday afternoon." You need to
reconstruct: what they asked, what was retrieved, what the model was sent, what it
returned, and how long each stage took.

**Why this one.** Structured JSON logs → CloudWatch Logs Insights makes that query
tractable. Custom metrics (retrieval latency, tokens per turn, tool-call counts, grounding
failures) drive alarms. X-Ray traces one request across Lambda → Bedrock → Pinecone →
Shopify so you can see *which* hop cost you 2 seconds instead of guessing.

Also enable **Bedrock model invocation logging** to S3 — full prompt/response capture. This
is your ground truth for debugging quality issues and your dataset for building an eval
suite. Turn it on from day one; you cannot retroactively capture it.

**Alternatives.** Datadog / New Relic / Honeycomb (better UX, real money, another vendor).
Langfuse / LangSmith — LLM-specific tracing with prompt versioning and eval tooling, and
genuinely better than CloudWatch *for the LLM layer specifically*. Worth adding later
alongside CloudWatch, not instead of it.

**Trade-offs.** CloudWatch Logs ingestion at $0.50/GB is the sneaky line item — log
verbosely in dev, structured-and-sampled in prod, set retention to 30 days (the default is
"never expire," which quietly bills forever). X-Ray sampling defaults are sane; don't trace
100% in production.

**Delete it?** You are debugging a non-deterministic system by guessing. This is the
service people cut first and regret fastest.

---

## 2.12 IAM — the service nobody lists

Not optional, and the one most likely to be done badly.

**The rules that matter here:**

1. **One role per Lambda, scoped to that Lambda's job.** The chat function needs
   `bedrock:InvokeModelWithResponseStream` on *specific model ARNs*,
   `dynamodb:GetItem/PutItem/Query` on *specific tables*, and
   `secretsmanager:GetSecretValue` on *specific secrets*. Not `bedrock:*`. Not `Resource: "*"`.
2. **The ingestion role cannot read the sessions table.** The chat role cannot write to the
   documents bucket. Separation limits what a compromised function can reach.
3. **No IAM users for automation.** GitHub Actions authenticates via **OIDC federation** —
   short-lived credentials, nothing to leak. See Phase 11. Your `zubair-admin` user is fine
   for local work; CI never gets a key.
4. **Deny-by-default on the data plane.** The bot has zero write permissions to Shopify. It
   is architecturally incapable of cancelling an order, even if perfectly prompt-injected.

That last point is the highest-leverage security control in the entire system. A
prompt-injection attack against an agent can only do what the agent's IAM role and tool
set permit. Constrain the tools, and the attack surface collapses.

---

## 2.13 Cost model

Rough monthly estimates, `us-east-1`, assuming ~8 turns per conversation.

**At 1,000 conversations/month (early days):**

| Service | Cost | Notes |
|---|---|---|
| Bedrock — Sonnet 5 | $60–120 | **Dominant line item.** Before optimization. |
| Lambda | <$2 | ARM64, ~8k invocations |
| DynamoDB | <$3 | On-demand |
| CloudFront + WAF | ~$8 | WAF baseline dominates |
| S3 | <$1 | |
| Pinecone | $0–10 | Free tier likely covers it |
| Secrets Manager | $1.20 | 3 secrets |
| Step Functions | <$1 | |
| CloudWatch | $3–8 | Watch retention settings |
| **Total** | **≈ $80–155/mo** | |

**The three optimizations that actually move the number:**

1. **Prompt caching (~90% off cached input).** Your system prompt, tool definitions, and
   retrieved policy chunks are largely stable across turns. Mark them with `cache_control`
   and repeated turns bill cached input at ~0.1×. On a multi-turn conversation this is the
   single biggest lever. ⚠️ **Bedrock does not support top-level automatic caching** — you
   must place `cache_control` on specific content blocks manually. Also note the minimum
   cacheable prefix differs by model: **Sonnet 5 = 1024 tokens, Haiku 4.5 = 4096 tokens**.
   A prompt under the minimum silently doesn't cache — verify with
   `usage.cache_read_input_tokens`, don't assume.
2. **Model routing.** Classify intent with Haiku 4.5, and answer simple FAQ turns with it
   too. If 60% of turns are simple, blended cost drops ~40%.
3. **Retrieval discipline.** Returning 12 chunks instead of 4 triples your input tokens for
   marginal quality gain. Rerank and cut hard. Measure this — see Phase 4.

Combined, these typically land a 1k-conversation month nearer **$45–70**.

**At 50,000 conversations/month (scaled):** Bedrock is ~95% of spend, roughly $2,500–4,000
optimized. Everything else stays under $200 combined. At that point evaluate provisioned
throughput and distillation. **The lesson: in production LLM systems, infrastructure cost
is a rounding error and inference cost is the whole game.** Optimize tokens, not servers.

---

## 2.14 Service summary

| Service | Role | Deleted → |
|---|---|---|
| Bedrock | Inference + embeddings | No product |
| Lambda | Compute | Pay for idle containers |
| CloudFront + WAF | Edge, CDN, abuse protection | Denial-of-wallet |
| DynamoDB | Sessions, cache, job state | Bot has no memory |
| Pinecone | Vector search | No semantic retrieval |
| S3 | Documents, assets, exports | No durable store or trigger |
| Step Functions | Ingestion orchestration | Fragile, unobservable pipeline |
| EventBridge | Events + scheduling | Manual reindexing |
| Secrets Manager | Credentials | Secrets in code |
| SQS | DLQ | Silent data loss |
| CloudWatch + X-Ray | Observability | Debugging by guesswork |
| IAM | Authorization | Unbounded blast radius |

---

Next: [Phase 3 — Ingestion pipeline](03-ingestion.md)
