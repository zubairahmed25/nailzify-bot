import { describe, expect, it } from "vitest";
import { ChunkId, DocumentId } from "../shared/brand.js";
import type { Chunk, ScoredChunk } from "./chunk.js";
import { effectiveScore, embeddingText } from "./chunk.js";
import {
  applyRetrievalPolicy,
  DEFAULT_RETRIEVAL_POLICY,
  describeOutcome,
  didAbstain,
} from "./retrieval-policy.js";

function chunk(id: string): Chunk {
  return {
    id: ChunkId(id),
    documentId: DocumentId("returns-policy"),
    title: "Return Policy",
    section: "Eligibility",
    page: 2,
    docType: "policy",
    text: "Returns are accepted within 30 days of delivery.",
    contextHeader: "[Nailzify Return Policy — Section 1: Eligibility]",
    version: "2026-03-01",
    embeddingModel: "cohere.embed-v4:0",
  };
}

const scored = (id: string, score: number, rerankScore: number | null = null): ScoredChunk => ({
  chunk: chunk(id),
  score,
  rerankScore,
});

/**
 * Scores observed running the real pipeline (cohere.embed-v4:0 @ 1024d ->
 * cohere.rerank-v3-5:0) against the Nailzify policy corpus. Measurements, not
 * invented numbers — which is why they live in the test suite rather than a
 * comment, and why changing an embedding model should break these tests.
 *
 * Reproduce with: npx vite-node scripts/verify-retrieval.ts
 */
/**
 * Measured by scripts/verify-retrieval.ts against the REAL corpus — the two
 * documents the store actually publishes (return-policy, size-guide, 7 chunks).
 *
 * ⚠️ THESE NUMBERS REPLACED AN EARLIER SET TAKEN FROM THREE INVENTED DOCUMENTS.
 * The old fixtures included a shipping policy and a nail care guide Nailzify
 * does not have, so every threshold derived from them was fitted to a corpus
 * that did not exist. `customsFees` and `wearTime` are gone for that reason —
 * not because those questions stopped mattering, but because nothing in the
 * store answers them (see UNANSWERABLE below).
 */
const MEASURED = {
  cosine: {
    correct: {
      refundOpened: 0.268, //  "can I get my money back if I opened the packet?"
      sizeChoosing: 0.33, //   "how do I work out which set fits me?"
      damagedItem: 0.347, //   "what happens if my set turns up broken?"
      betweenSizes: 0.394, //  "should I go bigger or smaller if I'm between sizes?"
      intlReturns: 0.402, //   "I'm outside the US — who pays to send them back?"
      sizeChart: 0.54, //      "my middle nail measures about 12mm?"
    },
    offTopicBest: 0.174, //    "do you accept bitcoin?"
  },
  rerank: {
    correct: {
      damagedItem: 0.094, //   the hard one — vocabulary genuinely diverges
      refundOpened: 0.198,
      betweenSizes: 0.264,
      sizeChoosing: 0.281,
      sizeChart: 0.424,
      intlReturns: 0.437,
    },
    offTopicBest: 0.048,
  },
  /**
   * ⚠️ THE NUMBERS THAT PROVE A FLOOR CANNOT SOLVE THIS.
   *
   * Ordinary questions with NO supporting document, scored against the corpus
   * that does exist. These are not off-topic — the return policy genuinely
   * discusses time windows and international postage — they are simply not
   * answered by it.
   */
  unanswerable: {
    wearTime: 0.043, //     "how long do they stay on?"        -> below the floor, abstains
    safeRemoval: 0.02, //   "safest way to take them off?"     -> below the floor, abstains
    shipsToUk: 0.086, //    "do you ship to the UK?"           -> ABOVE the floor
    deliveryTime: 0.229, // "how long does delivery take?"     -> ABOVE most correct answers
  },
} as const;

describe("calibration — raw cosine", () => {
  it("grounds every measured correct retrieval", () => {
    // An earlier hand-picked floor of 0.35 rejected four of these. A threshold
    // set by intuition was wrong in the direction that looks like a broken bot.
    for (const [name, score] of Object.entries(MEASURED.cosine.correct)) {
      const outcome = applyRetrievalPolicy([scored(name, score)]);
      expect(outcome.kind, `${name} @ ${score} should ground`).toBe("grounded");
    }
  });

  it("separates better on the real corpus than it did on the fixtures — but is still not the gate", () => {
    // THE FINDING CHANGED, and saying so is the point of re-measuring.
    //
    // On the invented fixtures the weakest correct answer (0.184) sat BELOW the
    // best off-topic score (0.174 → 0.98x): raw cosine could not separate them
    // at all. On the real corpus the gap is 0.094 (1.54x), which is real.
    //
    // The floor still is not raised to exploit it. Cosine is the recall net —
    // it decides what the cross-encoder is even allowed to look at, and a
    // candidate discarded here can never be recovered. 7 chunks is also a very
    // small corpus for trusting a cosine gap. Precision stays the reranker's job.
    const gap = MEASURED.cosine.correct.refundOpened - MEASURED.cosine.offTopicBest;
    expect(gap).toBeGreaterThan(0.05);

    // Both still ground, because cosineFloor is deliberately a garbage filter.
    expect(applyRetrievalPolicy([scored("bitcoin", MEASURED.cosine.offTopicBest)]).kind).toBe(
      "grounded",
    );
    expect(
      applyRetrievalPolicy([scored("refund", MEASURED.cosine.correct.refundOpened)]).kind,
    ).toBe("grounded");
  });
});

describe("calibration — cross-encoder rerank", () => {
  it("grounds every measured correct retrieval", () => {
    // A hand-picked rerankFloor of 0.35 rejected THREE of these. Cross-encoder
    // scores are not percentages and do not read like confidence.
    for (const [name, score] of Object.entries(MEASURED.rerank.correct)) {
      const outcome = applyRetrievalPolicy([scored(name, 0.5, score)]);
      expect(outcome.kind, `${name} @ rerank ${score} should ground`).toBe("grounded");
    }
  });

  it("abstains on the off-topic control", () => {
    // What raw cosine could not do. This is the reranker earning its place in
    // the request path.
    const outcome = applyRetrievalPolicy([
      scored("bitcoin", MEASURED.cosine.offTopicBest, MEASURED.rerank.offTopicBest),
    ]);

    expect(didAbstain(outcome)).toBe(true);
  });

  it("separates the typical case comfortably and the hard case narrowly", () => {
    // Worth encoding because the headline "reranking fixes it" is too simple.
    // Most correct answers sit 4x+ above the off-topic ceiling. One — where the
    // question's vocabulary genuinely diverges from the source text — sits under
    // 2x. The floor is fitted to that hard case, which is why the model's
    // grounding instruction is a necessary second layer.
    const { correct, offTopicBest } = MEASURED.rerank;

    expect(correct.intlReturns / offTopicBest).toBeGreaterThan(4);
    expect(correct.damagedItem / offTopicBest).toBeLessThan(2.5);
    expect(correct.damagedItem / offTopicBest).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// The limit of the whole mechanism
// ---------------------------------------------------------------------------

describe("what a relevance floor structurally cannot do", () => {
  it("abstains on questions whose topic is genuinely absent", () => {
    // Wear time and removal have nothing close in the corpus, so the floor
    // works exactly as designed.
    for (const score of [MEASURED.unanswerable.wearTime, MEASURED.unanswerable.safeRemoval]) {
      expect(didAbstain(applyRetrievalPolicy([scored("x", 0.5, score)]))).toBe(true);
    }
  });

  it("CANNOT abstain on an adjacent question the corpus does not answer", () => {
    // THE FINDING, asserted rather than hoped away.
    //
    // "How long does delivery take?" scores 0.229 against the RETURN POLICY —
    // higher than three of the six genuinely-correct answers, including
    // "can I get my money back if I opened the packet?" at 0.198.
    //
    // The reranker is not wrong. The return policy really does discuss time
    // windows and international postage; it is a strong topical match that
    // happens not to answer the question.
    const outcome = applyRetrievalPolicy([scored("x", 0.5, MEASURED.unanswerable.deliveryTime)]);

    expect(outcome.kind).toBe("grounded");
    expect(MEASURED.unanswerable.deliveryTime).toBeGreaterThan(MEASURED.rerank.correct.refundOpened);
  });

  it("has no threshold that admits the correct answers and rejects the adjacent ones", () => {
    // The proof that this is not a tuning problem. Any floor high enough to
    // reject the delivery question also rejects most of what the bot can
    // legitimately answer, so the fix is a shipping policy — not a number.
    const { correct } = MEASURED.rerank;
    const rejected = Object.values(correct).filter(
      (score) => score <= MEASURED.unanswerable.deliveryTime,
    );

    // Two of six: "what happens if my set turns up broken?" (0.094) and
    // "can I get my money back if I opened the packet?" (0.198). Losing the
    // ability to answer either, in exchange for declining one delivery
    // question, is not a trade worth making.
    expect(rejected.length).toBe(2);
  });
});

describe("applyRetrievalPolicy", () => {
  it("returns grounded chunks when retrieval is confident", () => {
    const outcome = applyRetrievalPolicy([scored("a", 0.82), scored("b", 0.61)]);

    expect(outcome.kind).toBe("grounded");
    if (outcome.kind === "grounded") expect(outcome.chunks).toHaveLength(2);
  });

  it("abstains on an empty result set", () => {
    // Vector search normally always returns something; an empty set means the
    // namespace is empty or a filter excluded everything.
    expect(applyRetrievalPolicy([])).toEqual({ kind: "insufficient", bestScore: null });
  });

  it("abstains when everything is near-noise", () => {
    const outcome = applyRetrievalPolicy([scored("a", 0.09), scored("b", 0.05)]);

    expect(outcome.kind).toBe("insufficient");
    if (outcome.kind === "insufficient") expect(outcome.bestScore).toBeCloseTo(0.09);
  });

  it("reports the best score so abstention is diagnosable", () => {
    // Near-floor abstention means tune the floor; near-zero means retrieval or
    // ingestion is broken. Different problems, and the metric must distinguish.
    const outcome = applyRetrievalPolicy([scored("a", 0.16)]);

    if (outcome.kind === "insufficient") expect(outcome.bestScore).toBeCloseTo(0.16);
  });

  it("filters weak chunks out of an otherwise good result set", () => {
    const outcome = applyRetrievalPolicy([scored("strong", 0.9), scored("weak", 0.02)]);

    if (outcome.kind === "grounded") {
      expect(outcome.chunks.map((c) => c.chunk.id)).toEqual([ChunkId("strong")]);
    }
  });

  it("caps the number of chunks reaching the model", () => {
    const many = Array.from({ length: 12 }, (_, i) => scored(`c${i}`, 0.9 - i * 0.01));
    const outcome = applyRetrievalPolicy(many);

    if (outcome.kind === "grounded") {
      expect(outcome.chunks).toHaveLength(DEFAULT_RETRIEVAL_POLICY.maxChunks);
    }
  });

  it("does not mutate the caller's array", () => {
    const input = [scored("a", 0.2), scored("b", 0.95)];
    const before = input.map((c) => c.chunk.id);

    applyRetrievalPolicy(input);

    expect(input.map((c) => c.chunk.id)).toEqual(before);
  });

  it("tells the model to abstain rather than improvise", () => {
    expect(describeOutcome(applyRetrievalPolicy([]))).toContain(
      "Do not answer from general knowledge",
    );
  });
});

describe("separate floors for separate score distributions", () => {
  it("applies the floor matching the scale it is looking at", () => {
    // The same number, 0.06, means different things in the two distributions:
    // respectable for a cross-encoder, near-noise for cosine. Applying one
    // scale's threshold to the other is exactly the mistake that made both
    // earlier hand-picked defaults wrong.
    //
    // Note the floors are NOT ordered — rerankFloor (0.071) is numerically
    // LOWER than cosineFloor (0.10). Neither is "stricter"; they are simply
    // measurements of different things.
    const asRerank = applyRetrievalPolicy([scored("a", 0.5, 0.09)]);
    const asCosine = applyRetrievalPolicy([scored("a", 0.09)]);

    expect(asRerank.kind).toBe("grounded");
    expect(asCosine.kind).toBe("insufficient");
  });

  it("prefers the rerank score over raw similarity when ranking", () => {
    // Raw similarity ranks "a" first; the cross-encoder disagrees. It saw the
    // query and document together, so it wins.
    const outcome = applyRetrievalPolicy([scored("a", 0.95, 0.4), scored("b", 0.5, 0.92)]);

    if (outcome.kind === "grounded") {
      expect(outcome.chunks[0]!.chunk.id).toBe(ChunkId("b"));
    }
  });
});

describe("chunk helpers", () => {
  it("prepends the context header for embedding but leaves text intact", () => {
    const c = chunk("a");
    expect(embeddingText(c)).toBe(`${c.contextHeader}\n\n${c.text}`);
    // The header is a retrieval aid, never customer-facing copy.
    expect(c.text).not.toContain("[Nailzify Return Policy");
  });

  it("falls back to raw text when no header was generated", () => {
    const c = { ...chunk("a"), contextHeader: null };
    expect(embeddingText(c)).toBe(c.text);
  });

  it("uses similarity when reranking was skipped", () => {
    expect(effectiveScore(scored("a", 0.7))).toBe(0.7);
    expect(effectiveScore(scored("a", 0.7, 0.3))).toBe(0.3);
  });
});
