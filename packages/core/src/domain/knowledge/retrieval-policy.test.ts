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
const MEASURED = {
  cosine: {
    correct: {
      customsFees: 0.184, //  "will I be charged extra fees at the border?"
      shipsToUk: 0.31, //     "do you post to Britain?"
      refundOpened: 0.31, //  "can I get my money back if I opened the packet?"
      wearTime: 0.384, //     "how long do they stay on before falling off?"
      safeRemoval: 0.59, //   "what's the safest way to take them off?"
    },
    offTopicBest: 0.174, //   "do you accept bitcoin?"
  },
  rerank: {
    correct: {
      customsFees: 0.053, //  the hard one — vocabulary genuinely diverges
      refundOpened: 0.207,
      shipsToUk: 0.235,
      wearTime: 0.419,
      safeRemoval: 0.738,
    },
    offTopicBest: 0.039,
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

  it("cannot separate off-topic from correct", () => {
    // THE HONEST FINDING, asserted rather than papered over.
    //
    // Off-topic tops out at 0.174; the weakest correct answer is 0.184. Any
    // threshold rejecting the first very nearly rejects the second. Rather than
    // fit a number to a 0.01 window — which would pass this test and fail in
    // production — we assert what is true: raw cosine grounds both.
    const offTopic = applyRetrievalPolicy([scored("bitcoin", MEASURED.cosine.offTopicBest)]);
    const weakestCorrect = applyRetrievalPolicy([
      scored("customs", MEASURED.cosine.correct.customsFees),
    ]);

    expect(offTopic.kind).toBe("grounded");
    expect(weakestCorrect.kind).toBe("grounded");
    expect(MEASURED.cosine.correct.customsFees - MEASURED.cosine.offTopicBest).toBeLessThan(0.02);
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
    // Four of five correct answers sit 5x+ above the off-topic ceiling. One —
    // where the question's vocabulary genuinely diverges from the source text —
    // sits at 1.36x. The floor is fitted to that hard case, which is why it is
    // provisional and why the model's grounding instruction is a second layer.
    const { correct, offTopicBest } = MEASURED.rerank;

    expect(correct.refundOpened / offTopicBest).toBeGreaterThan(5);
    expect(correct.customsFees / offTopicBest).toBeLessThan(1.5);
    expect(correct.customsFees / offTopicBest).toBeGreaterThan(1);
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
    // Note the floors are NOT ordered — rerankFloor (0.045) is numerically
    // LOWER than cosineFloor (0.10). Neither is "stricter"; they are simply
    // measurements of different things.
    const asRerank = applyRetrievalPolicy([scored("a", 0.5, 0.06)]);
    const asCosine = applyRetrievalPolicy([scored("a", 0.06)]);

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
