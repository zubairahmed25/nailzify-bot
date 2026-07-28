/**
 * Document chunking.
 *
 * ============================================================================
 * WHY THIS FILE MATTERS MORE THAN THE MODEL
 * ============================================================================
 *
 * Retrieval quality is capped by chunking quality, and you cannot fix bad
 * chunking downstream. If the sentence that answers a question got split across
 * two chunks, no reranker, no bigger model, and no cleverer prompt recovers it —
 * the answer simply is not in any single retrievable unit.
 *
 * WHY CHUNK AT ALL. Two reasons, and only two:
 *
 *   1. A vector summarising 8,000 tokens is a blurry average. It matches
 *      everything weakly and nothing strongly, which is the worst possible
 *      property for a search index.
 *   2. We inject retrieved text into a paid prompt. Retrieving a 30-page PDF to
 *      answer one question wastes tokens AND buries the answer in noise.
 *
 * THE STRATEGY. Structure-aware, because our corpus already has structure:
 * policy documents come with headings that mark genuine semantic boundaries.
 * Splitting on those beats splitting every N characters, because a human already
 * decided where one idea ends.
 *
 *   Primary split   markdown headings
 *   Overflow        recursive split (paragraph -> sentence -> word)
 *   Overlap         so a boundary-straddling sentence survives intact somewhere
 *   Merge           absorb runt chunks into a neighbour
 *
 * WHY A PURE FUNCTION. No I/O, no clock, no network. The most consequential
 * decision in the RAG pipeline is exhaustively testable in milliseconds, and you
 * can sweep parameters against an eval set without deploying anything.
 */

import { estimateTokens } from "../conversation/message.js";

export interface ChunkingPolicy {
  /** Preferred size. Chunks aim for this and stop at the next clean boundary. */
  readonly targetTokens: number;
  /** Hard ceiling. A chunk is force-split rather than exceed this. */
  readonly maxTokens: number;
  /** Below this a chunk is a runt and gets merged into a neighbour. */
  readonly minTokens: number;
  /** Trailing context repeated at the head of the next chunk. */
  readonly overlapTokens: number;
}

/**
 * Defaults, and the reasoning — these are a tuned trade-off, not magic numbers.
 *
 *   Too small (128-256): high precision, but the answer's qualifiers get
 *     amputated. "Returns accepted within 30 days" retrieves without
 *     "...of delivery, provided the product is unopened."
 *   Too large (2000+): the embedding blurs. A chunk covering shipping AND
 *     returns AND exchanges is a weak match for all three.
 *
 * ~800 with overlap keeps a clause together with its qualifiers while staying
 * focused enough to produce a sharp vector.
 *
 * ⚠️ TUNE THESE ON YOUR OWN EVAL SET. Build 30-50 questions from your real
 * support inbox, sweep targetTokens, and measure recall@5. It takes an afternoon
 * and it is the difference between a bot that works and one that mostly works.
 */
export const DEFAULT_CHUNKING_POLICY: ChunkingPolicy = {
  targetTokens: 800,
  maxTokens: 1000,
  minTokens: 100,
  overlapTokens: 120,
};

/**
 * A chunk before it has an id or an embedding.
 *
 * Separate from `Chunk` because those require decisions this function cannot
 * make (which document, which embedding model). Keeping the pure text split
 * separate from identity assignment means the chunker stays testable in
 * isolation.
 */
export interface ChunkDraft {
  readonly text: string;
  /** Heading path, e.g. "Returns > Eligibility". Feeds contextual enrichment. */
  readonly section: string;
  readonly sectionIndex: number;
  readonly chunkIndex: number;
  readonly estimatedTokens: number;
}

interface Section {
  readonly heading: string;
  readonly body: string;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function chunkMarkdown(
  markdown: string,
  policy: ChunkingPolicy = DEFAULT_CHUNKING_POLICY,
): readonly ChunkDraft[] {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) return [];

  const sections = splitIntoSections(normalized);
  const drafts: ChunkDraft[] = [];

  sections.forEach((section, sectionIndex) => {
    const pieces = splitSection(section.body, policy);
    const merged = mergeRunts(pieces, policy);

    merged.forEach((text, chunkIndex) => {
      drafts.push({
        text,
        section: section.heading,
        sectionIndex,
        chunkIndex,
        estimatedTokens: estimateTokens(text),
      });
    });
  });

  return drafts;
}

// ---------------------------------------------------------------------------
// 1. Split on headings
// ---------------------------------------------------------------------------

/**
 * Break markdown at headings, tracking the full heading path.
 *
 * The path ("Returns > Eligibility" rather than just "Eligibility") matters
 * because it is what a contextual header is built from. A chunk labelled only
 * "Eligibility" is barely more situated than an unlabelled one.
 */
function splitIntoSections(markdown: string): readonly Section[] {
  const lines = markdown.split("\n");
  const sections: Section[] = [];

  // headingStack[i] holds the most recent heading at level i+1.
  const headingStack: string[] = [];
  let currentHeading = "";
  let buffer: string[] = [];

  const flush = (): void => {
    const body = buffer.join("\n").trim();
    if (body.length > 0) sections.push({ heading: currentHeading, body });
    buffer = [];
  };

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      flush();
      const level = match[1]!.length;
      const title = match[2]!.trim();

      // Truncate deeper levels, then set this one. Keeps the path consistent
      // when a document jumps from ### back up to ##.
      headingStack.length = Math.min(headingStack.length, level - 1);
      headingStack[level - 1] = title;
      currentHeading = headingStack.filter(Boolean).join(" > ");
    } else {
      buffer.push(line);
    }
  }
  flush();

  // A document with no headings at all is still one section.
  if (sections.length === 0) sections.push({ heading: "", body: markdown.trim() });

  return sections;
}

// ---------------------------------------------------------------------------
// 2. Split an oversized section
// ---------------------------------------------------------------------------

/**
 * Recursive split: paragraphs, then sentences, then words.
 *
 * The order encodes a preference for natural boundaries. We only fall to a
 * cruder split when the finer one cannot fit — so a mid-sentence cut happens
 * only when a single sentence genuinely exceeds the ceiling.
 */
function splitSection(body: string, policy: ChunkingPolicy): readonly string[] {
  if (estimateTokens(body) <= policy.maxTokens) return [body];

  const units = splitIntoUnits(body, policy);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const unit of units) {
    const unitTokens = estimateTokens(unit);

    if (currentTokens + unitTokens > policy.targetTokens && current.length > 0) {
      chunks.push(current.join("\n\n").trim());

      // Carry a tail of the finished chunk into the next one, so a clause split
      // across the boundary still appears intact in at least one chunk.
      const overlap = takeOverlap(current, policy.overlapTokens);
      current = overlap ? [overlap] : [];
      currentTokens = overlap ? estimateTokens(overlap) : 0;
    }

    current.push(unit);
    currentTokens += unitTokens;
  }

  if (current.length > 0) chunks.push(current.join("\n\n").trim());
  return chunks.filter((c) => c.length > 0);
}

/** Paragraphs, falling back to sentences then words for oversized ones. */
function splitIntoUnits(body: string, policy: ChunkingPolicy): readonly string[] {
  const units: string[] = [];

  for (const paragraph of body.split(/\n\s*\n/)) {
    const trimmed = paragraph.trim();
    if (trimmed.length === 0) continue;

    if (estimateTokens(trimmed) <= policy.maxTokens) {
      units.push(trimmed);
      continue;
    }

    for (const sentence of splitSentences(trimmed)) {
      if (estimateTokens(sentence) <= policy.maxTokens) {
        units.push(sentence);
      } else {
        // A single sentence over the ceiling. Rare (usually a table or a URL
        // dump). Hard-split by words — a crude cut is better than a chunk the
        // embedding model will truncate silently.
        units.push(...hardSplit(sentence, policy.maxTokens));
      }
    }
  }

  return units;
}

function splitSentences(text: string): readonly string[] {
  // Deliberately simple. A full sentence tokenizer is a dependency and a
  // maintenance burden for a marginal gain on well-formed policy prose.
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function hardSplit(text: string, maxTokens: number): readonly string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let current: string[] = [];

  for (const word of words) {
    current.push(word);
    if (estimateTokens(current.join(" ")) >= maxTokens) {
      out.push(current.join(" "));
      current = [];
    }
  }
  if (current.length > 0) out.push(current.join(" "));
  return out;
}

/** Take trailing units worth roughly `overlapTokens`, oldest-last. */
function takeOverlap(units: readonly string[], overlapTokens: number): string | null {
  if (overlapTokens <= 0 || units.length === 0) return null;

  const tail: string[] = [];
  let tokens = 0;

  for (let i = units.length - 1; i >= 0; i -= 1) {
    const unit = units[i]!;
    const unitTokens = estimateTokens(unit);
    // Never let overlap alone consume the whole budget.
    if (tokens + unitTokens > overlapTokens && tail.length > 0) break;
    tail.unshift(unit);
    tokens += unitTokens;
    if (tokens >= overlapTokens) break;
  }

  return tail.length > 0 ? tail.join("\n\n") : null;
}

// ---------------------------------------------------------------------------
// 3. Merge runts
// ---------------------------------------------------------------------------

/**
 * Absorb chunks below `minTokens` into a neighbour.
 *
 * WHY: a 20-token chunk reading "See section 4 for details." is a terrible
 * retrieval unit. It is too short to carry meaning, so its embedding is
 * dominated by generic phrasing and it matches unrelated queries weakly — adding
 * noise to every search without ever being the right answer.
 */
function mergeRunts(chunks: readonly string[], policy: ChunkingPolicy): readonly string[] {
  if (chunks.length <= 1) return chunks;

  const out: string[] = [];

  for (const chunk of chunks) {
    const previous = out[out.length - 1];

    if (
      previous !== undefined &&
      estimateTokens(chunk) < policy.minTokens &&
      estimateTokens(previous) + estimateTokens(chunk) <= policy.maxTokens
    ) {
      out[out.length - 1] = `${previous}\n\n${chunk}`;
    } else {
      out.push(chunk);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Contextual header
// ---------------------------------------------------------------------------

/**
 * Fallback situating header, built from structure alone.
 *
 * The good version is LLM-generated at ingest time (Anthropic's "contextual
 * retrieval" — commonly ~35% fewer retrieval failures, and ~50% combined with
 * contextual BM25). That costs one cheap Haiku call per chunk, which for a
 * 40-document corpus is a few dollars once. Best quality-per-dollar change in
 * the whole pipeline.
 *
 * This deterministic version exists so the pipeline degrades rather than fails
 * when the enrichment call errors or is switched off — and so chunking stays
 * testable without an LLM in the loop.
 */
export function structuralContextHeader(
  documentTitle: string,
  draft: Pick<ChunkDraft, "section" | "chunkIndex">,
): string {
  const parts = [documentTitle];
  const section = withoutRedundantRoot(draft.section, documentTitle);
  if (section) parts.push(section);
  const label = parts.join(" — ");
  return draft.chunkIndex > 0 ? `[${label} (continued)]` : `[${label}]`;
}

/**
 * Drop a leading heading segment that merely repeats the document title.
 *
 * Almost every document opens with an H1 that IS its title, and the heading path
 * faithfully records it. Combined with the title prefix that produced:
 *
 *     [Return Policy — Return Policy > Money-Back Guarantee]
 *
 * Caught by eyeballing a dry run, not by a test — every existing test used a
 * title that differed from its H1, so the duplication never appeared. It is
 * prepended to EVERY chunk before embedding, so the waste is corpus-wide, and a
 * repeated phrase pulls the vector very slightly toward itself.
 */
function withoutRedundantRoot(section: string, documentTitle: string): string {
  if (!section) return "";
  const [root, ...rest] = section.split(" > ");
  if (root?.trim().toLowerCase() !== documentTitle.trim().toLowerCase()) return section;
  return rest.join(" > ");
}
