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
   * Floor applied to RAW COSINE similarity, when no reranker has run.
   *
   * ⚠️ MEASURED, NOT GUESSED — and the measurement was a surprise. Against
   * `cohere.embed-v4:0` at 1024 dimensions on a real Nailzify policy corpus:
   *
   *     correct matches      0.184 – 0.590
   *     off-topic questions  0.147 – 0.174
   *
   * Two conclusions, and the second is the important one.
   *
   * 1. An earlier hand-picked default of 0.35 would have abstained on four of
   *    five CORRECT answers. A threshold set by intuition was badly wrong, in
   *    the direction that looks like a broken bot.
   *
   * 2. The weakest correct answer (0.184) and the strongest off-topic one
   *    (0.174) are 0.01 apart. THERE IS NO THRESHOLD THAT RELIABLY SEPARATES
   *    THEM. Picking 0.18 would "pass the test" while overfitting to six queries
   *    on a six-chunk corpus, and it would not survive contact with a real one.
   *
   * So this floor is deliberately set low. It is a coarse garbage filter —
   * catching empty text, dimension bugs, and genuine noise — NOT the precision
   * gate. Raw cosine from a bi-encoder is simply too compressed to carry an
   * abstention decision.
   *
   * ⚠️ THE ARCHITECTURAL CONSEQUENCE: reranking is not a nice-to-have for the
   * knowledge plane. It is what makes correct abstention possible at all. A
   * deployment without a reranker will either answer from weak sources or
   * abstain on good ones, and no amount of tuning this number fixes that.
   */
  readonly cosineFloor: number;

  /**
   * Floor applied to CROSS-ENCODER rerank scores, when a reranker has run.
   *
   * Separate from `cosineFloor` because the two are different distributions and
   * one threshold cannot serve both. Applying a cross-encoder threshold to raw
   * cosine (or the reverse) compares numbers from different scales.
   *
   * ⚠️ MEASURED against `cohere.rerank-v3-5:0`, and the numbers are much lower
   * than intuition suggests:
   *
   *     correct answers      0.053 – 0.738
   *     off-topic control    0.032 – 0.039
   *
   * A hand-picked 0.35 would have abstained on THREE of five correct answers.
   * That is the second time on this project that an intuited threshold was
   * badly wrong — cross-encoder scores are not percentages and do not read like
   * confidence.
   *
   * The distribution is bimodal in a useful way: four of five correct answers
   * land at 0.207+ (5-19x above the off-topic ceiling), while one hard query
   * lands at 0.053. This floor is set just under that hard case, which means it
   * is FITTED TO ONE DATA POINT and should be treated as provisional.
   *
   * ⚠️ This is a method, not a final answer. Six chunks and five questions is a
   * demonstration corpus. Re-derive these on your real corpus with 30-50
   * questions from the support inbox before trusting them in production —
   * `npx vite-node scripts/verify-retrieval.ts` prints the calibration table.
   */
  readonly rerankFloor: number;

  /**
   * How many chunks reach the model.
   *
   * More is not better. Going from 4 to 10 roughly triples retrieved input
   * tokens for a small single-digit accuracy change on most eval sets, and adds
   * noise the model can latch onto. Retrieve wide, rerank, then cut hard.
   */
  readonly maxChunks: number;

  /**
   * A margin the TOP result must clear beyond the applicable floor.
   *
   * Guards a specific failure: several mediocre chunks that all scrape past the
   * floor, none of which actually answers the question. If nothing is clearly
   * good, that is a better signal of "we don't know" than the count of
   * barely-passing results.
   */
  readonly topResultMargin: number;
}

/**
 * Defaults measured against `cohere.embed-v4:0` @ 1024d + `cohere.rerank-v3-5:0`
 * on the Nailzify verification corpus. See the per-field notes for the observed
 * distributions and their limits.
 *
 * `topResultMargin` is small because the measured gaps are small — a larger
 * margin would reject correct answers. That thinness is itself the finding: a
 * threshold is one layer of the abstention decision, and the model's grounding
 * instruction (docs/04-retrieval.md §4.7) is the other. Neither is sufficient
 * alone.
 *
 * ⚠️ Re-measure whenever you change the embedding OR rerank model. Scores from
 * different models are not comparable, so a floor carried across is a number
 * with no meaning.
 */
/**
 * Measured against the REAL corpus (return-policy + size-guide, 7 chunks) with
 * scripts/verify-retrieval.ts. Re-run it after any change to the embedding
 * model, the rerank model, the chunking policy, or the documents themselves —
 * scores from different models are not comparable.
 *
 *                    worst correct   best off-topic   separation
 *   cosine                   0.268            0.174        1.54x
 *   rerank                   0.094            0.048        1.96x
 *
 * The earlier value of 0.045 came from a calibration run over three INVENTED
 * documents — a shipping policy and a nail care guide the store does not have.
 * 0.071 is the midpoint of the real gap.
 *
 * ============================================================================
 * ⚠️ WHAT THIS FLOOR CANNOT DO, AND WHY THAT IS NOT FIXABLE HERE
 * ============================================================================
 *
 * A floor separates ON-TOPIC from OFF-TOPIC. It cannot separate "this document
 * answers the question" from "this document is about a related subject".
 *
 * Measured, same run. The store has no shipping policy, so these are unanswerable:
 *
 *   "how long does delivery take?"   ->  return-policy    rerank 0.229
 *   "do you ship to the UK?"         ->  return-policy    rerank 0.086
 *
 * 0.229 is HIGHER than two of the six genuinely-correct answers, including
 * "can I get my money back if I opened the packet?" at 0.198. The reranker is
 * not malfunctioning: the return policy really does discuss time windows and
 * international postage, so it is a strong topical match. It simply does not
 * answer the question.
 *
 * There is therefore NO threshold that admits the correct answers and rejects
 * these. Raise the floor above 0.229 and the bot abstains on most of the
 * questions it can actually answer.
 *
 * The two real defences, in order:
 *   1. WRITE THE DOCUMENT. A shipping policy makes the question answerable, and
 *      is the only fix that turns "I don't know" into a sale.
 *   2. The system prompt. The model sees the retrieved chunk and must say it
 *      does not know when the chunk is merely adjacent. That is a judgement the
 *      floor cannot make, because the floor never sees the question and the text
 *      together — only a number.
 *
 * Retrieval scoring is a filter, not a comprehension check. Treating a high
 * rerank score as "this answers the question" is the mistake this note exists
 * to prevent.
 */
export const DEFAULT_RETRIEVAL_POLICY: RetrievalPolicy = {
  // Garbage filter only. Best off-topic cosine measured 0.174 against a worst
  // correct of 0.268, so cosine alone cannot gate precision — that is the
  // reranker's job. Kept low deliberately: raising it discards candidates before
  // the cross-encoder ever sees them.
  cosineFloor: 0.1,
  rerankFloor: 0.071,
  maxChunks: 4,
  topResultMargin: 0.005,
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

  // Pick the floor that matches the score distribution we are actually looking
  // at. Applying a cross-encoder threshold to raw cosine (or vice versa) is
  // comparing numbers from different scales — the mistake that made the original
  // hand-picked default abstain on correct answers.
  const floor = wasReranked(ranked) ? policy.rerankFloor : policy.cosineFloor;

  // The top result must be convincingly good, not merely passing.
  if (best < floor + policy.topResultMargin) {
    return { kind: "insufficient", bestScore: best };
  }

  const usable = ranked
    .filter((c) => effectiveScore(c) >= floor)
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

/**
 * Did a reranker run over these results?
 *
 * Checks the top result rather than requiring all of them, because a reranker
 * scores whatever slice it was given. If the best candidate carries a rerank
 * score, we are in the reranked distribution.
 */
function wasReranked(ranked: readonly ScoredChunk[]): boolean {
  return ranked[0]?.rerankScore !== null && ranked[0]?.rerankScore !== undefined;
}
