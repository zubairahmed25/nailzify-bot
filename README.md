# Nailzify AI Concierge

Production RAG chatbot for the Nailzify Shopify store (press-on nails). Answers policy
questions from company documents, recommends products from live Shopify data, and never
invents a price, a size, or a stock level.

**Stack:** AWS (Bedrock, Lambda, DynamoDB, S3, Step Functions) · Node.js/TypeScript ·
React widget in a Shopify Theme App Extension · Pinecone Serverless for vectors ·
AWS CDK for infrastructure · GitHub Actions + OIDC for CI/CD.

---

## The one idea that drives the whole design

Most Shopify RAG chatbots embed the product catalog into a vector database and let the
LLM answer from the retrieved text. That design hallucinates prices, because a vector is
a **photograph of a product taken at ingest time**. The moment you run a sale, the
photograph lies — and the bot confidently quotes last week's price.

So this system has **two separate retrieval planes**:

| Plane | Contains | Mechanism | Freshness |
|---|---|---|---|
| **Knowledge plane** | Shipping policy, returns, sizing guide, nail care, FAQs | RAG — semantic search over embedded chunks | Re-ingested on document change |
| **Catalog plane** | Products, prices, variants, inventory, images | **Tool calls to the Shopify Storefront API** | Live, per request |

Vectors are used on the catalog side too — but *only to shortlist candidate product IDs*
by meaning ("almond-shaped, short, autumn colours, under $20"). Every authoritative field
the customer actually sees — price, availability, variant name, product URL — is
re-fetched live from Shopify in the same turn before the model is allowed to mention it.

That is the anti-hallucination guarantee, and it is architectural, not a prompt
instruction. Prompts are advisory; a model can only cite a price if a tool returned one.

---

## Documentation

Read these in order. Each answers *what problem does this solve, why this choice, what
else exists, what we trade away, and what breaks if we delete it.*

| Phase | Document | Covers |
|---|---|---|
| 1 | [Architecture](docs/01-architecture.md) | System diagram, request flow, the two-plane model |
| 2 | [AWS services](docs/02-aws-services.md) | Every service, why it's there, alternatives, trade-offs |
| 3 | [Ingestion pipeline](docs/03-ingestion.md) | PDF upload → parse → chunk → embed → index |
| 4 | [Retrieval pipeline](docs/04-retrieval.md) | Hybrid search, reranking, grounding, tool design |
| 5 | [Chat lifecycle](docs/05-chat-lifecycle.md) | One request, end to end, with latency budget |
| 6 | [Data model](docs/06-data-model.md) | DynamoDB tables, access patterns, Pinecone schema |
| 7 | [Backend structure](docs/07-backend.md) | Clean architecture, folder layout, boundaries |
| 8 | [Frontend](docs/08-frontend.md) | React widget, Shopify App Proxy, streaming UI |
| 9 | [Deployment](docs/09-deployment.md) | CDK stacks, environments, rollout strategy |
| 10 | [Operations](docs/10-operations.md) | Monitoring, logging, security, cost optimization |
| 11 | [CI/CD](docs/11-cicd.md) | GitHub Actions + OIDC, quality gates, promotion |
| 12 | [Roadmap](docs/12-roadmap.md) | Image search, personalization, analytics, agents |

---

## Repository layout

```
nailzify-bot/
├── docs/                 Architecture and decision records
├── infra/                AWS CDK app (TypeScript) — all infrastructure
├── packages/core/        Domain logic, shared types, ports (no AWS imports)
├── services/api/         Chat Lambda — streaming, orchestration, tools
├── services/ingest/      Document ingestion Lambdas (Step Functions tasks)
├── web/widget/           React chat widget bundled for the Shopify theme
└── .github/workflows/    CI/CD
```

## Prerequisites

- AWS account with Bedrock model access enabled in `us-east-1`
- Shopify Partner account + a custom app on the Nailzify store
- Pinecone account (free tier is enough to start)
- Node.js 22+

## Status

Design phase. Infrastructure and services are being built out phase by phase.
