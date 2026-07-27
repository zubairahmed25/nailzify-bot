/**
 * Bedrock embedder — implements the `Embedder` port.
 *
 * Two model families are supported because they fail differently and it is worth
 * being able to switch without touching call sites:
 *
 *   cohere.embed-v4:0            better retrieval quality; supports input_type
 *   amazon.titan-embed-text-v2:0 cheaper; no input_type
 *
 * ⚠️ THE WIRE FORMAT BELOW WAS VERIFIED AGAINST THE LIVE API, not inferred.
 * Cohere v4 returns `{ embeddings: { float: number[][] } }` and defaults to
 * **1536 dimensions**, not the 1024 the design doc originally assumed. Building
 * on that assumption would have failed every upsert with a dimension mismatch
 * once the index was created at 1024.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { Embedder, EmbeddingPurpose } from "@nailzify/core";
import { LlmThrottled, LlmUnavailable } from "@nailzify/core";

/** Cohere accepts at most 96 texts per call. Exceeding it is a hard API error. */
const COHERE_MAX_BATCH = 96;

export interface BedrockEmbedderConfig {
  readonly region: string;
  readonly modelId: string;
  /**
   * Output dimensionality.
   *
   * PIN THIS EXPLICITLY. Relying on the model default means the adapter's
   * declared `dimensions` and the vectors it actually returns can drift apart —
   * silently, until an upsert fails in production. Cohere v4 defaults to 1536;
   * we ask for 1024 to match the index and save ~33% vector storage. Cohere v4
   * uses Matryoshka representations, so truncating to 1024 costs very little
   * retrieval quality.
   */
  readonly dimensions: number;
  readonly client?: BedrockRuntimeClient;
}

export function createBedrockEmbedder(config: BedrockEmbedderConfig): Embedder {
  // Construct once, at module scope in the composition root. Rebuilding the SDK
  // client per invocation re-resolves credentials and adds latency for nothing.
  const client =
    config.client ?? new BedrockRuntimeClient({ region: config.region, maxAttempts: 3 });

  const isCohere = config.modelId.startsWith("cohere.");

  async function invoke(texts: readonly string[], purpose: EmbeddingPurpose) {
    const body = isCohere
      ? cohereBody(texts, purpose, config.dimensions)
      : titanBody(texts, config.dimensions);

    let response;
    try {
      response = await client.send(
        new InvokeModelCommand({
          modelId: config.modelId,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify(body),
        }),
      );
    } catch (cause) {
      // Translate vendor errors into domain-shaped ones at the boundary. The
      // caller decides retry policy from `retryable`, without importing an AWS
      // error class into application code.
      throw toDomainError(cause);
    }

    const parsed: unknown = JSON.parse(new TextDecoder().decode(response.body));
    return isCohere ? parseCohere(parsed) : parseTitan(parsed);
  }

  return {
    dimensions: config.dimensions,
    modelId: config.modelId,

    async embed(text, purpose) {
      const [vector] = await invoke([text], purpose);
      if (!vector) throw new LlmUnavailable("Embedding response contained no vector");
      return vector;
    },

    async embedBatch(texts, purpose) {
      if (texts.length === 0) return [];

      // Titan's InvokeModel takes one text at a time; Cohere takes up to 96.
      const batchSize = isCohere ? COHERE_MAX_BATCH : 1;
      const out: (readonly number[])[] = [];

      for (let i = 0; i < texts.length; i += batchSize) {
        // Sequential on purpose. Firing every batch concurrently is the fastest
        // way to hit Bedrock's per-minute token limit during a bulk ingest, and
        // ingestion is asynchronous — nobody is waiting on it. Step Functions
        // controls parallelism at a level where it can also retry.
        out.push(...(await invoke(texts.slice(i, i + batchSize), purpose)));
      }

      if (out.length !== texts.length) {
        throw new LlmUnavailable(
          `Expected ${texts.length} embeddings, received ${out.length}`,
        );
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

/**
 * Asymmetric embedding.
 *
 * A question ("how long do these last?") and a policy chunk ("wear time is
 * typically 7-10 days...") have different shapes. Telling Cohere which side it
 * is embedding measurably improves matching.
 *
 * Getting this backwards degrades retrieval with NO ERROR — it is one of the
 * genuinely common silent RAG bugs. The port makes `purpose` a required
 * argument so a caller cannot omit it; this function is the only place the
 * mapping lives.
 */
function cohereBody(texts: readonly string[], purpose: EmbeddingPurpose, dimensions: number) {
  return {
    texts: [...texts],
    input_type: purpose === "query" ? "search_query" : "search_document",
    embedding_types: ["float"],
    output_dimension: dimensions,
    truncate: "END",
  };
}

/** Titan has no input_type — the same vector serves documents and queries. */
function titanBody(texts: readonly string[], dimensions: number) {
  return { inputText: texts[0] ?? "", dimensions, normalize: true };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseCohere(parsed: unknown): readonly (readonly number[])[] {
  const embeddings = (parsed as { embeddings?: { float?: number[][] } | number[][] })
    ?.embeddings;

  // v4 returns { float: [...] }; older Cohere versions returned a bare array.
  // Accepting both means a model swap does not require an adapter change.
  const vectors = Array.isArray(embeddings) ? embeddings : embeddings?.float;

  if (!Array.isArray(vectors)) {
    throw new LlmUnavailable("Unexpected Cohere embedding response shape");
  }
  return vectors;
}

function parseTitan(parsed: unknown): readonly (readonly number[])[] {
  const embedding = (parsed as { embedding?: number[] })?.embedding;
  if (!Array.isArray(embedding)) {
    throw new LlmUnavailable("Unexpected Titan embedding response shape");
  }
  return [embedding];
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

function toDomainError(cause: unknown): Error {
  const name = (cause as { name?: string })?.name ?? "";
  const message = (cause as { message?: string })?.message ?? "Bedrock request failed";

  // Throttling is expected during bulk ingest and is retryable with backoff.
  // Distinguishing it lets Step Functions apply a different retry policy than
  // it would for a malformed request.
  if (name === "ThrottlingException" || name === "TooManyRequestsException") {
    return new LlmThrottled(message, null, { cause });
  }
  return new LlmUnavailable(message, { cause });
}
