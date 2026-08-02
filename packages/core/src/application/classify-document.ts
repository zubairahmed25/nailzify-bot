/**
 * Turning a PDF's raw extracted text into something the ingestion pipeline
 * already knows how to index.
 *
 * ============================================================================
 * WHY THE MODEL NEVER REPRODUCES THE DOCUMENT
 * ============================================================================
 *
 * The obvious design asks the model to return the whole document back,
 * reformatted with `##` headings inserted. That is wrong for two reasons.
 *
 * First, cost and latency scale with the document — a ten-page policy becomes
 * a ten-page model OUTPUT, when the only new information needed is a title, a
 * category, and where the section breaks are.
 *
 * Second, and more seriously: asking a model to reproduce a long text VERBATIM
 * is a known failure mode. Generation is not a copy operation — a model can
 * subtly reword a sentence while believing it reproduced it exactly, and nobody
 * would notice, because the "reformatted" text looks entirely plausible. That
 * is the single worst thing that could happen to this pipeline: the return
 * policy customers rely on, silently altered by an LLM, with no error and no
 * signal anywhere that it happened.
 *
 * So the model is asked for three small things — title, category, and a list of
 * heading STRINGS — and this code finds those strings in the ORIGINAL text
 * itself via exact match. The document body a customer's question is eventually
 * answered from is never regenerated; it is only ever copied by our own code
 * from the bytes the PDF actually contained.
 *
 * A heading the model claims but that does not appear verbatim in the source
 * (a paraphrase, a hallucination) is simply skipped — reported, not trusted.
 * That degrades gracefully to slightly coarser chunking, which is the same
 * acceptable fallback this pipeline already has for a PDF with no detectable
 * headings at all.
 */

import type { DocType } from "../domain/knowledge/chunk.js";
import type { LlmClient } from "../ports/index.js";
import { MessageId } from "../domain/shared/brand.js";
import { userMessage } from "../domain/conversation/message.js";

const TOOL_NAME = "classify_document";

const KNOWN_DOC_TYPES: readonly DocType[] = ["policy", "guide", "faq"];

const SYSTEM_PROMPT = `You are classifying a company document for a retail chatbot's knowledge base. Read the text and call ${TOOL_NAME} with:

- title: a short, clear title for the document, drawn from its content. Never use a filename — you were not given one. This applies even to a very short document — a single sentence still has a subject; summarize what it is about in a few words (e.g. a one-line note about who owns the store becomes something like "Store Ownership", not a placeholder). Never output something like "Unknown", "N/A", or "<UNKNOWN>" — always give your best genuine, specific title.
- docType: "policy" for return, shipping, warranty or legal terms; "faq" for a question-and-answer format document; "guide" for anything else (how-to, product care, sizing, general information).
- sectionHeadings: the lines in the text that are genuine section headings, copied EXACTLY character-for-character as they appear in the source — so they can be found again by an exact string match. Do not paraphrase, summarize, or fix typos in a heading. Do not include the document's own title, page numbers, addresses, or a source/attribution line (e.g. "Source: https://..."). Only include lines that clearly introduce a new section of content. If the document has no clear section breaks, return an empty list — do not invent structure that is not there.`;

const CLASSIFY_TOOL = {
  name: TOOL_NAME,
  description: "Record this document's title, category, and detected section headings.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      docType: { type: "string", enum: KNOWN_DOC_TYPES },
      sectionHeadings: { type: "array", items: { type: "string" } },
    },
    required: ["title", "docType", "sectionHeadings"],
  },
} as const;

export interface DocumentClassification {
  readonly title: string;
  readonly docType: DocType;
  /** The ORIGINAL text, unmodified except for `## ` inserted before matched heading lines. */
  readonly markdown: string;
  /**
   * Headings the model reported that could not be found verbatim in the
   * source. Not an error — surfaced so a human can notice a pattern (the model
   * is not following the exact-copy instruction) without any single upload
   * failing over it.
   */
  readonly unmatchedHeadings: readonly string[];
  /** The docType the model returned did not match a known category. */
  readonly docTypeWasInvalid: boolean;
}

export interface ClassifyDocumentDeps {
  readonly llm: LlmClient;
}

export class DocumentClassificationFailed extends Error {
  constructor(reason: string) {
    super(`Could not classify the uploaded document: ${reason}`);
    this.name = "DocumentClassificationFailed";
  }
}

export async function classifyDocument(
  rawText: string,
  deps: ClassifyDocumentDeps,
): Promise<DocumentClassification> {
  const response = await deps.llm.complete({
    model: "judge",
    system: SYSTEM_PROMPT,
    tools: [CLASSIFY_TOOL],
    forceTool: TOOL_NAME,
    maxTokens: 1024,
    messages: [userMessage(MessageId(newCallId()), rawText, Date.now())],
  });

  const call = response.toolCalls[0];
  if (!call) {
    // forceTool asks the API to guarantee this. Still checked rather than
    // trusted — an API guarantee is not a substitute for handling the case
    // where, for whatever reason, it did not hold.
    throw new DocumentClassificationFailed("the model did not call the classification tool");
  }

  const input = call.input;
  const title = typeof input["title"] === "string" ? input["title"].trim() : "";
  if (title.length === 0) {
    // Deliberately NOT defaulted to "Untitled Document" here. This function has
    // no good fallback title to offer; the caller does (the original filename),
    // and choosing between "fail" and "fabricate a placeholder" belongs to
    // whoever has enough context to fail helpfully.
    throw new DocumentClassificationFailed("the model returned no usable title");
  }

  const rawDocType = input["docType"];
  const docTypeWasInvalid = !KNOWN_DOC_TYPES.includes(rawDocType as DocType);
  // Falls back to "guide" on an invalid category rather than failing the whole
  // upload. This is an internal categorisation label, not a fact stated to a
  // customer — unlike a fabricated price or shape, a wrong category here costs
  // some retrieval precision, not a false claim in someone's hands.
  const docType: DocType = docTypeWasInvalid ? "guide" : (rawDocType as DocType);

  const headings = Array.isArray(input["sectionHeadings"])
    ? input["sectionHeadings"].filter((h): h is string => typeof h === "string" && h.trim().length > 0)
    : [];

  const { markdown, unmatchedHeadings } = insertHeadings(rawText, headings);

  return { title, docType, markdown, unmatchedHeadings, docTypeWasInvalid };
}

/**
 * Mark lines as markdown headings by EXACT match against the original text.
 *
 * Every line the model named is searched for verbatim; nothing is generated.
 * A line matched more than once (a repeated phrase) gets `## ` on every
 * occurrence — treated as acceptable rather than a case worth special handling,
 * since a genuinely repeated subheading marked twice is still correct.
 */
function insertHeadings(
  text: string,
  headings: readonly string[],
): { markdown: string; unmatchedHeadings: readonly string[] } {
  if (headings.length === 0) return { markdown: text, unmatchedHeadings: [] };

  const wanted = new Set(headings.map((h) => h.trim()));
  const matched = new Set<string>();

  const lines = text.split("\n").map((line) => {
    const trimmed = line.trim();
    if (wanted.has(trimmed)) {
      matched.add(trimmed);
      return `## ${trimmed}`;
    }
    return line;
  });

  const unmatchedHeadings = [...wanted].filter((h) => !matched.has(h));

  return { markdown: lines.join("\n"), unmatchedHeadings };
}

let callCounter = 0;
/** A local id for the one message this call sends — never persisted, never seen again. */
function newCallId(): string {
  callCounter += 1;
  return `classify-${Date.now().toString(36)}-${callCounter}`;
}
