/**
 * Composition root — the ONE place concrete adapters are constructed.
 *
 * Everywhere else receives interfaces. That is what keeps the vendor swap
 * promises in docs/02-aws-services.md honest: migrating Pinecone to pgvector,
 * or Bedrock to Claude Platform on AWS, edits this file and nothing else.
 *
 * ⚠️ MODULE-SCOPE CACHING IS LOAD-BEARING. Lambda reuses the execution context
 * across warm invocations. Constructing SDK clients and fetching secrets per
 * request adds ~30-50ms and real API cost for values that change monthly at
 * most. Initialising once outside the handler is the highest-value Lambda
 * optimisation available, and it costs one variable.
 */

import {
  createBedrockEmbedder,
  createBedrockLlmClient,
  createBedrockReranker,
  createPineconeVectorStore,
  createShopifyProductCatalog,
  createStorefrontClient,
  type ModelRoleMap,
} from "@nailzify/adapters";
import {
  createHandleMessage,
  createToolRegistry,
  systemClock,
  type ConversationRepository,
} from "@nailzify/core";

export interface Container {
  readonly handleMessage: ReturnType<typeof createHandleMessage>;
  readonly proxySecret: string;
}

export interface ContainerConfig {
  readonly region: string;
  readonly pineconeApiKey: string;
  readonly pineconeIndex: string;
  readonly shopDomain: string;
  readonly storefrontDomain: string;
  readonly storefrontToken: string;
  readonly shopifyApiVersion: string;
  readonly proxySecret: string;
  readonly models?: ModelRoleMap;
  readonly conversations: ConversationRepository;
  readonly onWarning?: (message: string) => void;
  readonly onUsage?: (usage: { model: string; cacheReadInputTokens: number }) => void;
}

export function buildContainer(config: ContainerConfig): Container {
  const embedder = createBedrockEmbedder({
    region: config.region,
    modelId: "cohere.embed-v4:0",
    // Pinned, not defaulted. Cohere v4 returns 1536 dimensions by default and
    // the index is 1024 — relying on the default fails every upsert. Pinning
    // also stops the adapter's declared dimensions drifting from reality.
    dimensions: 1024,
  });

  const reranker = createBedrockReranker({ region: config.region });

  const vectors = createPineconeVectorStore({
    apiKey: config.pineconeApiKey,
    indexName: config.pineconeIndex,
  });

  const catalog = createShopifyProductCatalog({
    client: createStorefrontClient({
      shopDomain: config.shopDomain,
      accessToken: config.storefrontToken,
      apiVersion: config.shopifyApiVersion,
    }),
    storefrontDomain: config.storefrontDomain,
    ...(config.onWarning ? { onWarning: config.onWarning } : {}),
  });

  const llm = createBedrockLlmClient({
    region: config.region,
    ...(config.models ? { models: config.models } : {}),
    ...(config.onUsage ? { onUsage: config.onUsage } : {}),
  });

  const tools = createToolRegistry({
    embedder,
    vectors,
    reranker,
    catalog,
    clock: systemClock,
  });

  return {
    handleMessage: createHandleMessage({
      llm,
      conversations: config.conversations,
      tools,
      clock: systemClock,
    }),
    proxySecret: config.proxySecret,
  };
}
