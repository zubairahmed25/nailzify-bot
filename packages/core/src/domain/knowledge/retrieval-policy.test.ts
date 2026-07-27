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

describe("applyRetrievalPolicy", () => {
  it("returns grounded chunks when retrieval is confident", () => {
    const outcome = applyRetrievalPolicy([scored("a", 0.82), scored("b", 0.61)]);

    expect(outcome.kind).toBe("grounded");
    if (outcome.kind === "grounded") {
      expect(outcome.chunks).toHaveLength(2);
    }
  });

  it("abstains when nothing clears the floor", () => {
    // THE CENTRAL TEST. Vector search always returns something — here, three
    // weakly-related chunks for a question the corpus doesn't answer. Passing
    // these to the model is how confident, fluent, wrong answers get produced.
    const outcome = applyRetrievalPolicy([scored("a", 0.21), scored("b", 0.19)]);

    expect(outcome.kind).toBe("insufficient");
    expect(didAbstain(outcome)).toBe(true);
  });

  it("abstains on an empty result set", () => {
    const outcome = applyRetrievalPolicy([]);
    expect(outcome).toEqual({ kind: "insufficient", bestScore: null });
  });

  it("abstains when several results merely scrape past the floor", () => {
    // Each of these clears relevanceFloor (0.35) but none clears the required
    // margin (0.45). "Several mediocre matches" is not knowledge.
    const outcome = applyRetrievalPolicy([scored("a", 0.4), scored("b", 0.38), scored("c", 0.36)]);

    expect(outcome.kind).toBe("insufficient");
    if (outcome.kind === "insufficient") {
      // The best score is reported so the abstention is diagnosable: near-floor
      // means tune the floor, near-zero means retrieval is broken.
      expect(outcome.bestScore).toBeCloseTo(0.4);
    }
  });

  it("filters weak chunks out of an otherwise good result set", () => {
    const outcome = applyRetrievalPolicy([scored("strong", 0.9), scored("weak", 0.1)]);

    expect(outcome.kind).toBe("grounded");
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

  it("prefers the rerank score over raw similarity when both exist", () => {
    // Raw similarity ranks "a" first; the cross-encoder disagrees. The reranker
    // saw the query and document together, so it wins.
    const outcome = applyRetrievalPolicy([scored("a", 0.9, 0.2), scored("b", 0.5, 0.95)]);

    if (outcome.kind === "grounded") {
      expect(outcome.chunks[0]!.chunk.id).toBe(ChunkId("b"));
    }
  });

  it("does not mutate the caller's array", () => {
    const input = [scored("a", 0.2), scored("b", 0.95)];
    const before = input.map((c) => c.chunk.id);

    applyRetrievalPolicy(input);

    expect(input.map((c) => c.chunk.id)).toEqual(before);
  });

  it("tells the model to abstain rather than improvise", () => {
    const message = describeOutcome(applyRetrievalPolicy([]));
    expect(message).toContain("Do not answer from general knowledge");
  });
});

describe("chunk helpers", () => {
  it("prepends the context header for embedding but leaves text intact", () => {
    const c = chunk("a");
    expect(embeddingText(c)).toBe(`${c.contextHeader}\n\n${c.text}`);
    // The header is a retrieval aid. What we'd show a customer is unchanged.
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
