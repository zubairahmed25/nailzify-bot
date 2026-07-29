# Field notes: everything that went wrong

Every issue hit while building this bot — Shopify, AWS, RAG, and the widget —
written as **symptom → cause → fix**, because that is how you will meet them
again.

Most of these share a shape: **the failure was silent, or the error pointed
somewhere other than the cause.** That is what made them expensive. The ones
that threw a clear exception cost minutes; the ones that quietly did the wrong
thing cost hours.

Ordered roughly by how much time each one burned.

---

## The five that cost the most

| # | Symptom | Actual cause |
| --- | --- | --- |
| 1 | Every chat request → `403 signature mismatch` | CloudFront OAC **cannot** sign a POST body to a Lambda Function URL |
| 2 | Widget mounted, styled, invisible | Theme CSS `div:empty { display: none }` — **a shadow host matches `:empty`** |
| 3 | `Shopify returned HTTP 403` | Public token sent in the **private** token header |
| 4 | "fully tagged 0/40" | Parser read tags; the data was in **metafields** |
| 5 | Relevance floor rejected 4 of 5 correct answers | Threshold picked by intuition instead of measured |

---

## Shopify

### Tokens

**Three different credentials, similar names, wildly different jobs.**

| Credential | Used for | Where it goes |
| --- | --- | --- |
| Storefront API access token | Reading the catalogue | `Shopify-Storefront-Private-Token` header |
| API secret key / client secret | Verifying App Proxy HMAC | Never sent; used to compute a signature |
| Admin API access token | Nothing here, deliberately | Unused — read-only storefront is the security boundary |

**Public vs private storefront tokens go in DIFFERENT headers.**

```
public    32 hex chars, no prefix   X-Shopify-Storefront-Access-Token
private   shpat_...                 Shopify-Storefront-Private-Token
```

A valid token in the wrong header returns a bare **403**, indistinguishable from
a revoked credential or a missing scope. We hit this twice — once locally, once
after deploying with the public token in Secrets Manager. The error now names
which kind was sent (`storefront-client.ts`).

> ⚠️ **`shpat_` does NOT mean Admin API.** I wrote a preflight check that refused
> tokens with that prefix, believing it identified an Admin token. Delegate and
> custom-app Storefront tokens share it. The check blocked a token that was
> demonstrably working via curl. **Shape checks guess; the API knows.** Validate
> on the error path, never as a precondition.

### API versions

Shopify retires each version after ~12 months, and a retired version fails like a
**bad credential** — not with "this version is gone". Pin it explicitly
(`SHOPIFY_API_VERSION`), put a calendar reminder on it, and when auth mysteriously
breaks, check the version before you check the token.

### Metafields, not tags

Product attributes lived in metafields. The first parser read namespaced tags and
reported *"fully tagged 0/40"* — which read as a merchandising gap and was
actually the parser looking in the wrong place.

```
custom.nail_text        shape    single_line_text_field      35/40
custom.nail_type        style    single_line_text_field      35/40
shopify.color-pattern   colour   list.metaobject_reference   24/40
shopify.finish          finish   list.metaobject_reference   15/40
```

> ⚠️ **`custom.*` and `shopify.*` have different value shapes.** `custom.*` are
> plain strings. `shopify.*` are taxonomy-backed and store **metaobject
> references** — `value` is a JSON array of GIDs like
> `["gid://shopify/Metaobject/100210"]`. Reading `value` directly stores a GID
> where a colour belongs. You must request `references { field(key: "label") }`.

> ⚠️ **`list.*` means multi-valued, and truncating loses real data.** Two products
> were Gloss *and* Metallic. Taking `[0]` made both unfindable by "metallic" while
> emitting a warning about correctly merchandised products.

**`productType` was empty on all 40 products.** It's the field that *should*
distinguish a nail set from a nail file. It didn't, so classification fell back to
a metafield heuristic — validated against the live catalogue rather than assumed.

**Tags were fetched and discarded.** After the tags→metafields migration, `tags`
stayed in the GraphQL query and was read by nothing. Adding "Bridal" to products
changed nothing, and a forced reindex changed nothing. Tags came back later for a
*different* job: occasion, which had been fabricated as `"everyday"` for every
product because nothing recorded it.

### App Proxy

> ⚠️ **Custom apps created in the Shopify admin cannot do App Proxy.** Settings →
> Apps and sales channels → Develop apps has no App proxy section. It requires a
> Partner Dashboard / CLI app with `shopify.app.toml`. This forces a **second
> app**: one holds the Storefront token, the other owns the proxy route.

> ⚠️ **Configuring the proxy is not shipping it.** App proxy settings live in an
> app *version*. Create the version **and release it**, or `/apps/<subpath>`
> returns 404 with the config visibly correct in the UI.

**The proxy URL must include the path your CDN routes on.** Shopify appends the
remaining path:

```
/apps/nailzify-chat/message  →  <proxyURL>/message
```

CloudFront routes `/api/*` to the Lambda, so the proxy URL had to be
`https://…cloudfront.net/api`, not the bare domain. Without `/api` the request
hits the widget bucket and 404s.

**Diagnostic that saved time:** compare against a proxy you know works. The store
had `/apps/track123` returning 200 while `/apps/nailzify-chat` returned 404 —
identical to a subpath that doesn't exist. That isolates "proxy not registered"
from "proxy broken" in one command.

### Theme integration

> ⚠️ **`{% render %}` fails silently.** A snippet name that doesn't resolve
> renders nothing and reports no error. The most common cause is typing
> `name.liquid` into the "name" box — Shopify appends `.liquid` itself, giving
> `name.liquid.liquid`.

**Check you edited the *published* theme.** `Shopify.theme` in page source tells
you the live theme name, id and `role`. Assets live at `/cdn/shop/t/<N>/assets/…`,
so you can test whether a file landed in the live theme by requesting it directly.

**Other schema traps:**
- `onlineStoreUrl` is **null** for products not published to the Online Store
  channel. Falling back to a constructed handle URL beats linking to `null`.
- `quantityAvailable` is **null** without extra token scope. Never depend on it;
  `availableForSale` carries the decision.
- **GraphQL returns HTTP 200 on errors.** A client checking only `response.ok`
  treats a failed query as success and returns an empty product list — which the
  bot reports to a customer as "we don't sell that."

---

## AWS

### Bedrock

> ⚠️ **Current Claude models require cross-region inference profiles.** A bare
> `anthropic.claude-sonnet-4-6` returns `ValidationException`. You need the `us.`
> prefix. The error does not tell you this.

> ⚠️ **Model access is granted per MODEL, not per family.** Sonnet 5 was denied
> while Sonnet 4.6 and Haiku 4.5 worked. The deployed Lambda was pinned to Sonnet
> 5 and returned an empty reply to the customer. **Probe each candidate** with
> `bedrock-runtime converse` rather than assuming.

> ⚠️ **Cohere embed-v4 returns 1536 dimensions by default, not 1024.** The design
> doc assumed 1024. Pin `output_dimension` explicitly, and define the model id and
> dimension in **one shared constant** — ingestion and query must agree exactly,
> and when they don't the symptom is a bot that finds nothing.

**`FALLBACK_MODELS` was documentation pretending to be a mechanism.** The constant
existed, was named "fallback", and nothing fell back to it. Automatic fallback is
still deliberately not implemented: silently switching models on an access error
changes answer quality with nobody aware, and "why did the bot get worse last
Tuesday" is harder to answer than a 403.

### Lambda + CloudFront

> ⚠️ **CloudFront OAC cannot sign a POST body to a Lambda Function URL.** AWS
> docs: *"your users must compute the SHA256 of the body and include the payload
> hash in the `x-amz-content-sha256` header. Lambda doesn't support unsigned
> payloads."* The "user" here is Shopify's App Proxy, which will never attach an
> AWS header. AWS_IAM + OAC works for GET and **cannot** work for this.
>
> Resolution: Function URL `authType: NONE`, plain (non-OAC) origin, with the
> **Shopify HMAC as the actual auth boundary** — which it always was. Cost: the
> Function URL is directly reachable, bypassing WAF. Unsigned requests are
> rejected in ~1ms and never reach Bedrock, so the exposure is Lambda invocations,
> not model spend.

> ⚠️ **A new AWS account has a total Lambda concurrency of 10**, and AWS requires
> ≥10 to remain unreserved — so *any* `reservedConcurrentExecutions` is rejected.
> It also caps you at ~10 simultaneous conversations. Raise it in Service Quotas
> before launch.

**API Gateway cannot stream.** Response streaming requires a Function URL with
`invokeMode: RESPONSE_STREAM`. That single constraint drove the whole edge
architecture.

### CloudFormation / CDK

> ⚠️ **`aws lambda update-function-configuration --environment` REPLACES the whole
> block.** It does not merge. One command run to force a cold start wiped all ten
> variables and the function returned 503.

> ⚠️ **Redeploying does not fix drift.** CloudFormation diffs its template against
> the **last deployed template**, not against reality. The environment block was
> unchanged in the template, so it was left alone. Fix: change *any* value in the
> block to force a rewrite — hence the `CONFIG_REVISION` variable.

**Resource name collisions across stacks.** The Data stack already owned a
documents bucket; the Ingestion stack created one with the same name. Deploy
failed with "already exists", which was the correct outcome. Split stacks by
**blast radius** — what must survive a bad deploy — and give each resource exactly
one owner.

### S3 events

> ⚠️ **EventBridge and bucket notifications have different event shapes AND
> different key encoding.**
>
> | | Shape | Key |
> | --- | --- | --- |
> | Bucket notification | `Records[]` | percent-encoded, spaces → `+` |
> | EventBridge | `detail.bucket.name` / `detail.object.key` | **verbatim** |
>
> Decode the notification key or `size guide.md` 404s. *Don't* decode the
> EventBridge key or a legitimate `+` or `%` in a filename is corrupted. Both bugs
> only appear for filenames a non-engineer types into the S3 console — which is
> exactly who uploads these documents.

**Also:** a bucket with `eventBridgeEnabled: true` should use EventBridge rules.
Attaching a notification to a cross-stack bucket provisions a custom resource that
mutates it from the other stack — two stacks writing one bucket's config.

### DynamoDB

- **`BatchWrite` can partially succeed.** A 200 does not mean everything was
  written; throttled items return in `UnprocessedItems`. Ignoring that field
  silently loses writes under exactly the load where it matters. Retry with
  exponential backoff **and jitter**.
- **400KB item limit.** Storing indexed product ids as one list breaks at ~8,000
  products — mid-run, after the vectors are written, leaving state and index out
  of step. One item per product has no ceiling.
- **TTL is in epoch SECONDS**, not milliseconds.

### Errors and observability

> ⚠️ **`Error.cause` does not survive Lambda's serializer.** Lambda emits
> `errorType`, `errorMessage`, `stack`, and own **enumerable** properties. `cause`
> is non-enumerable, so CloudWatch showed:
>
> ```json
> {"errorType":"$d","errorMessage":"Pinecone upsert failed"}
> ```
>
> — a wrapper message with the reason stripped, from a minified bundle where even
> the class name is mangled. Fold the cause into the message itself. This one fix
> turned a multi-round-trip mystery into a single readable line.

**Secrets:** CDK creates them **empty** by design (never put a value in a
template). Cache the **promise**, not the resolved value — caching after `await`
leaves a window where concurrent callers all miss and all fire their own request.
Evict on failure so one transient error doesn't poison the container.

### Cost

- **Cost Explorer lags** — today's data is absent, not zero. For recent spend,
  measure usage (CloudWatch metrics + your own token logs) instead.
- **WAF is ~$7/month fixed** ($5/WebACL + $1/rule), charged at zero traffic. It
  was ~80% of idle cost.
- Measured: **~$0.0045 per conversation**, ~98% Bedrock. Prompt caching saved more
  than the entire session's bill.

### Pinecone

- **Deleting from a namespace that has never been written returns 404.** A fresh
  index has no namespaces, and delete-before-upsert means this is the *first*
  operation of every new deployment. Treat it as idempotent — but verify the
  namespace is genuinely empty first, because the same 404 could mean
  delete-by-filter is broken, and swallowing *that* silently accumulates stale
  duplicates forever.
- **Index dimension is immutable.** Getting it wrong means deleting and
  re-embedding. Create the index from the same constant the code embeds with.

---

## RAG and prompting

### Thresholds must be measured, never chosen

A hand-picked relevance floor of `0.35` would have **abstained on 4 of 5 correct
answers**. Cross-encoder scores are not percentages and do not read like
confidence.

> ⚠️ **Calibrating on a corpus you don't have produces a floor for a corpus you
> don't have.** The verification script ingested three *invented* documents and
> printed "5/5 correct". Four of five questions targeted documents the store
> didn't own, and the live size guide was never tested. Always calibrate against
> the real corpus.

### What a relevance floor structurally cannot do

Measured on the real corpus, with no shipping policy in it:

```
"how long does delivery take?"  →  return-policy   rerank 0.229
```

That is **higher than two of six genuinely-correct answers**. The reranker isn't
wrong — the return policy really does discuss time windows and international
postage. It's a strong topical match that doesn't answer the question.

**There is no threshold that admits the correct answers and rejects this one.** A
floor separates on-topic from off-topic; it cannot separate *"answers this"* from
*"is about a related subject"*, because it never sees the question and the text
together — only a number.

The defences, in order: **write the missing document**, then the model's own
judgement in the prompt. Not a number.

### Never fabricate an attribute

Untagged products defaulted to `almond` / `medium` / `glossy` and reached the
model **as fact**. A fabricated attribute is a hallucination you manufacture
yourself. Unknown must be `null` end-to-end.

The one surviving default is `occasions: ["everyday"]`, kept because it makes no
claim a customer can be misled by — and it was replaced with real data as soon as
tags provided any. Accessories get **nothing**: a nail file with
`occasions: ["everyday"]` scored points on "what's good for every day?"

### The two-plane rule

Vectors hold **stable descriptive facts** — title, shape, style, colour. Never
price, never stock. An index is a cache with no invalidation: embed "$13.99" today
and the bot quotes it next month from a vector nobody refreshed.

This has to be enforced by **types**, not discipline. `ProductCandidate` (from the
vector store) has no price; `Product` (hydrated from Shopify this request) does.
`selectRecommendations(products: readonly Product[])` cannot be called with
candidates.

It extends to the presentation tier: the `done` event carries typed products with
the price **pre-formatted server-side**, so a card never parses a price out of the
model's prose. A price parsed out of prose was written by a language model.

### Ordering: never destroy before you succeed

```
delete old → chunk → embed → upsert     ❌  a throttled embed deletes the document
chunk → embed everything → delete → upsert  ✅  stale beats absent
```

And **refuse** rather than proceed on an empty document, an empty catalogue, or a
vector/chunk count mismatch. Each is far likelier to be a failed upstream call
than a real change, and acting on any of them destroys good data.

### Metadata drift

`VectorRecord.metadata` is `Record<string, unknown>`, so nothing forces the writer
and reader to agree on key names. A mismatch doesn't crash — it silently drops an
attribute from every product with **no failing test**. Put the mapping in one
place with a round-trip test, and verify the test fails on a planted mismatch.

### Prompt lessons

- **A prompt can contradict itself.** "Ask clarifying questions" plus "use tools"
  produced a model that asked instead of searching. Fixed with an explicit
  priority: *"Search first, ask second."*
- **A tool call is a paragraph boundary.** The model speaks, calls a tool, speaks
  again — two token streams. Concatenating them produced
  `"...for you.According to..."`.
- **Tell it not to narrate.** "Let me look up the sizing guide" is a line the
  customer reads before the answer they asked for.
- **Split facts from judgement.** The card shows price and image (from Shopify);
  the model explains fit. Without that instruction it duplicated every product in
  prose, showing the price twice and a raw URL.
- **Version the prompt.** `SYSTEM_PROMPT_VERSION` is how you answer "why did
  answers change last week".

---

## The widget (third-party JS on someone else's page)

### Shadow DOM does not protect the host

> ⚠️ **A shadow host matches `:empty`.** Shadow content is not light-DOM children.
> The theme shipped `div:empty { display: none }` and hid the entire widget —
> mounted, styled, in the DOM, 0×0, no error anywhere.

The shadow root isolates what is **inside** it. The host sits in the light DOM
where every theme rule can reach it, and `:host` rules **lose to outer-document
rules** by specification. Set critical host properties **inline with
`!important`** — the one place that's correct, because it's a floor under a guest
element, not a specificity fight you chose.

> ⚠️ **`@font-face` is ignored inside a shadow root.** Font faces resolve against
> the document. Inject the stylesheet into `document.head`.

### Bundle budget shapes architecture

25 KB gzipped. React + ReactDOM is ~45 KB *before your code*. **Preact +
`preact/compat`** is ~4 KB with the same API, aliased at build time — you write
ordinary React. Final bundle: 14 KB.

That budget matters because the script loads on **every storefront page**,
including the ones where nobody opens the chat.

### Streaming

- **`EventSource` only does GET.** A message is a POST carrying the proxy
  signature. You must read `response.body` by hand.
- **A chunk is not a frame.** One read may hold three frames or half of one, and a
  multi-byte character can split across reads — `£13.99` becoming `?13.99` reads
  as a broken bot. `TextDecoder({stream:true})` plus a tail buffer.

### iOS specifics

| Symptom | Cause | Fix |
| --- | --- | --- |
| Page scrolls behind the panel | `overflow: hidden` on body **doesn't stop touch scrolling** | `position: fixed` on body; capture and restore `scrollY` |
| Dead gap above the keyboard | `100dvh` tracks browser chrome, **not the keyboard** | Size to `window.visualViewport.height` |
| Page zooms when typing | Focused input `font-size` < 16px | Keep the composer at 16px |
| Flick at list top scrolls the page | Scroll chaining | `overscroll-behavior: contain` |

### Other

- **Navigation destroys the widget.** Tapping a product card reloads the page and
  React state starts empty — the customer follows a recommendation and their
  conversation vanishes. Persist to `sessionStorage` (tab-scoped, cleared on
  close). Treat stored state as **untrusted input** on read.
- **Links must look like links.** `color: inherit` with no underline made them
  pixel-identical to body text — clickable with no sign of it, reported as broken.
- **An accent colour bright enough to look good may fail contrast.** `#FF80AA`
  with white text is 2.35:1 (needs 4.5:1); with dark text it's 5.6:1. Measure
  every pair against the values you actually ship — one failing pair was the
  colour **prices** rendered in.
- **Don't trust an exported SVG's viewBox.** The supplied avatar had
  `viewBox="0 0 680 340"` with artwork in the middle 256×256; at 70px it rendered
  at ~26px. 5.4 KB of its 6.9 KB was exporter `style` noise.

---

## Process lessons

These caused more damage than most of the technical items.

> ⚠️ **`scripts/` and `infra/` were never typechecked.** `tsconfig.json` included
> `packages/*/src` and `services/*/src` only. Every operational script had **zero**
> type checking — and those are the files that touch live infrastructure, where an
> error surfaces only after you've exported credentials and started a run.
> Turning it on surfaced 14 errors, three in one script.

> ⚠️ **Never put a destructive command in a runnable code block.** I wrote an
> `update-function-configuration --environment` command in a fenced block and then
> said "don't run this." The block has a Run button. It wiped the function's
> environment.

**Measure, don't assert.** Live checks contradicted confident assumptions at least
eight times in this project: embedding dimensions, relevance floors, tag location,
token prefixes, API versions, model availability, `productType`, serverless
delete-by-filter. Every one was stated as fact before being checked.

**Verify a guard fails.** A test that cannot fail is worse than no test — it reads
as reassurance. Plant the bug and confirm the guard catches it. The verification
script once reported `fully tagged 40/40` by checking for a word the warnings never
contained; it was structurally incapable of printing anything else.

**Read the test output before pushing.** Chaining `npm test && git push` in one
command and not reading the result put a failing test on `main`.

**Don't over-specify assertions.** A test demanding a byte-exact error message
broke when error messages legitimately improved. Assert the behaviour that matters.

**Fake credentials in tests can trip secret scanners.** A fabricated
`shpat_` + 32 hex string matched GitHub's Shopify-token pattern and blocked the
push — correctly, since a scanner can't tell a fake from a live one. Shape test
fixtures so they exercise the branch without matching real patterns.

---

## The checklist for next time

**Before writing an integration:**
1. Probe the real API for real data shapes. Don't design from documentation alone.
2. Confirm which credential goes in which header, from a working `curl` first.
3. Check per-model / per-feature access explicitly — it is rarely per-family.

**Before trusting a threshold:**
4. Measure it against the **real** corpus. Record the numbers next to the value.
5. Ask what the threshold *cannot* separate, and write that down too.

**Before deploying:**
6. Typecheck everything, including scripts and infra.
7. Ensure wrapped errors carry their cause **in the message**.
8. Check account-level quotas (Lambda concurrency, model access).

**When something fails:**
9. Read the actual log before forming a hypothesis.
10. Compare against a known-working equivalent to isolate the layer.
11. If the error points at credentials, check version pins and header names first.
