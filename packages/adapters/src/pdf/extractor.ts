/**
 * PDF text extraction — implements the `PdfExtractor` port.
 *
 * ============================================================================
 * WHY unpdf
 * ============================================================================
 *
 * Verified before choosing, not assumed: installed it in isolation and ran it
 * against `data/documents/pdf/nailzify-return-policy.pdf`, the real PDF already
 * in this repo. Clean text out, headings included as plain lines (see the
 * "no automatic heading detection" note below).
 *
 * Zero dependencies, pure ESM, no native binaries, ~2.5MB installed. That last
 * point matters for a Lambda: no native compile step to get wrong on a
 * different architecture between a developer's machine and `arm64` in AWS.
 *
 * ============================================================================
 * NO OCR — A DELIBERATE v1 LIMIT, NOT AN OVERSIGHT
 * ============================================================================
 *
 * This reads the TEXT LAYER a PDF already contains. A born-digital PDF
 * (exported from Word, Google Docs, a policy generator) has one. A scanned
 * photo of a printed page does not, and extraction returns near-nothing.
 *
 * Amazon Textract would solve that — and adds an async job model, per-page
 * cost, and a second AWS service to the ingestion path, to solve a problem
 * this store's actual documents (see the sample above) do not have. Building
 * it now would be solving a problem nobody has hit yet, which is exactly the
 * kind of premature generality this codebase avoids elsewhere. The threshold
 * for revisiting: a real merchant upload that fails with
 * `PdfHasNoExtractableTextError` and turns out NOT to be a scanned image.
 */

import { extractText as unpdfExtractText, getDocumentProxy } from "unpdf";
import { PdfHasNoExtractableTextError, type PdfExtractor } from "@nailzify/core";

/**
 * Below this many characters per page, treat the PDF as having no real text
 * layer rather than index whatever scraps came out.
 *
 * ⚠️ A JUDGMENT CALL, NOT A MEASURED THRESHOLD. Unlike the retrieval floors
 * elsewhere in this codebase, there is no labelled set of scanned-vs-text PDFs
 * to calibrate against — only one real sample, which is comfortably real text
 * (see MIN_CHARS_PER_PAGE relative to its ~2,000 chars over 1 page). Revisit
 * this number if a real upload is wrongly accepted or wrongly rejected; do not
 * treat it as calibrated fact the way the rerank floor is.
 */
const MIN_CHARS_PER_PAGE = 40;

export function createPdfExtractor(): PdfExtractor {
  return {
    async extractText(bytes) {
      const pdf = await getDocumentProxy(bytes);
      const { totalPages, text } = await unpdfExtractText(pdf, { mergePages: true });

      const trimmed = text.trim();
      const charsPerPage = trimmed.length / Math.max(totalPages, 1);

      if (isLikelyScanned(charsPerPage)) {
        throw new PdfHasNoExtractableTextError(totalPages, trimmed.length);
      }

      return trimmed;
    },
  };
}

/**
 * Exported separately from `extractText` so the threshold decision is testable
 * with plain numbers — no need to fabricate a scanned-PDF file as a fixture to
 * exercise the boundary.
 */
export function isLikelyScanned(charsPerPage: number): boolean {
  return charsPerPage < MIN_CHARS_PER_PAGE;
}
