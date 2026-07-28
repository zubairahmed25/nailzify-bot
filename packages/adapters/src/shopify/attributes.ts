/**
 * Mapping Shopify product data onto our domain attributes.
 *
 * ============================================================================
 * THE MERCHANDISING CONTRACT
 * ============================================================================
 *
 * Our domain wants structured attributes — shape, length, finish, occasion,
 * experience level. Shopify gives us `tags: [String!]!` and `productType`.
 * Something has to bridge them, and the choice is a real trade-off:
 *
 *   NAMESPACED TAGS  (chosen)         METAFIELDS
 *   free                              require extra token access
 *   editable in the Shopify admin     need a definition + admin setup
 *   no extra API scope                structured and validated
 *   unvalidated — a typo is silent    typo-resistant
 *
 * Tags win for a store this size: a merchandiser can add `shape:almond` while
 * editing a product, with no developer involved. That editability is worth more
 * than validation at this scale.
 *
 * THE COST OF THAT CHOICE, AND HOW WE PAY IT. A typo (`shape:almnod`) leaves the
 * attribute unknown and the product quietly stops matching shape queries.
 * Nothing errors. So `parseAttributes` returns WARNINGS alongside the attributes
 * — every unparsed tag and every missing dimension. The nightly sync logs them,
 * turning an invisible merchandising bug into a report you can act on
 * (docs/10-operations.md §10.3).
 *
 * A live check of the real catalogue returned `fully tagged 0/40`, which is
 * exactly the situation these warnings exist to surface.
 *
 * Migrate to metafields when the catalogue outgrows one person's attention.
 */

import type {
  ExperienceLevel,
  NailFinish,
  NailLength,
  NailShape,
  Occasion,
  ProductAttributes,
} from "@nailzify/core";

const SHAPES = ["almond", "coffin", "square", "stiletto", "oval", "squoval"] as const;
const LENGTHS = ["short", "medium", "long", "extra-long"] as const;
const FINISHES = ["matte", "glossy", "glitter", "chrome", "textured"] as const;
const OCCASIONS = ["everyday", "bridal", "party", "professional", "holiday"] as const;
const LEVELS = ["beginner", "comfortable", "experienced"] as const;

/**
 * ⚠️ THERE ARE NO DEFAULTS, DELIBERATELY.
 *
 * An earlier version defaulted an untagged product to almond/medium/glossy. A
 * live check of the real catalogue found 0 of 40 products tagged — so every one
 * carried three fabricated attributes into the model's context, which it would
 * then state to a customer as fact.
 *
 * Unknown is `null`. A missing tag costs the product relevance in ranking, which
 * is the correct penalty; it must never buy the product a false claim.
 */

export interface ParsedAttributes {
  readonly attributes: ProductAttributes;
  /**
   * Merchandising problems found while parsing.
   *
   * Not errors — the parse always succeeds. These are the observability hook
   * that stops a silent tagging mistake from quietly degrading retrieval.
   */
  readonly warnings: readonly string[];
}

/**
 * Parse Shopify tags into domain attributes.
 *
 * Recognised tag forms (case-insensitive, whitespace tolerant):
 *
 *   shape:almond        length:short       finish:matte
 *   occasion:bridal     level:beginner     colour:warm-nude
 *
 * `color:` is accepted as a synonym for `colour:` — a US/UK spelling split is
 * exactly the kind of thing that silently loses data.
 */
export function parseAttributes(
  tags: readonly string[],
  productTitle: string,
): ParsedAttributes {
  const warnings: string[] = [];
  const pairs = new Map<string, string[]>();

  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    const separator = tag.indexOf(":");

    // Untagged free-text tags are legitimate (marketing, collections). Ignore
    // them silently — warning on every one would bury the real signal.
    if (separator === -1) continue;

    const key = tag.slice(0, separator).trim();
    const value = tag.slice(separator + 1).trim();
    if (value.length === 0) {
      warnings.push(`"${productTitle}": tag "${raw}" has an empty value`);
      continue;
    }

    const canonical = key === "color" ? "colour" : key;
    const existing = pairs.get(canonical);
    if (existing) existing.push(value);
    else pairs.set(canonical, [value]);
  }

  const single = <T extends string>(key: string, allowed: readonly T[]): T | null => {
    const values = pairs.get(key);
    if (!values || values.length === 0) {
      warnings.push(`"${productTitle}": no ${key} tag — attribute left unknown`);
      return null;
    }
    if (values.length > 1) {
      warnings.push(`"${productTitle}": multiple ${key} tags (${values.join(", ")}), using first`);
    }
    const value = values[0]!;
    if (!allowed.includes(value as T)) {
      warnings.push(
        `"${productTitle}": unrecognised ${key} "${value}" — expected one of ${allowed.join(", ")}`,
      );
      return null;
    }
    return value as T;
  };

  const many = <T extends string>(key: string, allowed: readonly T[]): T[] => {
    const values = pairs.get(key) ?? [];
    const valid: T[] = [];
    for (const value of values) {
      if (allowed.includes(value as T)) valid.push(value as T);
      else warnings.push(`"${productTitle}": unknown ${key} "${value}"`);
    }
    return valid;
  };

  const occasions = many<Occasion>("occasion", OCCASIONS);
  const suitableFor = many<ExperienceLevel>("level", LEVELS);

  if (occasions.length === 0) {
    // Not a warning worth escalating: "everyday" is a safe, honest default for
    // an untagged product and does not mislead a customer.
    occasions.push("everyday");
  }
  if (suitableFor.length === 0) {
    // Deliberately permissive. Claiming a set is beginner-friendly when it is
    // not produces a bad first experience; claiming nothing just means the
    // product does not surface for "I'm new to this" queries.
    suitableFor.push("comfortable", "experienced");
  }

  return {
    attributes: {
      shape: single<NailShape>("shape", SHAPES),
      length: single<NailLength>("length", LENGTHS),
      finish: single<NailFinish>("finish", FINISHES),
      occasions,
      suitableFor,
      colourNotes: (pairs.get("colour") ?? []).map((c) => c.replace(/-/g, " ")),
    },
    warnings,
  };
}

/**
 * The text that gets embedded for the product semantic index.
 *
 * ⚠️ NOTE WHAT IS ABSENT: no price, no inventory, no variant SKUs. Only stable
 * descriptive text. This is the two-plane rule at the ingestion boundary — a
 * vector must never encode a fact that can change without the document changing
 * (docs/01-architecture.md §1.2).
 *
 * If you are tempted to add price here "so semantic search understands budget",
 * don't. That is what `priceBand` metadata and live hydration are for.
 */
export function productEmbeddingText(input: {
  readonly title: string;
  readonly description: string;
  readonly productType: string;
  readonly attributes: ProductAttributes;
}): string {
  const { attributes: a } = input;
  return [
    input.title,
    input.productType,
    input.description,
    // Only assert what we actually know — an unknown attribute is omitted, not
    // guessed, so the vector never encodes a fabricated property either.
    a.shape ? `Shape: ${a.shape}` : "",
    a.length ? `Length: ${a.length}` : "",
    a.finish ? `Finish: ${a.finish}` : "",
    `Occasions: ${a.occasions.join(", ")}`,
    `Suitable for: ${a.suitableFor.join(", ")}`,
    a.colourNotes.length > 0 ? `Colours: ${a.colourNotes.join(", ")}` : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
