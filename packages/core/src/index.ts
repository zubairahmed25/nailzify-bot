/**
 * @nailzify/core — domain model and ports.
 *
 * This package must never import infrastructure. No `@aws-sdk/*`, no
 * `@pinecone-database/*`, no `aws-lambda`. The rule is enforced by ESLint and by
 * a grep in CI, because a rule nobody checks is a rule that decays.
 *
 * See docs/07-backend.md for the reasoning.
 */

// ---- shared primitives ----
export * from "./domain/shared/brand.js";
export * from "./domain/shared/result.js";
export * from "./domain/shared/errors.js";
export * from "./domain/shared/money.js";

// ---- conversation ----
export * from "./domain/conversation/message.js";
export * from "./domain/conversation/session.js";
export * from "./domain/conversation/window.js";

// ---- knowledge plane ----
export * from "./domain/knowledge/chunk.js";
export * from "./domain/knowledge/chunking.js";
export * from "./domain/knowledge/retrieval-policy.js";

// ---- catalog plane ----
export * from "./domain/catalog/product.js";
export * from "./domain/catalog/recommendation.js";

// ---- prompts ----
export * from "./prompts/system-prompt.js";
export * from "./prompts/tools.js";

// ---- application ----
export * from "./application/retrieval.js";
export * from "./application/tool-registry.js";
export * from "./application/handle-message.js";

// ---- ports ----
export * from "./ports/index.js";
