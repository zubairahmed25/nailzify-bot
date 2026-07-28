/**
 * Recommendation logic.
 *
 * This is the "senior in-store assistant" knowledge encoded as code: which shapes
 * suit which nail beds, which lengths suit which lifestyles, what a beginner
 * should avoid.
 *
 * A NOTE ON WHERE THIS LOGIC BELONGS. Some of it could equally live in a
 * document that gets ingested and retrieved (docs/12-roadmap.md §12.5), which
 * would let a merchandiser edit it without a deploy. That is genuinely the better
 * home for *style advice* — "terracotta suits warm undertones" is knowledge, and
 * RAG is good at knowledge.
 *
 * What stays here is anything that must be GUARANTEED rather than merely likely.
 * "Never recommend an out-of-stock product" cannot be a prompt instruction,
 * because a prompt is advisory and a filter is not. Rules the business would be
 * embarrassed to see broken belong in code.
 */

import { assertNever } from "../shared/result.js";
import { compareMoney, isAtMost, type Money } from "../shared/money.js";
import type {
  ExperienceLevel,
  NailLength,
  NailShape,
  Occasion,
  Product,
} from "./product.js";

// ---------------------------------------------------------------------------
// What the customer told us
// ---------------------------------------------------------------------------

/**
 * Every field is optional because a real conversation reveals preferences
 * gradually. A customer says "something for a wedding", then later "but short".
 * The type mirrors that: partial knowledge is the normal state, not an error.
 */
export interface CustomerPreferences {
  readonly shape?: NailShape;
  readonly length?: NailLength;
  readonly occasion?: Occasion;
  readonly experience?: ExperienceLevel;
  readonly maxPrice?: Money;
  /** Free-text style/colour cues, matched loosely against colour notes. */
  readonly styleNotes?: readonly string[];
}

export interface Recommendation {
  readonly product: Product;
  /** 0..1 — how well this fits the stated preferences. */
  readonly fit: number;
  /**
   * Why we picked it, in plain language.
   *
   * This exists so the model can explain the recommendation using OUR reasoning
   * rather than inventing its own. Handing the model a rationale is what turns
   * "here are some nails" into "these are short and matte, which is what you
   * asked for" — grounded, and it did not have to make anything up.
   */
  readonly reasons: readonly string[];
}

// ---------------------------------------------------------------------------
// Scoring weights
//
// Named constants, not magic numbers scattered through the function. When
// someone asks "why does length matter more than occasion?" there is one place
// to look, and one place to change.
// ---------------------------------------------------------------------------

const WEIGHT = {
  shape: 0.3,
  length: 0.25,
  occasion: 0.2,
  experience: 0.15,
  style: 0.1,
} as const;

/** Shapes that read as visually adjacent, so a near-miss still partly counts. */
const ADJACENT_SHAPES: Readonly<Record<NailShape, readonly NailShape[]>> = {
  almond: ["oval", "squoval"],
  oval: ["almond", "squoval"],
  squoval: ["oval", "square"],
  square: ["squoval"],
  coffin: ["stiletto", "squoval"],
  stiletto: ["coffin", "almond"],
};

const LENGTH_ORDER: readonly NailLength[] = ["short", "medium", "long", "extra-long"];

function lengthDistance(a: NailLength, b: NailLength): number {
  return Math.abs(LENGTH_ORDER.indexOf(a) - LENGTH_ORDER.indexOf(b));
}

// ---------------------------------------------------------------------------
// The main entry point
// ---------------------------------------------------------------------------

/**
 * Rank hydrated products against stated preferences.
 *
 * ⚠️ THE SIGNATURE IS THE POINT. This takes `readonly Product[]` — the live,
 * hydrated type. It is impossible to call with `ProductCandidate[]` straight
 * from the vector store, because those carry no price or availability.
 *
 * That is the two-plane rule from docs/01-architecture.md, enforced by the
 * compiler instead of by everyone remembering. See product.ts for the full
 * reasoning.
 */
export function selectRecommendations(
  products: readonly Product[],
  preferences: CustomerPreferences,
  limit = 4,
): readonly Recommendation[] {
  return products
    // HARD FILTER, not a scoring penalty. Recommending something a customer
    // cannot buy is worse than recommending nothing — it wastes their time and
    // reads as incompetence. A low score would still let it surface when the
    // candidate pool is thin; a filter never does.
    .filter((product) => product.available)
    .filter((product) =>
      preferences.maxPrice ? isAtMost(product.price, preferences.maxPrice) : true,
    )
    .map((product) => score(product, preferences))
    .sort(byFitThenPrice)
    .slice(0, limit);
}

function byFitThenPrice(a: Recommendation, b: Recommendation): number {
  const byFit = b.fit - a.fit;
  // Tie-break on price ascending. Deterministic ordering matters more than the
  // specific rule: without it, two equally-good products swap places between
  // requests and the bot appears to change its mind for no reason.
  return byFit !== 0 ? byFit : compareMoney(a.product.price, b.product.price);
}

function score(product: Product, prefs: CustomerPreferences): Recommendation {
  const attrs = product.attributes;
  const reasons: string[] = [];

  // `possible` tracks how much weight was actually in play. Scoring against the
  // full weight when the customer stated only one preference would make every
  // product look like a poor match.
  let earned = 0;
  let possible = 0;

  // An unknown attribute contributes to `possible` but earns nothing: we cannot
  // confirm a match, so the product ranks below a confirmed one without being
  // excluded outright.
  if (prefs.shape !== undefined) {
    possible += WEIGHT.shape;
    if (attrs.shape === null) {
      // no credit, and crucially no claim
    } else if (attrs.shape === prefs.shape) {
      earned += WEIGHT.shape;
      reasons.push(`${attrs.shape} shape, as you asked`);
    } else if (ADJACENT_SHAPES[prefs.shape].includes(attrs.shape)) {
      earned += WEIGHT.shape * 0.5;
      reasons.push(`${attrs.shape} shape, close to the ${prefs.shape} you wanted`);
    }
  }

  if (prefs.length !== undefined && attrs.length !== null) {
    possible += WEIGHT.length;
    const distance = lengthDistance(attrs.length, prefs.length);
    if (distance === 0) {
      earned += WEIGHT.length;
      reasons.push(`${attrs.length} length`);
    } else if (distance === 1) {
      earned += WEIGHT.length * 0.4;
      reasons.push(`${attrs.length} length, one step from your preference`);
    }
  }

  if (prefs.occasion !== undefined) {
    possible += WEIGHT.occasion;
    if (attrs.occasions.includes(prefs.occasion)) {
      earned += WEIGHT.occasion;
      reasons.push(`suits ${prefs.occasion} wear`);
    }
  }

  if (prefs.experience !== undefined) {
    possible += WEIGHT.experience;
    if (attrs.suitableFor.includes(prefs.experience)) {
      earned += WEIGHT.experience;
      if (prefs.experience === "beginner") {
        reasons.push("straightforward to apply if you're new to press-ons");
      }
    }
  }

  if (prefs.styleNotes?.length) {
    possible += WEIGHT.style;
    const haystack = [...attrs.colourNotes, attrs.finish].join(" ").toLowerCase();
    const hits = prefs.styleNotes.filter((note) => haystack.includes(note.toLowerCase()));
    if (hits.length > 0) {
      earned += WEIGHT.style * (hits.length / prefs.styleNotes.length);
      reasons.push(
        attrs.finish
          ? `${attrs.finish} finish in ${attrs.colourNotes.join(", ")}`
          : `${attrs.colourNotes.join(", ")}`,
      );
    }
  }

  // No stated preferences at all — a browsing customer. Everything in stock is
  // an equally valid suggestion; let the tie-break on price order them.
  const fit = possible === 0 ? 0.5 : earned / possible;

  if (reasons.length === 0) reasons.push("currently in stock");

  return { product, fit, reasons };
}

// ---------------------------------------------------------------------------
// Sizing — the one place a wrong answer physically doesn't fit
// ---------------------------------------------------------------------------

/**
 * Standard press-on size numbering, widest nail bed first.
 *
 * WHY THIS IS IN CODE AND NOT THE PROMPT: a model asked to do arithmetic on
 * measurements will usually get it right, and "usually" is the problem. A
 * customer who receives nails that don't fit has a returns case and a bad
 * experience. Deterministic logic is the correct tool for a deterministic
 * question.
 */
const SIZE_TABLE_MM: readonly { size: number; widthMm: number }[] = [
  { size: 0, widthMm: 15.9 },
  { size: 1, widthMm: 14.3 },
  { size: 2, widthMm: 13.5 },
  { size: 3, widthMm: 12.7 },
  { size: 4, widthMm: 11.9 },
  { size: 5, widthMm: 11.1 },
  { size: 6, widthMm: 10.3 },
  { size: 7, widthMm: 9.5 },
  { size: 8, widthMm: 8.7 },
  { size: 9, widthMm: 7.9 },
  { size: 10, widthMm: 7.0 },
  { size: 11, widthMm: 6.2 },
];

export interface SizeRecommendation {
  readonly size: number;
  readonly widthMm: number;
  /** True when the measurement sits awkwardly between two sizes. */
  readonly betweenSizes: boolean;
}

/**
 * Nearest press-on size for a measured nail bed width.
 *
 * Ties round to the LARGER nail (lower size number). A slightly oversized
 * press-on can be filed down; an undersized one exposes the natural nail edge
 * and lifts early. When rounding is ambiguous, pick the recoverable error.
 */
export function recommendSize(widthMm: number): SizeRecommendation {
  if (!Number.isFinite(widthMm) || widthMm <= 0) {
    throw new TypeError(`Nail bed width must be a positive number, received ${widthMm}`);
  }

  let best = SIZE_TABLE_MM[0]!;
  let bestDelta = Math.abs(best.widthMm - widthMm);

  for (const entry of SIZE_TABLE_MM) {
    const delta = Math.abs(entry.widthMm - widthMm);
    // Strict `<` keeps the earlier (larger-nail) entry on an exact tie.
    if (delta < bestDelta) {
      best = entry;
      bestDelta = delta;
    }
  }

  // Steps in the table are ~0.8mm, so a delta above 0.35mm means the measurement
  // sits near a boundary and the customer should be told rather than guessed at.
  return { size: best.size, widthMm: best.widthMm, betweenSizes: bestDelta > 0.35 };
}

/** Human-readable label for an experience level, for use in generated copy. */
export function describeExperience(level: ExperienceLevel): string {
  switch (level) {
    case "beginner":
      return "new to press-on nails";
    case "comfortable":
      return "has applied press-ons before";
    case "experienced":
      return "confident with application and shaping";
    default:
      return assertNever(level, "ExperienceLevel");
  }
}
