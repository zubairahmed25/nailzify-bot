import { describe, expect, it } from "vitest";
import { estimateTokens } from "../conversation/message.js";
import {
  chunkMarkdown,
  DEFAULT_CHUNKING_POLICY,
  structuralContextHeader,
  type ChunkingPolicy,
} from "./chunking.js";

/** ~4 chars per token, so this produces roughly `tokens` worth of prose. */
const words = (tokens: number): string =>
  Array.from({ length: Math.ceil(tokens * 0.75) }, (_, i) => `word${i}`).join(" ");

const tinyPolicy: ChunkingPolicy = {
  targetTokens: 100,
  maxTokens: 140,
  minTokens: 20,
  overlapTokens: 20,
};

describe("structure-aware splitting", () => {
  it("splits on headings and records the heading path", () => {
    const md = `
# Return Policy

## Eligibility

Returns are accepted within 30 days of delivery.

## Condition

Items must be unopened with seals intact.
`;
    const chunks = chunkMarkdown(md);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.section).toBe("Return Policy > Eligibility");
    expect(chunks[1]!.section).toBe("Return Policy > Condition");
  });

  it("truncates the heading path when a document jumps back up a level", () => {
    const md = `
# Policy

## Shipping

### International

Customs fees may apply.

## Returns

Within 30 days.
`;
    const chunks = chunkMarkdown(md);
    const sections = chunks.map((c) => c.section);

    expect(sections).toContain("Policy > Shipping > International");
    // "Returns" is a level-2 heading, so the level-3 "International" must be
    // dropped from the path rather than trailing along.
    expect(sections).toContain("Policy > Returns");
  });

  it("handles a document with no headings at all", () => {
    const chunks = chunkMarkdown("Just some prose with no structure whatsoever.");

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.section).toBe("");
  });

  it("returns nothing for empty input rather than an empty chunk", () => {
    // Indexing an empty chunk is actively harmful: it matches everything weakly
    // and pollutes every future search.
    expect(chunkMarkdown("")).toEqual([]);
    expect(chunkMarkdown("   \n\n  ")).toEqual([]);
  });
});

describe("size limits", () => {
  it("splits a section that exceeds the target", () => {
    const md = `## Long Section\n\n${words(200)}\n\n${words(200)}\n\n${words(200)}`;
    const chunks = chunkMarkdown(md, tinyPolicy);

    expect(chunks.length).toBeGreaterThan(1);
  });

  it("keeps a section under the target as a single chunk", () => {
    const md = `## Short\n\n${words(50)}`;
    expect(chunkMarkdown(md, tinyPolicy)).toHaveLength(1);
  });

  it("never emits a chunk far above the ceiling", () => {
    const md = `## Big\n\n${Array.from({ length: 20 }, () => words(60)).join("\n\n")}`;
    const chunks = chunkMarkdown(md, tinyPolicy);

    for (const chunk of chunks) {
      // Allow headroom for the overlap prefix, which is added on top of target.
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(tinyPolicy.maxTokens * 2);
    }
  });

  it("hard-splits a single sentence longer than the ceiling", () => {
    // Usually a table dump or a URL list. A crude cut beats a chunk the
    // embedding model would silently truncate.
    const md = `## Wall\n\n${words(600)}`;
    const chunks = chunkMarkdown(md, tinyPolicy);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length > 0)).toBe(true);
  });
});

describe("overlap", () => {
  it("repeats trailing context at the head of the next chunk", () => {
    const marker = "SENTINEL_PHRASE_AT_BOUNDARY";
    const md = `## S\n\n${words(90)}\n\n${marker}\n\n${words(90)}\n\n${words(90)}`;

    const chunks = chunkMarkdown(md, tinyPolicy);
    const appearances = chunks.filter((c) => c.text.includes(marker)).length;

    // The whole point of overlap: a passage near a boundary survives intact in
    // at least one chunk, ideally two.
    expect(appearances).toBeGreaterThanOrEqual(1);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("can be disabled", () => {
    const md = `## S\n\n${words(100)}\n\n${words(100)}\n\n${words(100)}`;
    const chunks = chunkMarkdown(md, { ...tinyPolicy, overlapTokens: 0 });

    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe("runt merging", () => {
  it("absorbs a tiny trailing fragment into its neighbour", () => {
    // A 5-token chunk reading "See section 4." is a useless retrieval unit.
    const md = `## S\n\n${words(95)}\n\n${words(95)}\n\nSee section 4.`;
    const chunks = chunkMarkdown(md, tinyPolicy);

    const runts = chunks.filter((c) => c.estimatedTokens < tinyPolicy.minTokens);
    expect(runts).toHaveLength(0);
    expect(chunks.some((c) => c.text.includes("See section 4."))).toBe(true);
  });

  it("keeps a short standalone section rather than losing it", () => {
    // Nothing to merge into — a short section on its own must survive, because
    // dropping it would silently remove content from the index.
    const chunks = chunkMarkdown("## Tiny\n\nShort.", tinyPolicy);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("Short.");
  });
});

describe("indexing", () => {
  it("numbers sections and chunks so ids are deterministic", () => {
    const md = `## A\n\n${words(150)}\n\n${words(150)}\n\n## B\n\n${words(30)}`;
    const chunks = chunkMarkdown(md, tinyPolicy);

    const sectionA = chunks.filter((c) => c.sectionIndex === 0);
    const sectionB = chunks.filter((c) => c.sectionIndex === 1);

    expect(sectionA.map((c) => c.chunkIndex)).toEqual(
      Array.from({ length: sectionA.length }, (_, i) => i),
    );
    expect(sectionB).toHaveLength(1);
    expect(sectionB[0]!.chunkIndex).toBe(0);
  });

  it("is deterministic across runs", () => {
    // Re-ingesting an unchanged document must produce identical ids, or every
    // sync duplicates vectors instead of overwriting them.
    const md = `## A\n\n${words(300)}`;
    expect(chunkMarkdown(md, tinyPolicy)).toEqual(chunkMarkdown(md, tinyPolicy));
  });
});

describe("structuralContextHeader", () => {
  it("situates a chunk using document and section", () => {
    const header = structuralContextHeader("Return Policy", {
      section: "Eligibility",
      chunkIndex: 0,
    });
    expect(header).toBe("[Return Policy — Eligibility]");
  });

  it("marks continuation chunks", () => {
    const header = structuralContextHeader("Return Policy", {
      section: "Eligibility",
      chunkIndex: 2,
    });
    expect(header).toContain("continued");
  });

  it("degrades gracefully with no section", () => {
    expect(structuralContextHeader("FAQ", { section: "", chunkIndex: 0 })).toBe("[FAQ]");
  });
});

describe("realistic policy document", () => {
  const policy = `
# Nailzify Shipping Policy

## Domestic Shipping

Standard shipping within the United States takes 3-5 business days.
Orders placed before 2pm ET ship the same business day.

Free shipping applies to orders over $35.

## International Shipping

We ship to Canada, the United Kingdom, and Australia. International
delivery takes 7-14 business days.

Customers are responsible for any customs duties or import taxes.

## Tracking

A tracking number is emailed once your order ships.
`;

  it("produces one focused chunk per section", () => {
    const chunks = chunkMarkdown(policy, DEFAULT_CHUNKING_POLICY);

    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.section)).toEqual([
      "Nailzify Shipping Policy > Domestic Shipping",
      "Nailzify Shipping Policy > International Shipping",
      "Nailzify Shipping Policy > Tracking",
    ]);
  });

  it("keeps a clause together with its qualifier", () => {
    // The failure this design exists to prevent: retrieving "we ship to Canada"
    // without "customers are responsible for customs duties".
    const chunks = chunkMarkdown(policy, DEFAULT_CHUNKING_POLICY);
    const intl = chunks.find((c) => c.section.includes("International"))!;

    expect(intl.text).toContain("Canada");
    expect(intl.text).toContain("customs duties");
  });

  it("stays within a sane token range", () => {
    for (const chunk of chunkMarkdown(policy, DEFAULT_CHUNKING_POLICY)) {
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(
        DEFAULT_CHUNKING_POLICY.maxTokens,
      );
    }
  });
});

describe("structuralContextHeader", () => {
  it("does not repeat the document title when the H1 already is the title", () => {
    // Caught by eyeballing a dry run: every chunk was headed
    // "[Return Policy — Return Policy > Money-Back Guarantee]". The header is
    // prepended to every chunk before embedding, so the waste is corpus-wide.
    const header = structuralContextHeader("Return Policy", {
      section: "Return Policy > Money-Back Guarantee",
      chunkIndex: 0,
    });

    expect(header).toBe("[Return Policy — Money-Back Guarantee]");
  });

  it("keeps a section path that does not start with the title", () => {
    expect(
      structuralContextHeader("Size Guide", { section: "How To Measure", chunkIndex: 0 }),
    ).toBe("[Size Guide — How To Measure]");
  });

  it("collapses to the title alone when the H1 is the only heading", () => {
    expect(
      structuralContextHeader("Return Policy", { section: "Return Policy", chunkIndex: 0 }),
    ).toBe("[Return Policy]");
  });

  it("matches case-insensitively", () => {
    expect(
      structuralContextHeader("Return Policy", { section: "RETURN POLICY > Refunds", chunkIndex: 0 }),
    ).toBe("[Return Policy — Refunds]");
  });

  it("still marks continuation chunks", () => {
    expect(
      structuralContextHeader("Return Policy", { section: "Return Policy > Refunds", chunkIndex: 1 }),
    ).toBe("[Return Policy — Refunds (continued)]");
  });
});
