import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PdfHasNoExtractableTextError } from "@nailzify/core";
import { createPdfExtractor, isLikelyScanned } from "./extractor.js";

const REAL_PDF = "data/documents/pdf/nailzify-return-policy.pdf";

// ---------------------------------------------------------------------------
// Against the real file, not a fabricated one — this is exactly what got
// verified by hand before choosing unpdf, kept as a permanent regression test
// rather than a one-off script run.
// ---------------------------------------------------------------------------

describe("extractText against a real PDF", () => {
  it("pulls readable text out of the store's own return policy", async () => {
    const bytes = await readFile(REAL_PDF);
    const extractor = createPdfExtractor();

    const text = await extractor.extractText(new Uint8Array(bytes));

    expect(text).toContain("Return Policy");
    expect(text).toContain("Money-Back Guarantee");
    expect(text).toContain("14-day money-back guarantee");
  });

  it("does not throw on a real, ordinary document", async () => {
    const bytes = await readFile(REAL_PDF);
    const extractor = createPdfExtractor();

    await expect(extractor.extractText(new Uint8Array(bytes))).resolves.not.toThrow();
  });

  it("returns trimmed text, not padded with leading/trailing whitespace", async () => {
    const bytes = await readFile(REAL_PDF);
    const extractor = createPdfExtractor();

    const text = await extractor.extractText(new Uint8Array(bytes));

    expect(text).toBe(text.trim());
  });
});

// ---------------------------------------------------------------------------
// The scanned-PDF guard, tested as plain numbers rather than a fabricated
// scanned-PDF fixture — the threshold decision is pure and does not need a
// real file to exercise its boundary.
// ---------------------------------------------------------------------------

describe("isLikelyScanned", () => {
  it("flags near-zero text per page as likely scanned", () => {
    // A blank page, or a scan with only a stray page-number character caught.
    expect(isLikelyScanned(0)).toBe(true);
    expect(isLikelyScanned(3)).toBe(true);
  });

  it("does not flag a normal page of prose", () => {
    // The real return-policy PDF measured ~2,000 characters over 1 page —
    // comfortably clear of the boundary in either direction.
    expect(isLikelyScanned(400)).toBe(false);
    expect(isLikelyScanned(2000)).toBe(false);
  });

  it("has a defined behaviour exactly at the boundary", () => {
    // Asserted so the boundary is a decision, not an accident of `<` vs `<=`.
    expect(isLikelyScanned(39)).toBe(true);
    expect(isLikelyScanned(40)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The full extractor wired to the guard — needs a real "no text" PDF, which a
// single blank page happens to produce even with unpdf's own text layer.
// ---------------------------------------------------------------------------

describe("extractText refuses a PDF with no real text layer", () => {
  it("throws PdfHasNoExtractableTextError rather than returning near-nothing", async () => {
    // A minimal, valid, single blank page PDF — no text objects at all. Built
    // by hand rather than shipped as a binary fixture, so the test file stays
    // readable and the fixture's construction is auditable in the diff.
    const blankPdf = buildBlankPagePdf();
    const extractor = createPdfExtractor();

    await expect(extractor.extractText(blankPdf)).rejects.toBeInstanceOf(
      PdfHasNoExtractableTextError,
    );
  });

  it("names the page count and character count in the error", async () => {
    const blankPdf = buildBlankPagePdf();
    const extractor = createPdfExtractor();

    const error = await extractor.extractText(blankPdf).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PdfHasNoExtractableTextError);
    if (error instanceof PdfHasNoExtractableTextError) {
      expect(error.totalPages).toBe(1);
      expect(error.extractedChars).toBe(0);
      expect(error.retryable).toBe(false);
    }
  });
});

/** The smallest valid single-page PDF with no text content: PDF 1.4, no fonts. */
function buildBlankPagePdf(): Uint8Array {
  const pdf = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj",
    "trailer << /Root 1 0 R >>",
    "%%EOF",
  ].join("\n");
  return new TextEncoder().encode(pdf);
}
