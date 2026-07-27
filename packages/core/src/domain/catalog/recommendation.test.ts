import { describe, expect, it } from "vitest";
import { ProductHandle, ProductId } from "../shared/brand.js";
import { money } from "../shared/money.js";
import type { Product, ProductAttributes, ProductCandidate } from "./product.js";
import { hydrate } from "./product.js";
import { recommendSize, selectRecommendations } from "./recommendation.js";

// ---------------------------------------------------------------------------
// Fixtures
//
// Note the signature: `id` is a separate positional argument rather than part of
// `overrides`. That is not stylistic — `Partial<Product>` types `id` as
// `ProductId`, so a plain string genuinely will not compile. Branding earning
// its keep in the test file too.
// ---------------------------------------------------------------------------

const baseAttributes: ProductAttributes = {
  shape: "almond",
  length: "short",
  finish: "matte",
  occasions: ["everyday", "professional"],
  suitableFor: ["beginner", "comfortable"],
  colourNotes: ["warm nude"],
};

function product(id: string, overrides: Partial<Omit<Product, "id">> = {}): Product {
  return {
    id: ProductId(id),
    handle: ProductHandle(`handle-${id}`),
    title: `Product ${id}`,
    description: "",
    url: `https://nailzify.com/products/${id}`,
    imageUrl: null,
    price: money(1800, "USD"),
    available: true,
    variants: [],
    attributes: baseAttributes,
    fetchedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function candidate(id: string, score: number): ProductCandidate {
  return { productId: ProductId(id), score, priceBand: "15-25", attributes: baseAttributes };
}

// ---------------------------------------------------------------------------
// The rule the whole architecture rests on
// ---------------------------------------------------------------------------

describe("the two-plane rule", () => {
  it("never recommends an out-of-stock product, even when it is the best fit", () => {
    // A perfect attribute match that happens to be sold out. Scoring alone would
    // rank it first; the hard filter must remove it entirely.
    const soldOutPerfectMatch = product("1", {
      available: false,
      attributes: { ...baseAttributes, shape: "almond", length: "short" },
    });
    const availableWorseMatch = product("2", {
      available: true,
      attributes: { ...baseAttributes, shape: "square", length: "long" },
    });

    const result = selectRecommendations([soldOutPerfectMatch, availableWorseMatch], {
      shape: "almond",
      length: "short",
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.product.id).toBe(ProductId("2"));
  });

  it("respects a stated budget as a hard filter, not a preference", () => {
    const overBudget = product("1", { price: money(3000, "USD") });
    const inBudget = product("2", { price: money(1200, "USD") });

    const result = selectRecommendations([overBudget, inBudget], {
      maxPrice: money(2000, "USD"),
    });

    expect(result.map((r) => r.product.id)).toEqual([ProductId("2")]);
  });

  it("drops candidates that no longer exist in Shopify", () => {
    // A vector left over from a deleted product. Hydration must let it fall out
    // rather than resurrect it from stale index data.
    const candidates = [candidate("live", 0.9), candidate("deleted", 0.95)];

    const { products, missing } = hydrate(candidates, [product("live")]);

    expect(products.map((p) => p.id)).toEqual([ProductId("live")]);
    expect(missing).toEqual([ProductId("deleted")]);
  });

  it("preserves semantic ranking through hydration", () => {
    // Shopify returns products in its own order; the vector store's relevance
    // ordering must survive the join or recommendation quality degrades silently.
    const candidates = [candidate("b", 0.9), candidate("a", 0.8)];
    const fetchedInDifferentOrder = [product("a"), product("b")];

    const { products } = hydrate(candidates, fetchedInDifferentOrder);

    expect(products.map((p) => p.id)).toEqual([ProductId("b"), ProductId("a")]);
  });
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

describe("selectRecommendations", () => {
  it("ranks an exact shape match above an adjacent one", () => {
    const exact = product("exact", { attributes: { ...baseAttributes, shape: "almond" } });
    const adjacent = product("adj", { attributes: { ...baseAttributes, shape: "oval" } });

    const result = selectRecommendations([adjacent, exact], { shape: "almond" });

    expect(result[0]!.product.id).toBe(ProductId("exact"));
    expect(result[0]!.fit).toBeGreaterThan(result[1]!.fit);
  });

  it("gives partial credit for a one-step length difference", () => {
    const exact = product("exact", { attributes: { ...baseAttributes, length: "short" } });
    const oneStep = product("near", { attributes: { ...baseAttributes, length: "medium" } });
    const twoStep = product("far", { attributes: { ...baseAttributes, length: "long" } });

    const result = selectRecommendations([twoStep, oneStep, exact], { length: "short" });

    expect(result.map((r) => r.product.id)).toEqual([
      ProductId("exact"),
      ProductId("near"),
      ProductId("far"),
    ]);
  });

  it("scores against stated preferences only", () => {
    // A customer who states one preference and matches it should score highly,
    // not be penalised for the four things they never mentioned.
    const p = product("1", { attributes: { ...baseAttributes, shape: "almond" } });

    const result = selectRecommendations([p], { shape: "almond" });

    expect(result[0]!.fit).toBe(1);
  });

  it("returns a stable order when fit ties", () => {
    // Without a deterministic tie-break the bot appears to change its mind
    // between identical requests.
    const cheap = product("cheap", { price: money(1000, "USD") });
    const pricey = product("pricey", { price: money(2000, "USD") });

    const first = selectRecommendations([pricey, cheap], {});
    const second = selectRecommendations([cheap, pricey], {});

    expect(first.map((r) => r.product.id)).toEqual(second.map((r) => r.product.id));
    expect(first[0]!.product.id).toBe(ProductId("cheap"));
  });

  it("always supplies a reason the model can quote", () => {
    const result = selectRecommendations([product("1")], {});
    expect(result[0]!.reasons.length).toBeGreaterThan(0);
  });

  it("honours the result limit", () => {
    const many = Array.from({ length: 10 }, (_, i) => product(`p${i}`));
    expect(selectRecommendations(many, {}, 3)).toHaveLength(3);
  });

  it("matches style notes against colour and finish", () => {
    const matte = product("matte", {
      attributes: { ...baseAttributes, finish: "matte", colourNotes: ["terracotta"] },
    });
    const glitter = product("glitter", {
      attributes: { ...baseAttributes, finish: "glitter", colourNotes: ["silver"] },
    });

    const result = selectRecommendations([glitter, matte], { styleNotes: ["terracotta"] });

    expect(result[0]!.product.id).toBe(ProductId("matte"));
  });
});

// ---------------------------------------------------------------------------
// Sizing — deterministic on purpose
// ---------------------------------------------------------------------------

describe("recommendSize", () => {
  it("maps a measurement to the nearest size", () => {
    expect(recommendSize(11.9).size).toBe(4);
    expect(recommendSize(9.5).size).toBe(7);
  });

  it("rounds an ambiguous measurement to the larger nail", () => {
    // 12.3mm sits exactly between size 3 (12.7) and size 4 (11.9). An oversized
    // press-on can be filed; an undersized one lifts. Prefer the recoverable error.
    expect(recommendSize(12.3).size).toBe(3);
  });

  it("flags measurements that sit between sizes", () => {
    expect(recommendSize(12.3).betweenSizes).toBe(true);
    expect(recommendSize(11.9).betweenSizes).toBe(false);
  });

  it("clamps to the ends of the table", () => {
    expect(recommendSize(30).size).toBe(0);
    expect(recommendSize(1).size).toBe(11);
  });

  it("rejects nonsense input rather than guessing", () => {
    expect(() => recommendSize(0)).toThrow(TypeError);
    expect(() => recommendSize(-5)).toThrow(TypeError);
    expect(() => recommendSize(Number.NaN)).toThrow(TypeError);
  });
});
