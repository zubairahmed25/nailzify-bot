/**
 * What text represents a product to the semantic index.
 *
 * WHY THIS IS IN CORE AND NOT THE SHOPIFY ADAPTER. It lived in the adapter
 * originally, beside the metafield parser that produces its input. But nothing
 * in it is Shopify-specific — it takes a title, a description and our own
 * ProductAttributes. Leaving it there would force the ingestion pipeline, which
 * lives in core, to import an adapter in order to do its job. That is the
 * dependency direction this architecture exists to forbid.
 *
 * The test for "does this belong in core?" is not "where did the data come
 * from?" but "would it change if we swapped the data source?". Swap Shopify for
 * a CSV and this function is untouched.
 */

import type { ProductAttributes } from "./product.js";

/**
 * Colour-pattern values that are patterns rather than colours.
 *
 * `shopify.color-pattern` is one taxonomy field covering both, so "Floral" and
 * "Geometric" arrive alongside "Pink". Both are useful for search; we just do
 * not want a pattern presented to a customer as a colour.
 */
const PATTERNS = new Set(["floral", "geometric", "abstract", "striped", "animal print"]);

/** True when a colour-pattern value describes a pattern rather than a colour. */
export const isPattern = (value: string): boolean => PATTERNS.has(value.trim().toLowerCase());

/**
 * The text embedded for the product semantic index.
 *
 * ⚠️ NOTE WHAT IS ABSENT: no price, no inventory, no variant SKUs. Only stable
 * descriptive text — the two-plane rule at the ingestion boundary.
 *
 * Unknown attributes are omitted rather than guessed, so a vector never encodes
 * a property the product may not have.
 */
export function productEmbeddingText(input: {
  readonly title: string;
  readonly description: string;
  readonly productType: string;
  readonly attributes: ProductAttributes;
}): string {
  const a = input.attributes;
  const colours = a.colourNotes.filter((c) => !isPattern(c));
  const patterns = a.colourNotes.filter(isPattern);

  return [
    input.title,
    input.productType,
    input.description,
    a.shape ? `Shape: ${a.shape}` : "",
    a.length ? `Length: ${a.length}` : "",
    a.finishes.length > 0 ? `Finish: ${a.finishes.join(", ")}` : "",
    // The dimension customers actually search by — "chrome nails", "french tips".
    a.style ? `Style: ${a.style}` : "",
    colours.length > 0 ? `Colours: ${colours.join(", ")}` : "",
    patterns.length > 0 ? `Pattern: ${patterns.join(", ")}` : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
