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
  ProductKind,
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
 * Classify a product as a nail set or an accessory.
 *
 * ⚠️ THIS IS A HEURISTIC, AND IT IS THE ONLY ONE AVAILABLE. `productType` is the
 * field that should carry this and it is EMPTY on all 40 live products. So the
 * signal is the metafields: a product with no shape, style, colour or finish is
 * not a nail set.
 *
 * VALIDATED, NOT ASSUMED. On the live catalogue this classifies exactly 4 of 40
 * as accessories — Nail Remover, Glass Nail File, and the two glues — with no
 * nail set misclassified. "Snowflake Wishes" has no shape but does have a
 * colour, so it stays a nail set, which is correct.
 *
 * WHERE IT WOULD BREAK: a genuinely new nail set added with no metafields at all
 * would be classified an accessory and drop out of nail recommendations. That is
 * why scripts/verify-shopify.ts prints the accessory list on every run — the
 * check is "are these all non-nail products?", and it is a human check because
 * no better signal exists yet. If productType ever gets populated, switch to it.
 */
function classify(raw: RawMetafields): ProductKind {
  const hasNailAttribute =
    Boolean(raw.shape) || Boolean(raw.style) || raw.colours.length > 0 || raw.finishes.length > 0;
  return hasNailAttribute ? "nail-set" : "accessory";
}

export function parseMetafields(raw: RawMetafields, productTitle: string): ParsedAttributes {
  const warnings: string[] = [];
  const kind = classify(raw);

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
  } else if (kind === "nail-set") {
    // Only a warning when the product is evidently a nail set that is MISSING a
    // shape. A product with no shape, style, colour or finish is an accessory —
    // a file, a remover, a glue — and has no nail shape by nature.
    //
    // 4 of the 7 warnings on the live catalogue were accessories reported as
    // broken nail sets. That is worse than useless: it is the noise that trains
    // a merchandiser to stop reading warnings, and it buried the one product
    // ("Snowflake Wishes") that genuinely was a nail set missing its shape.
    warnings.push(`"${productTitle}": no shape metafield (custom.nail_text)`);
  }

  // ---- finishes -------------------------------------------------------------
  //
  // Keep every one. This used to take `[0]` and warn that it was discarding the
  // rest, which turned a correctly merchandised product into a warning and lost
  // real data: "Frozen" and "Chloe" are both Gloss AND Metallic, and dropping
  // the second made them unfindable by "metallic".
  const finishes: NailFinish[] = [];
  for (const raw_finish of raw.finishes) {
    const mapped = FINISHES[raw_finish.trim().toLowerCase()];
    if (mapped) {
      if (!finishes.includes(mapped)) finishes.push(mapped);
    } else {
      warnings.push(
        `"${productTitle}": unrecognised finish "${raw_finish}" — left unknown.`,
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
      kind,
      shape,
      length,
      finishes,
      // Occasion is not stored anywhere on the store. For a nail set "everyday"
      // is the only honest default: unlike a shape, it makes no specific claim a
      // customer could be misled by, and it only affects which queries surface a
      // product.
      //
      // An ACCESSORY gets nothing. A glue has no occasion and no experience
      // level, and handing it "everyday" let a nail file score points on "what's
      // good for every day?" — a fabricated attribute doing exactly the damage
      // fabricated attributes do.
      occasions: kind === "nail-set" ? (["everyday"] as Occasion[]) : [],
      // Deliberately permissive. Claiming a set is beginner-friendly when it is
      // not produces a bad first experience and a return.
      suitableFor:
        kind === "nail-set" ? (["comfortable", "experienced"] as ExperienceLevel[]) : [],
      colourNotes,
      style,
    },
    warnings,
  };
}
