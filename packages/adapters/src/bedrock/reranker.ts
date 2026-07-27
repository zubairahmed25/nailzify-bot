/**
 * Bedrock reranker — implements the `Reranker` port using `cohere.rerank-v3-5:0`.
 *
 * ============================================================================
 * WHY THIS EXISTS (and why it turned out to be mandatory)
 * ============================================================================
 *
 * A retrieval embedding is computed BEFORE the model has seen your question. It
 * is a lossy compression optimised for the average query — fast, which is why
 * vector search scales, but approximate.
 *
 *       Bi-encoder (retrieval)            Cross-encoder (reranking)
 *   embed(query) ─┐                    ┌── [query + document] ──┐
 *                 ├─ cosine → score    │        one model        │→ relevance
 *   embed(doc)  ──┘                    └────────────────────────┘
 *   ✅ docs precomputed, fast            ❌ must run per pair, slower
 *   ❌ never sees them together          ✅ full cross-attention
 *
 * Measured across the full Nailzify verification corpus (5 questions + 1
 * off-topic control), reranking helps — but less uniformly than a single
 * hand-picked example suggests:
 *
 *                        correct range     best wrong    worst-case separation
 *   cosine (embed-v4)     0.184 – 0.590       0.174              1.06x
 *   rerank (rerank-v3-5)  0.053 – 0.738       0.039              1.33x
 *
 * The headline number understates it. FOUR of five correct answers rerank to
 * 0.207+, which is 5-19x above the off-topic ceiling — comfortably separable.
 * The worst case is one genuinely hard query ("will I be charged extra fees at
 * the border?" against text reading "customs duties or import taxes"), which
 * both the bi-encoder and the cross-encoder find weak.
 *
 * So: reranking materially improves separation and, on this corpus, also
 * improved a top-1 result (an "opened packet" question moved from the general
 * Eligibility section to the more specific Hygiene Exclusions one). It is not a
 * silver bullet for queries whose vocabulary genuinely diverges from the source.
 * That residual gap is why the system prompt's grounding instruction is a second
 * layer rather than redundant — see docs/04-retrieval.md §4.7.
 *
 * ⚠️ Wire format verified against the live API. Cohere rerank on Bedrock is
 * called through `InvokeModel` (not the bedrock-agent-runtime Rerank API) and
 * returns `{ results: [{ index, relevance_score }] }` — indices into the
 * documents array you sent, NOT the documents themselves.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { Reranker, ScoredChunk } from "@nailzify/core";
import { LlmThrottled, LlmUnavailable, embeddingText } from "@nailzify/core";

export interface BedrockRerankerConfig {
  readonly region: string;
  /** Default `cohere.rerank-v3-5:0`. */
  readonly modelId?: string;
  /**
   * Send the contextual header along with the chunk text.
   *
   * Defaults to true. The cross-encoder benefits from the same situating
   * context the embedding did — "Items must be returned in original packaging"
   * is ambiguous without knowing which policy and which window it belongs to.
   * Costs a few tokens per document; worth it.
   */
  readonly includeContextHeader?: boolean;
  /**
   * SDK retry attempts. Defaults to 5, higher than the embedder's 3.
   *
   * ⚠️ MEASURED: on-demand throughput for `cohere.rerank-v3-5:0` is TIGHT — a
   * verification script issuing sequential reranks hit `ThrottlingException`
   * after three calls. This is not a burst of traffic; it is three requests.
   *
   * Consequences for production, in order of importance:
   *   1. Rerank sits in the CHAT request path, so a throttle is customer-facing
   *      latency, not a background retry. Budget for it.
   *   2. Degrade rather than fail — a throttled rerank should fall back to
   *      cosine ordering with a metric, not error the turn. The caller owns that
   *      decision, which is why this adapter still throws a typed, retryable
   *      error rather than silently swallowing it.
   *   3. If reranking every turn proves unaffordable at your rate limit,
   *      provisioned throughput is the lever — or skip rerank for intents where
   *      the eval set shows precision holds without it.
   */
  readonly maxAttempts?: number;
  readonly client?: BedrockRuntimeClient;
}

interface CohereRerankResult {
  readonly index: number;
  readonly relevance_score: number;
}

export function createBedrockReranker(config: BedrockRerankerConfig): Reranker {
  const client =
    config.client ??
    new BedrockRuntimeClient({
      region: config.region,
      // The SDK applies exponential backoff with jitter between attempts.
      maxAttempts: config.maxAttempts ?? 5,
    });
  const modelId = config.modelId ?? "cohere.rerank-v3-5:0";
  const includeHeader = config.includeContextHeader ?? true;

  return {
    async rerank(query, chunks, topN) {
      // Nothing to reorder. Skipping the call also skips the cost and latency —
      // worth guarding, because an empty retrieval is a normal outcome.
      if (chunks.length === 0) return [];
      if (chunks.length === 1) return chunks.slice(0, topN);

      const documents = chunks.map((scored) =>
        includeHeader ? embeddingText(scored.chunk) : scored.chunk.text,
      );

      let response;
      try {
        response = await client.send(
          new InvokeModelCommand({
            modelId,
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify({
              query,
              documents,
              top_n: Math.min(topN, documents.length),
              // Cohere's Bedrock integration requires this. Omitting it returns
              // a validation error rather than defaulting.
              api_version: 2,
            }),
          }),
        );
      } catch (cause) {
        throw toDomainError(cause);
      }

      const parsed: unknown = JSON.parse(new TextDecoder().decode(response.body));
      const results = (parsed as { results?: CohereRerankResult[] })?.results;

      if (!Array.isArray(results)) {
        throw new LlmUnavailable("Unexpected Cohere rerank response shape");
      }

      return results.flatMap((result) => {
        const original = chunks[result.index];
        // Defensive: an out-of-range index would mean the API contract changed.
        // Dropping the entry beats indexing undefined into the answer.
        if (!original) return [];
        return [
          {
            ...original,
            // The raw cosine score is PRESERVED, not overwritten. Keeping both
            // lets you compare distributions in telemetry — which is how the
            // 1.06x-vs-8.4x separation finding was made in the first place.
            rerankScore: result.relevance_score,
          } satisfies ScoredChunk,
        ];
      });
    },
  };
}

function toDomainError(cause: unknown): Error {
  const name = (cause as { name?: string })?.name ?? "";
  const message = (cause as { message?: string })?.message ?? "Bedrock rerank failed";

  if (name === "ThrottlingException" || name === "TooManyRequestsException") {
    return new LlmThrottled(message, null, { cause });
  }
  return new LlmUnavailable(message, { cause });
}
