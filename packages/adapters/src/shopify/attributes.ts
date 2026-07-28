/**
 * Mapping Shopify product metafields onto our domain attributes.
 *
 * ============================================================================
 * WHERE THE DATA ACTUALLY LIVES
 * ============================================================================
 *
 * Metafields, not tags. An earlier version parsed namespaced tags and reported
 * "0/40 products tagged", which looked like a merchandising gap and was in fact
 * the parser reading the wrong place entirely.
 *
 *   custom.nail_text          shape     single_line_text_field   35/40
 *   custom.nail_type          style     single_line_text_field   35/40
 *   shopify.color-pattern     colour    list.metaobject_reference 24/40
 *   shopify.finish            finish    list.metaobject_reference 15/40
 *
 * ⚠️ TWO DIFFERENT VALUE SHAPES. The `custom.*` fields are plain strings. The
 * `shopify.*` fields are taxonomy-backed and store METAOBJECT REFERENCES — the
 * raw `value` is a JSON array of GIDs like ["gid://shopify/Metaobject/1002..."],
 * and the human-readable name only appears via the resolved reference. Reading
 * `value` directly for those would store a GID as if it were a colour.
 *
 * This adapter therefore takes RESOLVED values (see product-catalog.ts, which
 * asks for `references { field(key: "label") }`) and normalises from there.
 *
 * WHY NO DEFAULTS: an unknown attribute is `null`. See ProductAttributes — a
 * fabricated attribute is a hallucination we manufacture ourselves, and it is
 * the exact failure this architecture exists to prevent.
 */

import type {
  ExperienceLevel,
  NailFinish,
  NailLength,
  NailShape,
  Occasion,
  ProductAttributes,
} from "@nailzify/core";

/** Raw, already-resolved metafield values for one product. */
export interface RawMetafields {
  /** `custom.nail_text` — e.g. "Almond", "Short Almond". */
  readonly shape: string | null;
  /** `custom.nail_type` — e.g. "Chrome", "3D Cat-eye". */
  readonly style: string | null;
  /** `shopify.color-pattern`, resolved to labels — e.g. ["Pink"]. */
  readonly colours: readonly string[];
  /** `shopify.finish`, resolved to labels — e.g. ["Gloss"]. */
  readonly finishes: readonly string[];
}

export interface ParsedAttributes {
  readonly attributes: ProductAttributes;
  /**
   * Merchandising problems found while parsing.
   *
   * Not errors — parsing always succeeds. These are the observability hook that
   * stops an unrecognised value from silently removing a product from filtered
   * search with nothing to indicate why.
   */
  readonly warnings: readonly string[];
}

// Derived from the live catalogue, not invented. Re-derive with
// scripts/probe-metafields.ts when the store's vocabulary changes.
const SHAPES: Record<string, NailShape> = {
  almond: "almond",
  square: "square",
  coffin: "coffin",
  oval: "oval",
};

const FINISHES: Record<string, NailFinish> = {
  gloss: "gloss",
  glossy: "gloss",
  matte: "matte",
  metallic: "metallic",
};

const LENGTHS: Record<string, NailLength> = {
  short: "short",
  medium: "medium",
  long: "long",
};

/**
 * Colour-pattern values that are patterns rather than colours.
 *
 * `shopify.color-pattern` is one taxonomy field covering both, so "Floral" and
 * "Geometric" arrive alongside "Pink". Both are useful for search; we just do
 * not want a pattern presented to a customer as a colour.
 */
const PATTERNS = new Set(["floral", "geometric", "abstract", "striped", "animal print"]);

export function parseMetafields(raw: RawMetafields, productTitle: string): ParsedAttributes {
  const warnings: string[] = [];

  // ---- shape, and the length hiding inside it ------------------------------
  //
  // 2 of 40 products use "Short Almond" / "Long Almond", packing two dimensions
  // into one field. Splitting it recovers a length we would otherwise never have,
  // since no length metafield exists at all.
  let shape: NailShape | null = null;
  let length: NailLength | null = null;

  if (raw.shape) {
    const words = raw.shape.trim().toLowerCase().split(/\s+/);
    for (const word of words) {
      if (SHAPES[word]) shape = SHAPES[word]!;
      else if (LENGTHS[word]) length = LENGTHS[word]!;
    }
    if (!shape) {
      warnings.push(
        `"${productTitle}": unrecognised shape "${raw.shape}" — left unknown. ` +
          `Expected one of ${Object.keys(SHAPES).join(", ")}.`,
      );
    }
  } else {
    warnings.push(`"${productTitle}": no shape metafield (custom.nail_text)`);
  }

  // ---- finish ---------------------------------------------------------------
  let finish: NailFinish | null = null;
  if (raw.finishes.length > 0) {
    const first = raw.finishes[0]!.trim().toLowerCase();
    finish = FINISHES[first] ?? null;
    if (!finish) {
      warnings.push(
        `"${productTitle}": unrecognised finish "${raw.finishes[0]}" — left unknown.`,
      );
    }
    if (raw.finishes.length > 1) {
      warnings.push(
        `"${productTitle}": multiple finishes (${raw.finishes.join(", ")}), using the first.`,
      );
    }
  }

  // ---- colours and patterns -------------------------------------------------
  const colourNotes = raw.colours.map((c) => c.trim()).filter(Boolean);

  // ---- style ----------------------------------------------------------------
  // Kept verbatim. Normalising "3D Cat-eye" and "Cat-eye 3D" to a canonical form
  // would need a synonym table that rots; the embedding handles both, and the
  // customer-facing string should be the merchandiser's own wording.
  const style = raw.style?.trim() || null;

  return {
    attributes: {
      shape,
      length,
      finish,
      // Occasion is not stored anywhere on the store. "everyday" is the only
      // honest default: unlike a shape, it makes no specific claim a customer
      // could be misled by, and it only affects which queries surface a product.
      occasions: ["everyday"] as Occasion[],
      // Deliberately permissive. Claiming a set is beginner-friendly when it is
      // not produces a bad first experience and a return.
      suitableFor: ["comfortable", "experienced"] as ExperienceLevel[],
      colourNotes,
      style,
    },
    warnings,
  };
}

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
    a.finish ? `Finish: ${a.finish}` : "",
    // The dimension customers actually search by — "chrome nails", "french tips".
    a.style ? `Style: ${a.style}` : "",
    colours.length > 0 ? `Colours: ${colours.join(", ")}` : "",
    patterns.length > 0 ? `Pattern: ${patterns.join(", ")}` : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
