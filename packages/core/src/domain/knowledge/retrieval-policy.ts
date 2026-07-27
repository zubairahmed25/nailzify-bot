/**
 * Retrieval policy — deciding whether we actually know the answer.
 *
 * ============================================================================
 * THE MOST IMPORTANT ANTI-HALLUCINATION CONTROL IN THE SYSTEM
 * ============================================================================
 *
 * Vector search ALWAYS returns something. Ask "what's your policy on
 * cryptocurrency payments?" against a corpus with nothing on the subject, and it
 * will still hand back the four least-bad chunks with scores like 0.31. There is
 * no error. Nothing failed.
 *
 * Hand those to a model and it will do what models do: read the material and
 * write a fluent, confident answer assembled from text that does not contain
 * one. That is the failure mode this project exists to prevent, and it returns
 * HTTP 200.
 *
 * So: below a relevance floor, we return NOTHING and let the model say it does
 * not know. Four weakly-relevant chunks are strictly worse than zero — zero
 * prompts honest abstention, weak chunks invite confident invention.
 *
 * WHY IT'S A DISCRIMINATED UNION AND NOT AN EMPTY ARRAY. If this returned
 * `ScoredChunk[]`, a caller could ignore emptiness and carry on. Returning a
 * union means TypeScript forces the caller to look at `kind` and handle
 * "insufficient" explicitly. The compiler makes abstention impossible to skip
 * by accident.
 */

import { assertNever } from "../shared/result.js";
import { effectiveScore, type ScoredChunk } from "./chunk.js";

export interface RetrievalPolicy {
  /**
   * Minimum effective score for a chunk to be considered usable.
   *
   * TUNE THIS ON YOUR EVAL SET, do not accept the default on faith. Too high and
   * the bot abstains on questions it could answer (annoying, but visible and
   * fixable). Too low and it invents answers (silent, and much worse). When
   * uncertain, err high — see docs/04-retrieval.md §4.4.
   */
  readonly relevanceFloor: number;

  /**
   * How many chunks reach the model.
   *
   * More is not better. Going from 4 to 10 roughly triples retrieved input
   * tokens for a small single-digit accuracy change on most eval sets, and adds
   * noise the model can latch onto. Retrieve wide, rerank, then cut hard.
   */
  readonly maxChunks: number;

  /**
   * A margin the TOP result must clear beyond the floor.
   *
   * Guards a specific failure: several mediocre chunks that all scrape past the
   * floor, none of which actually answers the question. If nothing is clearly
   * good, that is a better signal of "we don't know" than the count of
   * barely-passing results.
   */
  readonly topResultMargin: number;
}

export const DEFAULT_RETRIEVAL_POLICY: RetrievalPolicy = {
  relevanceFloor: 0.35,
  maxChunks: 4,
  topResultMargin: 0.1,
};

/**
 * The outcome of applying policy to raw search results.
 *
 * Two shapes, and the caller must distinguish them. `insufficient` carries the
 * best score we saw so the decision is observable — a rising abstention rate with
 * scores just under the floor means the floor needs tuning, while abstention with
 * scores near zero means retrieval or ingestion is broken. Those are different
 * problems and the metric should tell them apart (docs/10-operations.md §10.3).
 */
export type RetrievalOutcome =
  | { readonly kind: "grounded"; readonly chunks: readonly ScoredChunk[] }
  | { readonly kind: "insufficient"; readonly bestScore: number | null };

export function applyRetrievalPolicy(
  results: readonly ScoredChunk[],
  policy: RetrievalPolicy = DEFAULT_RETRIEVAL_POLICY,
): RetrievalOutcome {
  if (results.length === 0) {
    return { kind: "insufficient", bestScore: null };
  }

  const ranked = [...results].sort((a, b) => effectiveScore(b) - effectiveScore(a));
  const best = effectiveScore(ranked[0]!);

  // The top result must be convincingly good, not merely passing.
  if (best < policy.relevanceFloor + policy.topResultMargin) {
    return { kind: "insufficient", bestScore: best };
  }

  const usable = ranked
    .filter((c) => effectiveScore(c) >= policy.relevanceFloor)
    .slice(0, policy.maxChunks);

  // Defensive: unreachable given the check above, but the union makes the
  // impossible case cheap to represent rather than something to reason about.
  if (usable.length === 0) {
    return { kind: "insufficient", bestScore: best };
  }

  return { kind: "grounded", chunks: usable };
}

/**
 * Turn the outcome into the wording the model should use.
 *
 * WHY GENERATE THIS RATHER THAN LET THE MODEL DECIDE: "say you don't know when
 * you don't know" is a prompt instruction, and prompt instructions are advisory.
 * By computing the abstention text ourselves and passing it in, the honest answer
 * is the path of least resistance rather than something we hope for.
 */
export function describeOutcome(outcome: RetrievalOutcome): string {
  switch (outcome.kind) {
    case "grounded":
      return `${outcome.chunks.length} relevant source(s) found.`;
    case "insufficient":
      return (
        "No sufficiently relevant source was found in the Nailzify documentation. " +
        "Tell the customer you don't have that information and offer to connect " +
        "them with the team. Do not answer from general knowledge."
      );
    default:
      return assertNever(outcome, "RetrievalOutcome");
  }
}

/** Convenience for metrics — see the AbstentionRate alarm in docs/10-operations.md. */
export const didAbstain = (outcome: RetrievalOutcome): boolean =>
  outcome.kind === "insufficient";
