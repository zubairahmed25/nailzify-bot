/**
 * @nailzify/adapters — infrastructure implementations of the ports in
 * @nailzify/core.
 *
 * This package is where AWS, Pinecone and Shopify SDKs are allowed to live. The
 * dependency direction is one-way: adapters import core, core never imports
 * adapters (docs/07-backend.md).
 */

export { createBedrockEmbedder, type BedrockEmbedderConfig } from "./bedrock/embedder.js";
export { createBedrockReranker, type BedrockRerankerConfig } from "./bedrock/reranker.js";
export { createPineconeVectorStore, type PineconeConfig } from "./pinecone/vector-store.js";
export {
  createInMemoryVectorStore,
  cosineSimilarity,
  type InMemoryVectorStore,
} from "./memory/vector-store.js";
