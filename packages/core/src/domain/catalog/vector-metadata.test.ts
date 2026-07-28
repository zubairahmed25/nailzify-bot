import { describe, expect, it } from "vitest";
import { ProductId } from "../shared/brand.js";
import type { ProductAttributes } from "./product.js";
import { productAttributesFromMetadata, productVectorMetadata } from "./product.js";

/** Reads a metadata bag the way the in-memory store does. */
function readerFor(m: Record<string, unknown>) {
  return {
    str: (k: string) => (typeof m[k] === "string" ? (m[k] as string) : ""),
    strArray: (k: string) => (Array.isArray(m[k]) ? (m[k] as string[]) : []),
  };
}

const full: ProductAttributes = {
  shape: "almond",
  length: "short",
  finishes: ["matte", "metallic"],
  style: "3D Cat-eye",
  occasions: ["bridal", "party"],
  suitableFor: ["beginner"],
  colourNotes: ["Pink", "Floral"],
};

describe("vector metadata round-trip", () => {
  it("preserves every attribute through write then read", () => {
    // THE DRIFT GUARD. Writer and reader are separate code paths joined only by
    // string keys, so a mismatch does not crash — it silently drops an attribute
    // from every product, and no other test fails. Adding a field to
    // ProductAttributes without touching both sides fails HERE.
    const metadata = productVectorMetadata({
      productId: ProductId("gid://shopify/Product/1"),
      priceBand: "15-25",
      attributes: full,
    });

    expect(productAttributesFromMetadata(readerFor(metadata))).toEqual(full);
  });

  it("round-trips a product with nothing known about it", () => {
    // The common live case: 5 of 40 products have no shape at all.
    const empty: ProductAttributes = {
      shape: null,
      length: null,
      finishes: [],
      style: null,
      occasions: [],
      suitableFor: [],
      colourNotes: [],
    };

    const metadata = productVectorMetadata({
      productId: ProductId("gid://shopify/Product/2"),
      priceBand: "15-25",
      attributes: empty,
    });

    expect(productAttributesFromMetadata(readerFor(metadata))).toEqual(empty);
  });

  it("omits unknown attributes rather than writing empty strings", () => {
    const metadata = productVectorMetadata({
      productId: ProductId("gid://shopify/Product/3"),
      priceBand: "15-25",
      attributes: { ...full, shape: null, style: null, finishes: [] },
    });

    expect(metadata).not.toHaveProperty("shape");
    expect(metadata).not.toHaveProperty("style");
    expect(metadata).not.toHaveProperty("finishes");
  });

  it("stores NO price and NO stock", () => {
    // The two-plane rule at the storage boundary. priceBand is a coarse bucket
    // used for filtering, never a price shown to a customer.
    const metadata = productVectorMetadata({
      productId: ProductId("gid://shopify/Product/4"),
      priceBand: "15-25",
      attributes: full,
    });

    expect(Object.keys(metadata)).not.toContain("price");
    expect(Object.keys(metadata)).not.toContain("available");
    expect(JSON.stringify(metadata)).not.toMatch(/\d+\.\d{2}/);
  });
});
