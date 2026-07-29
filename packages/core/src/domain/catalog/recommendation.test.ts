import { describe, expect, it } from "vitest";
import { ProductHandle, ProductId } from "../shared/brand.js";
import { money } from "../shared/money.js";
import type { Product, ProductAttributes, ProductCandidate } from "./product.js";
import { hydrate } from "./product.js";
import { recommendSetSize, selectRecommendations } from "./recommendation.js";

// ---------------------------------------------------------------------------
// Fixtures
//
// Note the signature: `id` is a separate positional argument rather than part of
// `overrides`. That is not stylistic — `Partial<Product>` types `id` as
// `ProductId`, so a plain string genuinely will not compile. Branding earning
// its keep in the test file too.
// ---------------------------------------------------------------------------

const baseAttributes: ProductAttributes = {
  kind: "nail-set",
  tags: [],
  shape: "almond",
  length: "short",
  finishes: ["matte"],
  occasions: ["everyday", "professional"],
  suitableFor: ["beginner", "comfortable"],
  colourNotes: ["warm nude"],
  style: "Chrome",
};

function product(id: string, overrides: Partial<Omit<Product, "id">> = {}): Product {
  return {
    id: ProductId(id),
    handle: ProductHandle(`handle-${id}`),
    title: `Product ${id}`,
    description: "",
    productType: "Press-on Nails",
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
    // between identical requests. Relevance order is deterministic too — the
    // same query produces the same candidate order — so this still holds.
    const a = product("a", { price: money(2000, "USD") });
    const b = product("b", { price: money(1000, "USD") });

    expect(selectRecommendations([a, b], {}).map((r) => r.product.id)).toEqual(
      selectRecommendations([a, b], {}).map((r) => r.product.id),
    );
  });

  it("keeps semantic rank when nothing distinguishes the products", () => {
    // THE LIVE BUG. A browsing customer states no structured preference, so every
    // product scores fit = 0.5 and the tie-break decides the whole result. It used
    // to be price, which returned the four cheapest items in the store regardless
    // of the question. On the real catalogue that put "Nail Remover" ($7.99) top
    // for someone shopping for nails.
    const semanticOrder = [
      product("azure", { price: money(1399, "USD") }),
      product("cotton-candy", { price: money(1299, "USD") }),
      product("nail-remover", { price: money(799, "USD") }),
    ];

    const result = selectRecommendations(semanticOrder, {});

    expect(result.map((r) => r.product.id)).toEqual([
      ProductId("azure"),
      ProductId("cotton-candy"),
      ProductId("nail-remover"),
    ]);
  });

  it("does not leak the internal rank field to callers", () => {
    expect(selectRecommendations([product("1")], {})[0]).not.toHaveProperty("rank");
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
      attributes: { ...baseAttributes, finishes: ["matte"], colourNotes: ["terracotta"] },
    });
    const gloss = product("gloss", {
      attributes: { ...baseAttributes, finishes: ["gloss"], colourNotes: ["silver"] },
    });

    const result = selectRecommendations([gloss, matte], { styleNotes: ["terracotta"] });

    expect(result[0]!.product.id).toBe(ProductId("matte"));
  });
});

// ---------------------------------------------------------------------------
// Sizing — deterministic on purpose
// ---------------------------------------------------------------------------

describe("recommendSetSize", () => {
  it("recommends the set that contains the measured nail", () => {
    // Middle finger 12mm: XS is 11mm (too narrow), S is 12mm (exact).
    expect(recommendSetSize({ middle: 12 }).size).toBe("S");
  });

  it("rounds UP rather than to nearest", () => {
    // 12.4mm is nearer S (12mm) than M (13mm), but S would be narrower than the
    // nail. A wide press-on files down; a narrow one lifts. Always round up.
    expect(recommendSetSize({ middle: 12.4 }).size).toBe("M");
    expect(recommendSetSize({ middle: 12.1 }).size).toBe("M");
  });

  it("never recommends the generic industry sizes", () => {
    // Guards the exact mistake this rewrite fixed: "size 4" is a fluent answer
    // about a shop that is not this one.
    const result = recommendSetSize({ middle: 12 });
    expect(["XS", "S", "M", "L"]).toContain(result.size);
  });

  it("resolves disagreement across fingers by majority", () => {
    // Three fingers land in S, one in M. Majority rule from the published guide.
    const result = recommendSetSize({ index: 11, middle: 12, ring: 11, little: 9.5 });
    expect(result.size).toBe("S");
    expect(result.mixed).toBe(true);
  });

  it("breaks a tie towards the larger set", () => {
    // Two fingers S, two fingers M. The store's own tie-break is "go larger".
    const result = recommendSetSize({ index: 11, middle: 12, ring: 12, little: 10 });
    expect(result.perFinger).toEqual({
      index: "S", middle: "S", ring: "M", little: "M",
    });
    expect(result.size).toBe("M");
  });

  it("reports rather than hides a nail wider than the largest set", () => {
    // Clamping silently would send a customer nails that do not fit, on our advice.
    const result = recommendSetSize({ thumb: 19 });
    expect(result.size).toBe("L");
    expect(result.outOfRange).toBe(true);
    expect(result.reasons.join(" ")).toContain("wider than");
  });

  it("fits the smallest set without flagging a narrow nail", () => {
    // Narrower than XS is fine — it files down. Only too-wide is a problem.
    const result = recommendSetSize({ little: 6 });
    expect(result.size).toBe("XS");
    expect(result.outOfRange).toBe(false);
  });

  it("sizes each finger against its own column, not one shared width", () => {
    // 14mm is an XS thumb and wider than any little finger we make. A single
    // width table would have to be wrong about one of them.
    expect(recommendSetSize({ thumb: 14 }).perFinger.thumb).toBe("XS");
    expect(recommendSetSize({ little: 14 }).outOfRange).toBe(true);
  });

  it("always supplies a reason the model can quote", () => {
    expect(recommendSetSize({ middle: 12 }).reasons.length).toBeGreaterThan(0);
  });

  it("rejects nonsense input rather than guessing", () => {
    expect(() => recommendSetSize({})).toThrow(TypeError);
    expect(() => recommendSetSize({ middle: 0 })).toThrow(TypeError);
    expect(() => recommendSetSize({ middle: -5 })).toThrow(TypeError);
    expect(() => recommendSetSize({ middle: Number.NaN })).toThrow(TypeError);
  });
});
