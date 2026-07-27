# Phase 7 — Backend Structure

## 7.1 The rule

**The domain layer must not know that AWS exists.**

If `packages/core` imports `@aws-sdk/*`, `@pinecone-database/*`, or `aws-lambda`, the
boundary has leaked. That single rule gives you three things that are otherwise expensive:

1. **Unit tests with no mocks of AWS.** Test the recommendation logic by passing a fake
   product repository. Fast, deterministic, no credentials.
2. **Vendor swaps become adapter swaps.** Phase 2 said "put Pinecone behind a port so
   migrating to `pgvector` or S3 Vectors is an adapter change." This is where that promise
   is kept — or broken.
3. **Business rules stay readable.** "Never recommend an out-of-stock product" should be
   legible in one file, not scattered across a Lambda handler and a GraphQL client.

The direction of dependency is the whole idea:

```
   handlers  ──►  application  ──►  domain  ◄──  infrastructure
   (Lambda)       (use cases)      (rules)       (AWS, Shopify, Pinecone)
                                      ▲
                              everything points inward;
                              domain points at nothing
```

Infrastructure depends on domain by *implementing its interfaces*. Domain never imports
infrastructure. This is dependency inversion, and it's the only architectural pattern in
this document that pays for itself immediately.

---

## 7.2 Layout

```
nailzify-bot/
│
├── packages/core/                        ← ZERO AWS imports. Enforced in CI.
│   └── src/
│       ├── domain/
│       │   ├── conversation/
│       │   │   ├── message.ts            Message, Role, ToolCall
│       │   │   ├── session.ts            Session aggregate, turn limits
│       │   │   └── window.ts             history windowing + summarization policy
│       │   ├── knowledge/
│       │   │   ├── chunk.ts              Chunk, Citation, RelevanceScore
│       │   │   └── retrieval-policy.ts   relevance floor, k, abstention rules
│       │   ├── catalog/
│       │   │   ├── product.ts            Product, Variant, Availability
│       │   │   └── recommendation.ts     shape/length/occasion matching rules
│       │   └── errors.ts                 domain errors, no HTTP status codes
│       │
│       ├── ports/                        ← interfaces the outside world implements
│       │   ├── llm.ts                    LlmClient  (Bedrock | Claude Platform on AWS)
│       │   ├── embedder.ts               Embedder
│       │   ├── vector-store.ts           VectorStore (Pinecone | pgvector | S3 Vectors)
│       │   ├── reranker.ts               Reranker
│       │   ├── product-catalog.ts        ProductCatalog (Shopify)
│       │   ├── conversation-repo.ts      ConversationRepository (DynamoDB)
│       │   ├── secrets.ts                SecretsProvider
│       │   └── clock.ts                  Clock — inject time, never call Date.now()
│       │
│       ├── application/                  ← use cases; orchestration only
│       │   ├── handle-message.ts         THE main use case
│       │   ├── search-knowledge.ts
│       │   ├── recommend-products.ts
│       │   ├── ingest-document.ts
│       │   └── sync-catalog.ts
│       │
│       └── prompts/
│           ├── system-prompt.ts          versioned, hash-stamped for cache debugging
│           ├── tools.ts                  tool definitions (sorted — cache stability)
│           └── query-rewrite.ts
│
├── services/api/                         ← chat Lambda
│   └── src/
│       ├── handler.ts                    streamifyResponse entry point
│       ├── middleware/
│       │   ├── verify-shopify-hmac.ts    timing-safe comparison
│       │   ├── validate-body.ts          Zod
│       │   └── rate-limit.ts             per-session turn budget
│       ├── streaming/
│       │   └── sse.ts                    SSE framing, heartbeats
│       └── composition-root.ts           ← the ONLY place adapters are wired
│
├── services/ingest/                      ← Step Functions task Lambdas
│   └── src/handlers/{extract,chunk,embed,index,verify}.ts
│
├── packages/adapters/                    ← infrastructure. Imports AWS freely.
│   └── src/
│       ├── bedrock/{llm.ts,embedder.ts}
│       ├── pinecone/vector-store.ts
│       ├── shopify/{storefront-client.ts,product-catalog.ts}
│       ├── dynamodb/conversation-repo.ts
│       ├── secrets/secrets-manager.ts
│       └── observability/{logger.ts,metrics.ts,tracer.ts}
│
├── infra/                                ← AWS CDK
│   ├── bin/app.ts
│   └── lib/{network,data,api,ingestion,observability}-stack.ts
│
└── web/widget/                           ← React (Phase 8)
```

---

## 7.3 Ports — the contracts

Keep them narrow. A port should express what the *domain* needs, not what the *vendor*
offers. `VectorStore` has three methods because that's all the domain does — Pinecone's
SDK has dozens, and none of them belong here.

```ts
// packages/core/src/ports/vector-store.ts
export interface VectorStore {
  upsert(namespace: Namespace, vectors: VectorRecord[]): Promise<void>;
  query(namespace: Namespace, opts: QueryOptions): Promise<ScoredChunk[]>;
  deleteByFilter(namespace: Namespace, filter: MetadataFilter): Promise<void>;
}

export interface QueryOptions {
  vector: number[];
  topK: number;
  filter?: MetadataFilter;
  includeMetadata?: boolean;
}
```

```ts
// packages/core/src/ports/product-catalog.ts
export interface ProductCatalog {
  /** Hydrate live, authoritative product data. The ONLY source of price and stock. */
  getByIds(ids: ProductId[]): Promise<Product[]>;
  getByHandle(handle: string): Promise<Product | null>;
  listAll(cursor?: string): Promise<Page<Product>>;   // ingestion only
}
```

That doc comment is load-bearing. It's the one place a future maintainer will look before
adding a `price` field to the DynamoDB cache "for performance."

```ts
// packages/core/src/ports/llm.ts — abstracts Bedrock vs Claude Platform on AWS
export interface LlmClient {
  stream(req: LlmRequest): AsyncIterable<LlmStreamEvent>;
  complete(req: LlmRequest): Promise<LlmResponse>;
}
```

---

## 7.4 The main use case

`handle-message.ts` is the heart of the system. It reads as a description of the flow,
which is the test of whether the layering worked:

```ts
export class HandleMessage {
  constructor(
    private readonly llm: LlmClient,
    private readonly conversations: ConversationRepository,
    private readonly tools: ToolRegistry,
    private readonly clock: Clock,
  ) {}

  async *execute(cmd: HandleMessageCommand): AsyncIterable<ChatEvent> {
    const session = await this.conversations.loadOrCreate(cmd.sessionId, cmd.customerId);
    session.assertWithinTurnBudget();                  // domain rule, throws a domain error

    const window = buildWindow(session, cmd.message);  // pure function — trivially testable

    let response = await this.llm.complete({
      system: SYSTEM_PROMPT,
      tools: this.tools.definitions(),
      messages: window.messages,
      cacheBreakpointAfterSystem: true,
    });

    // Tool loop, bounded. An unbounded agent loop is a cost incident waiting to happen.
    let hops = 0;
    while (response.stopReason === "tool_use" && hops++ < MAX_TOOL_HOPS) {
      const results = await Promise.all(
        response.toolCalls.map((c) => this.tools.execute(c)),   // parallel
      );
      window.messages.push(assistantTurn(response), toolResultsTurn(results));  // ONE user turn
      response = await this.llm.complete({ ...same, messages: window.messages });
    }

    for await (const event of this.llm.stream({ ...same, messages: window.messages })) {
      yield event;
    }

    await this.conversations.appendTurn(session, cmd.message, response, this.clock.now());
  }
}
```

Note the details that are easy to get wrong and hard to notice:

- **`MAX_TOOL_HOPS`** — an unbounded loop is how you wake up to a four-figure Bedrock bill.
  Cap it (4 is generous), and when the cap is hit, return what you have with a note.
- **All tool results in ONE user turn.** Splitting them across messages silently trains the
  model out of parallel tool calls — a performance regression with no error to catch.
- **`Clock` injected.** Testing time-dependent logic against a real clock produces flaky
  tests. Inject it and your tests are deterministic.
- **The use case yields events**, so the transport (SSE) is the handler's concern, not the
  domain's.

---

## 7.5 Composition root

Exactly one file per service constructs concrete adapters. Everywhere else receives
interfaces.

```ts
// services/api/src/composition-root.ts
let cached: Container | undefined;   // module scope = survives warm invocations

export async function container(): Promise<Container> {
  if (cached) return cached;         // don't re-fetch secrets on every request

  const secrets = new SecretsManagerProvider();
  const [pineconeKey, shopifyToken] = await Promise.all([
    secrets.get("nailzify/pinecone-api-key"),
    secrets.get("nailzify/shopify-storefront-token"),
  ]);

  const llm       = new BedrockLlmClient({ region: "us-east-1", model: MODELS.chat });
  const embedder  = new BedrockEmbedder({ region: "us-east-1", model: MODELS.embed });
  const vectors   = new PineconeVectorStore({ apiKey: pineconeKey, index: "nailzify-prod" });
  const catalog   = new ShopifyProductCatalog({ token: shopifyToken, domain: SHOP_DOMAIN });
  const repo      = new DynamoConversationRepository({ table: TABLE_NAME });

  cached = { handleMessage: new HandleMessage(llm, repo, registry(...), systemClock) };
  return cached;
}
```

**Why module-scope caching matters.** Lambda reuses the execution context across warm
invocations. Constructing SDK clients and fetching secrets on every request adds ~30–50 ms
and real API cost. Initialize once outside the handler; it's the highest-value Lambda
optimization there is and it costs one line.

---

## 7.6 Error handling

Three tiers, and keeping them separate is what stops HTTP status codes leaking into
business logic:

```ts
// domain — no HTTP, no AWS
export class TurnBudgetExceeded extends DomainError {}
export class NoRelevantKnowledge extends DomainError {}

// infrastructure — wraps vendor failures
export class VectorStoreUnavailable extends InfrastructureError {
  constructor(cause: unknown) { super("vector store unavailable", { cause, retryable: true }); }
}

// transport — the only layer that knows about HTTP
function toHttpResponse(e: unknown) {
  if (e instanceof TurnBudgetExceeded) return { status: 429, body: {...} };
  if (e instanceof InfrastructureError && e.retryable) return { status: 503, body: {...} };
  logger.error({ err: e });                       // log the detail
  return { status: 500, body: { message: "Something went wrong." } };  // leak nothing
}
```

**Always preserve `cause`** (`new Error("...", { cause })`) — losing the original stack
trace when wrapping is the most common way debugging gets hard.

**Tool errors are not exceptions.** A failing tool returns a value:

```ts
type ToolResult<T> =
  | { ok: true;  data: T }
  | { ok: false; error: string; retryable: boolean };
```

Because a tool failure isn't an application failure — it's information the *model* needs
in order to apologize gracefully. Throwing would abort the turn; returning lets the
conversation continue.

---

## 7.7 Configuration

```ts
// packages/core/src/config.ts — parsed ONCE at cold start, validated, then frozen
const ConfigSchema = z.object({
  AWS_REGION:        z.string().default("us-east-1"),
  BEDROCK_CHAT_MODEL: z.string().default("anthropic.claude-sonnet-5"),
  BEDROCK_FAST_MODEL: z.string().default("anthropic.claude-haiku-4-5"),
  BEDROCK_EMBED_MODEL: z.string().default("cohere.embed-v4:0"),
  PINECONE_INDEX:    z.string(),
  DYNAMO_TABLE:      z.string(),
  SHOP_DOMAIN:       z.string(),
  MAX_TOOL_HOPS:     z.coerce.number().default(4),
  RETRIEVAL_TOP_K:   z.coerce.number().default(20),
  RERANK_TOP_N:      z.coerce.number().default(4),
  RELEVANCE_FLOOR:   z.coerce.number().default(0.35),
  LOG_LEVEL:         z.enum(["debug","info","warn","error"]).default("info"),
});
export const config = ConfigSchema.parse(process.env);
```

Fail fast at cold start on a missing variable. Discovering `PINECONE_INDEX` is undefined
in the middle of a customer conversation is strictly worse than the Lambda refusing to
initialize.

Non-secret tunables (`RELEVANCE_FLOOR`, `RERANK_TOP_N`) live in environment variables so
you can tune retrieval without a code deploy. Secrets never do.

---

## 7.8 Testing

```
tests/
├── unit/            domain + application. No AWS, no network. < 2 s total.
├── integration/     adapters against LocalStack / real dev resources.
├── contract/        recorded Shopify + Bedrock responses; catch upstream drift.
└── eval/            ← the one that matters most for an LLM system
    ├── golden-set.jsonl        50+ real questions with expected sources
    ├── retrieval.eval.ts       recall@5, precision@4
    └── generation.eval.ts      LLM-as-judge groundedness + refusal correctness
```

**The eval suite is the part that distinguishes a production LLM system from a demo.**
Unit tests tell you the code runs. Evals tell you the *system answers correctly* — and
they're the only way to know whether a prompt tweak or a chunk-size change helped or
quietly regressed something.

Rules that make evals actually useful:

- Build the golden set from **real customer questions** — your existing support inbox is
  the single most valuable asset you have for this. Fifty real questions beat five hundred
  invented ones.
- Every thumbs-down in production becomes a candidate eval case.
- Run retrieval evals on **every PR** (fast, deterministic, cheap).
- Run generation evals **nightly and before deploy** (slower, costs tokens).
- **Treat an eval regression as a failing test.** This is the discipline: prompt changes
  are code changes and must pass CI. Without it you're tuning by vibes, and vibes don't
  catch the regression where fixing shipping answers broke sizing answers.

---

## 7.9 Enforcing the boundary in CI

A rule nobody checks is a rule that decays. Fail the build:

```jsonc
// .eslintrc — packages/core must not import infrastructure
{
  "overrides": [{
    "files": ["packages/core/**/*.ts"],
    "rules": {
      "no-restricted-imports": ["error", {
        "patterns": ["@aws-sdk/*", "@pinecone-database/*", "aws-lambda", "@shopify/*"]
      }]
    }
  }]
}
```

Six months from now, someone in a hurry will import the DynamoDB client into a domain file
because it's convenient. This is the line of config that stops it, and it's why the
architecture will still be intact when you come back to it.

---

Next: [Phase 8 — Frontend architecture](08-frontend.md)
