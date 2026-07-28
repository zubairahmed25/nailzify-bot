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
  /** Free-text cues, matched loosely against colour, finish and style. */
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

/**
 * Shapes that read as visually adjacent, so a near-miss still partly counts.
 *
 * Only the four shapes Nailzify actually sells. Squoval and stiletto used to
 * appear here as bridging entries; both were invented before anyone looked at
 * the store, so their removal leaves almond↔oval (both tapered, rounded tip)
 * and coffin↔square (both flat-tipped) as the real neighbour pairs.
 */
const ADJACENT_SHAPES: Readonly<Record<NailShape, readonly NailShape[]>> = {
  almond: ["oval"],
  oval: ["almond"],
  square: ["coffin"],
  coffin: ["square", "almond"],
};

const LENGTH_ORDER: readonly NailLength[] = ["short", "medium", "long"];

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
    // `style` (Shopify custom.nail_type) belongs in here: "chrome", "french",
    // "cat-eye" are how customers describe what they want, and that field is the
    // only place those words live. Omitting it made 35 of 40 products
    // unreachable by the phrasing customers actually use.
    const haystack = [...attrs.colourNotes, attrs.finish, attrs.style]
      .join(" ")
      .toLowerCase();
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
 * Nailzify's own size chart, transcribed from the published size guide.
 *
 * ⚠️ THIS IS A SET-BASED MODEL, NOT THE INDUSTRY ONE. An earlier version of this
 * file implemented the generic press-on model — individual nail sizes 0–11, one
 * size per finger — which is what most press-on brands use and what a model
 * asked to "size press-on nails" will confidently produce. Nailzify does not
 * sell that. A set is XS, S, M or L, and every set contains all five fingers at
 * fixed widths. Recommending "size 4" here would be a fluent, well-reasoned
 * answer to a question about a different shop.
 *
 * WHY THIS IS IN CODE AND NOT THE PROMPT: a model asked to do arithmetic on
 * measurements will usually get it right, and "usually" is the problem. A
 * customer who receives nails that don't fit has a returns case and a bad
 * experience. Deterministic logic is the correct tool for a deterministic
 * question.
 *
 * Source: data/documents/size-guide.md → nailzify.com/pages/size-guide-for-handmade-nails
 */
export type SetSize = "XS" | "S" | "M" | "L";
export type Finger = "thumb" | "index" | "middle" | "ring" | "little";

/** Ordered smallest to largest — index position is the step distance. */
const SET_ORDER: readonly SetSize[] = ["XS", "S", "M", "L"];

const SIZE_CHART_MM: Readonly<Record<SetSize, Readonly<Record<Finger, number>>>> = {
  XS: { thumb: 14, index: 10, middle: 11, ring: 10, little: 8 },
  S: { thumb: 15, index: 11, middle: 12, ring: 11, little: 9 },
  M: { thumb: 16, index: 12, middle: 13, ring: 12, little: 10 },
  L: { thumb: 17, index: 13, middle: 14, ring: 13, little: 11 },
};

/** A measurement in millimetres for each finger the customer actually measured. */
export type NailMeasurements = Partial<Record<Finger, number>>;

export interface SizeRecommendation {
  readonly size: SetSize;
  /** Per-finger set size implied by each measurement, before aggregation. */
  readonly perFinger: Readonly<Partial<Record<Finger, SetSize>>>;
  /**
   * True when the measured fingers do not agree on one set.
   *
   * Worth surfacing rather than hiding: it means no single set fits every
   * finger well, and the customer should hear that from us instead of
   * discovering it on delivery.
   */
  readonly mixed: boolean;
  /**
   * True when a measurement fell outside the chart entirely — wider than L or
   * narrower than XS. Clamped, but the customer needs to know it was clamped.
   */
  readonly outOfRange: boolean;
  /** Plain-language rationale the model can quote verbatim. */
  readonly reasons: readonly string[];
}

/**
 * Recommend a set size from one or more measured nail widths.
 *
 * ROUNDS UP, ALWAYS. Not to nearest. The store's own guidance is to size up by
 * 1–2mm because a wide press-on can be filed down while a narrow one exposes
 * the natural nail edge and lifts early. Nearest-match would round a 12.4mm
 * middle finger down to M (13mm... no) — the asymmetry is deliberate, so the
 * error we make is always the recoverable one.
 */
export function recommendSetSize(measurements: NailMeasurements): SizeRecommendation {
  const entries = Object.entries(measurements) as [Finger, number | undefined][];
  const measured = entries.filter((e): e is [Finger, number] => typeof e[1] === "number");

  if (measured.length === 0) {
    throw new TypeError("At least one finger measurement is required.");
  }
  for (const [finger, mm] of measured) {
    if (!Number.isFinite(mm) || mm <= 0) {
      throw new TypeError(`${finger} width must be a positive number, received ${mm}`);
    }
  }

  const perFinger: Partial<Record<Finger, SetSize>> = {};
  const reasons: string[] = [];
  let outOfRange = false;

  for (const [finger, mm] of measured) {
    // Smallest set whose nail for THIS finger is at least as wide as the
    // measurement. Never narrower — see the round-up rule above.
    const fit = SET_ORDER.find((size) => SIZE_CHART_MM[size][finger] >= mm);

    if (fit) {
      perFinger[finger] = fit;
    } else {
      // Wider than the widest set. Clamping to L is the only thing we can sell,
      // but saying so is mandatory — the alternative is a customer who ordered
      // on our advice and received nails that do not fit.
      perFinger[finger] = "L";
      outOfRange = true;
      reasons.push(
        `Your ${finger} measures ${mm}mm, wider than the ${SIZE_CHART_MM.L[finger]}mm ` +
          `${finger} in our largest set (L). L is the closest we make.`,
      );
    }
  }

  const chosen = aggregate(perFinger);
  const distinct = new Set(Object.values(perFinger));
  const mixed = distinct.size > 1;

  if (mixed) {
    const spread = [...distinct].sort(
      (a, b) => SET_ORDER.indexOf(a) - SET_ORDER.indexOf(b),
    );
    reasons.push(
      `Your measurements span ${spread.join(" and ")}. ${chosen} fits the most fingers; ` +
        `any that come out slightly wide can be filed down.`,
    );
  } else {
    reasons.push(`All the fingers you measured fall within our ${chosen} set.`);
  }

  reasons.push(
    "We recommend sizing up 1–2mm if you are between sizes — you can file a set " +
      "down to fit, but you cannot make it larger.",
  );

  return { size: chosen, perFinger, mixed, outOfRange, reasons };
}

/**
 * Collapse per-finger sizes into one set.
 *
 * Majority wins, because that is the store's published rule ("the size that best
 * matches the majority of your fingernails"). Ties break LARGER, because that is
 * the store's other published rule ("go with the larger size if you're uncertain")
 * and because it keeps the round-up asymmetry intact through aggregation.
 */
function aggregate(perFinger: Partial<Record<Finger, SetSize>>): SetSize {
  const counts = new Map<SetSize, number>();
  for (const size of Object.values(perFinger)) {
    counts.set(size, (counts.get(size) ?? 0) + 1);
  }

  let best: SetSize = SET_ORDER[0]!;
  let bestCount = -1;

  for (const size of SET_ORDER) {
    const count = counts.get(size) ?? 0;
    // `>=` walking smallest→largest means an equal count prefers the LARGER set.
    if (count > 0 && count >= bestCount) {
      best = size;
      bestCount = count;
    }
  }

  return best;
}

/** The published chart, for rendering back to a customer who asks to see it. */
export function sizeChart(): Readonly<Record<SetSize, Readonly<Record<Finger, number>>>> {
  return SIZE_CHART_MM;
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
