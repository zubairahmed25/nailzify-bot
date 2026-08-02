import { describe, expect, it } from "vitest";
import type { LlmClient, LlmRequest, LlmResponse } from "../ports/index.js";
import { classifyDocument, DocumentClassificationFailed } from "./classify-document.js";

// ---------------------------------------------------------------------------
// A fake LlmClient whose complete() returns a scripted tool call. The real
// call is verified separately (llm-client.test.ts, forceTool) — this file is
// about what classifyDocument DOES with whatever the model hands back,
// including the cases where the model does not behave.
// ---------------------------------------------------------------------------

function fakeLlm(response: Partial<LlmResponse> = {}) {
  const seen: LlmRequest[] = [];

  const llm: LlmClient = {
    complete: async (request) => {
      seen.push(request);
      return {
        text: "",
        toolCalls: [],
        stopReason: "tool_use",
        usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0 },
        ...response,
      };
    },
    stream: async function* () {
      throw new Error("classifyDocument should use complete(), never stream()");
    },
  };

  return { llm, seen };
}

const classifyCall = (input: Record<string, unknown>) => ({
  id: "t1",
  name: "classify_document",
  input,
});

const RETURN_POLICY_TEXT = [
  "Return Policy",
  "Money-Back Guarantee",
  "We want you to be absolutely in love with your Nailzify nails! Nailzify offers a",
  "14-day money-back guarantee.",
  "Damaged or Defective Items",
  "If you received a damaged or defective item please contact us within 14 days.",
  "Source: https://www.nailzify.com/pages/return-policy",
].join("\n");

// ---------------------------------------------------------------------------

describe("the model never regenerates the document", () => {
  it("forces the classification tool rather than leaving it optional", async () => {
    const { llm, seen } = fakeLlm({
      toolCalls: [classifyCall({ docType: "policy", sectionHeadings: [] })],
    });

    await classifyDocument(RETURN_POLICY_TEXT, { llm });

    expect(seen[0]?.forceTool).toBe("classify_document");
  });

  it("uses complete(), not stream() — this is a one-shot call with no reason to stream", async () => {
    const { llm } = fakeLlm({
      toolCalls: [classifyCall({ docType: "guide", sectionHeadings: [] })],
    });

    // fakeLlm's stream() throws — reaching this line without throwing IS the assertion.
    await expect(classifyDocument(RETURN_POLICY_TEXT, { llm })).resolves.toBeDefined();
  });

  it("sends the raw text to the model but returns the SAME text back, character for character", async () => {
    // THE CORE GUARANTEE. The model is never asked to reproduce the document —
    // only to name headings, which this code then finds by exact match. Proven
    // here by returning headings the model could not possibly have invented
    // correctly if it were regenerating rather than pointing.
    const { llm } = fakeLlm({
      toolCalls: [
        classifyCall({
          docType: "policy",
          sectionHeadings: ["Money-Back Guarantee", "Damaged or Defective Items"],
        }),
      ],
    });

    const result = await classifyDocument(RETURN_POLICY_TEXT, { llm });

    // Every original word survives, in order, untouched.
    expect(result.markdown.replace(/^## /gm, "")).toBe(RETURN_POLICY_TEXT);
  });
});

describe("inserting headings by exact match only", () => {
  it("marks a matched heading with ##", async () => {
    const { llm } = fakeLlm({
      toolCalls: [
        classifyCall({
          docType: "policy",
          sectionHeadings: ["Money-Back Guarantee"],
        }),
      ],
    });

    const result = await classifyDocument(RETURN_POLICY_TEXT, { llm });

    expect(result.markdown).toContain("## Money-Back Guarantee");
    expect(result.unmatchedHeadings).toEqual([]);
  });

  it("skips a heading that does not appear verbatim, and reports it rather than guessing", async () => {
    // A paraphrase or hallucination — the model claims a heading exists that is
    // not actually in the source text.
    const { llm } = fakeLlm({
      toolCalls: [
        classifyCall({
          docType: "policy",
          sectionHeadings: ["Money Back Guarantee!"], // note: not the real text
        }),
      ],
    });

    const result = await classifyDocument(RETURN_POLICY_TEXT, { llm });

    expect(result.markdown).not.toContain("##");
    expect(result.unmatchedHeadings).toEqual(["Money Back Guarantee!"]);
  });

  it("does not mark the attribution/source line as a heading, when the model correctly excludes it", async () => {
    // The exact false positive found while testing a hand-rolled heuristic —
    // this is why classification went to the model rather than a regex.
    const { llm } = fakeLlm({
      toolCalls: [
        classifyCall({
          docType: "policy",
          // The model was told to exclude source/attribution lines and did.
          sectionHeadings: ["Money-Back Guarantee", "Damaged or Defective Items"],
        }),
      ],
    });

    const result = await classifyDocument(RETURN_POLICY_TEXT, { llm });

    expect(result.markdown).not.toContain("## Source:");
  });

  it("returns the text completely unchanged when no headings are detected", async () => {
    const { llm } = fakeLlm({
      toolCalls: [classifyCall({ docType: "guide", sectionHeadings: [] })],
    });

    const result = await classifyDocument(RETURN_POLICY_TEXT, { llm });

    expect(result.markdown).toBe(RETURN_POLICY_TEXT);
  });

  it("marks every occurrence of a repeated heading", async () => {
    const repeated = "Note\nSome text.\nNote\nMore text.";
    const { llm } = fakeLlm({
      toolCalls: [classifyCall({ docType: "guide", sectionHeadings: ["Note"] })],
    });

    const result = await classifyDocument(repeated, { llm });

    expect(result.markdown.match(/## Note/g)).toHaveLength(2);
  });

  it("tolerates a non-array sectionHeadings instead of throwing", async () => {
    const { llm } = fakeLlm({
      toolCalls: [classifyCall({ docType: "guide", sectionHeadings: "not an array" })],
    });

    const result = await classifyDocument(RETURN_POLICY_TEXT, { llm });

    expect(result.markdown).toBe(RETURN_POLICY_TEXT);
    expect(result.unmatchedHeadings).toEqual([]);
  });
});

describe("docType validation", () => {
  it("accepts a known category", async () => {
    const { llm } = fakeLlm({
      toolCalls: [classifyCall({ docType: "faq", sectionHeadings: [] })],
    });

    const result = await classifyDocument(RETURN_POLICY_TEXT, { llm });

    expect(result.docType).toBe("faq");
    expect(result.docTypeWasInvalid).toBe(false);
  });

  it("falls back to guide on an unrecognised category rather than failing the whole upload", async () => {
    // Wrong category costs retrieval precision, not a false claim in a
    // customer's hands — unlike a fabricated price or shape, this does not
    // need to be a hard failure.
    const { llm } = fakeLlm({
      toolCalls: [classifyCall({ docType: "policies", sectionHeadings: [] })], // plural, invalid
    });

    const result = await classifyDocument(RETURN_POLICY_TEXT, { llm });

    expect(result.docType).toBe("guide");
    expect(result.docTypeWasInvalid).toBe(true);
  });
});

describe("when the model does not call the tool at all", () => {
  it("throws DocumentClassificationFailed rather than crashing on an undefined access", async () => {
    // forceTool asks the API to guarantee a call. Checked anyway rather than
    // trusted — an API guarantee is not a substitute for handling the case
    // where it did not hold.
    const { llm } = fakeLlm({ toolCalls: [] });

    await expect(classifyDocument(RETURN_POLICY_TEXT, { llm })).rejects.toBeInstanceOf(
      DocumentClassificationFailed,
    );
  });
});
