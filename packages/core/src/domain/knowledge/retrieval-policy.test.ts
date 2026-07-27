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
 * Scores observed running the real pipeline against cohere.embed-v4:0 @ 1024d
 * on the Nailzify policy corpus. These are measurements, not invented numbers —
 * which is why they belong in the test suite rather than a comment.
 */
const MEASURED = {
  // Correct top-1 retrievals, weakest to strongest.
  correct: {
    customsFees: 0.184, // "will I be charged extra fees at the border?"
    shipsToUk: 0.31, //   "do you post to Britain?"
    refundOpened: 0.311, // "can I get my money back if I opened the packet?"
    wearTime: 0.384, //   "how long do they stay on before falling off?"
    safeRemoval: 0.59, //  "what's the safest way to take them off?"
  },
  // Best score for a question the corpus genuinely does not answer.
  offTopicBest: 0.174, // "do you accept bitcoin?"
} as const;

describe("calibration against real embedding scores", () => {
  it("does not abstain on the weakest CORRECT retrieval", () => {
    // THE REGRESSION THIS FILE EXISTS FOR. An earlier hand-picked floor of 0.35
    // rejected this, and three other correct answers with it. A threshold set by
    // intuition was wrong in the direction that looks like a broken bot.
    const outcome = applyRetrievalPolicy([scored("customs", MEASURED.correct.customsFees)]);

    expect(outcome.kind).toBe("grounded");
  });

  it("grounds every measured correct retrieval", () => {
    for (const [name, score] of Object.entries(MEASURED.correct)) {
      const outcome = applyRetrievalPolicy([scored(name, score)]);
      expect(outcome.kind, `${name} @ ${score} should ground`).toBe("grounded");
    }
  });

  it("cannot separate off-topic from correct on raw cosine alone", () => {
    // THE HONEST FINDING, asserted rather than papered over.
    //
    // Off-topic tops out at 0.174; the weakest correct answer is 0.184. Any
    // threshold that rejects the first also very nearly rejects the second.
    // Rather than fit a number to a 0.01 window — which would pass this test and
    // fail in production — we assert what is actually true: raw cosine grounds
    // both, and the abstention decision has to come from somewhere else.
    const offTopic = applyRetrievalPolicy([scored("bitcoin", MEASURED.offTopicBest)]);
    const weakestCorrect = applyRetrievalPolicy([
      scored("customs", MEASURED.correct.customsFees),
    ]);

    expect(offTopic.kind).toBe("grounded");
    expect(weakestCorrect.kind).toBe("grounded");

    const margin = MEASURED.correct.customsFees - MEASURED.offTopicBest;
    expect(margin).toBeLessThan(0.02);
  });

  it("separates them once a reranker has scored the pair", () => {
    // The architectural payoff. A cross-encoder reads query and document
    // together and produces well-separated, roughly calibrated scores — so the
    // abstention decision becomes possible. This is why reranking is required
    // on the knowledge plane, not optional.
    const offTopic = applyRetrievalPolicy([scored("bitcoin", MEASURED.offTopicBest, 0.04)]);
    const correct = applyRetrievalPolicy([
      scored("customs", MEASURED.correct.customsFees, 0.81),
    ]);

    expect(didAbstain(offTopic)).toBe(true);
    expect(correct.kind).toBe("grounded");
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
  it("applies the stricter rerank floor once a reranker has run", () => {
    // 0.25 clears the raw-cosine floor (0.15) but not the rerank floor (0.35).
    // Cross-encoder scores are closer to calibrated relevance, so a higher bar
    // is both possible and appropriate.
    const withRerank = applyRetrievalPolicy([scored("a", 0.9, 0.25)]);
    const withoutRerank = applyRetrievalPolicy([scored("a", 0.25)]);

    expect(withRerank.kind).toBe("insufficient");
    expect(withoutRerank.kind).toBe("grounded");
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
