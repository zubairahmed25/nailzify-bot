import { describe, expect, it } from "vitest";
import { parseAttributes, productEmbeddingText } from "./attributes.js";

const parse = (tags: string[]) => parseAttributes(tags, "Test Product");

describe("parsing namespaced tags", () => {
  it("reads the core dimensions", () => {
    const { attributes } = parse(["shape:almond", "length:short", "finish:matte"]);

    expect(attributes.shape).toBe("almond");
    expect(attributes.length).toBe("short");
    expect(attributes.finish).toBe("matte");
  });

  it("is case and whitespace tolerant", () => {
    // Merchandisers type these by hand in the Shopify admin.
    const { attributes } = parse(["  Shape: Almond  ", "LENGTH:SHORT"]);

    expect(attributes.shape).toBe("almond");
    expect(attributes.length).toBe("short");
  });

  it("accepts both colour and color", () => {
    // A US/UK spelling split is exactly the kind of thing that silently loses
    // data, so both are canonicalised.
    expect(parse(["colour:warm-nude"]).attributes.colourNotes).toEqual(["warm nude"]);
    expect(parse(["color:warm-nude"]).attributes.colourNotes).toEqual(["warm nude"]);
  });

  it("collects repeatable dimensions", () => {
    const { attributes } = parse(["occasion:bridal", "occasion:party", "level:beginner"]);

    expect(attributes.occasions).toEqual(["bridal", "party"]);
    expect(attributes.suitableFor).toEqual(["beginner"]);
  });

  it("ignores untagged marketing tags without complaining", () => {
    // Warning on every free-text tag would bury the real signal.
    const { warnings } = parse([
      "shape:almond",
      "length:short",
      "finish:matte",
      "bestseller",
      "new-in",
    ]);

    expect(warnings.filter((w) => w.includes("bestseller"))).toHaveLength(0);
  });
});

describe("warnings make silent merchandising bugs visible", () => {
  it("warns on a typo rather than failing", () => {
    // THE FAILURE MODE THIS EXISTS FOR. "shape:almnod" would otherwise default
    // silently and the product would quietly stop matching shape queries.
    const { attributes, warnings } = parse(["shape:almnod", "length:short", "finish:matte"]);

    expect(attributes.shape).toBe("almond"); // safe default, parse still succeeds
    expect(warnings.some((w) => w.includes("almnod"))).toBe(true);
  });

  it("warns on a missing dimension", () => {
    const { warnings } = parse(["shape:almond"]);

    expect(warnings.some((w) => w.includes("missing length"))).toBe(true);
    expect(warnings.some((w) => w.includes("missing finish"))).toBe(true);
  });

  it("warns on conflicting tags and uses the first", () => {
    const { attributes, warnings } = parse(["shape:almond", "shape:square"]);

    expect(attributes.shape).toBe("almond");
    expect(warnings.some((w) => w.includes("multiple shape"))).toBe(true);
  });

  it("warns on an empty value", () => {
    const { warnings } = parse(["shape:"]);
    expect(warnings.some((w) => w.includes("empty value"))).toBe(true);
  });

  it("produces no warnings for a fully tagged product", () => {
    const { warnings } = parse([
      "shape:almond",
      "length:short",
      "finish:matte",
      "occasion:everyday",
      "level:beginner",
    ]);

    expect(warnings).toEqual([]);
  });
});

describe("defaults are chosen to be un-misleading", () => {
  it("defaults occasion to everyday", () => {
    expect(parse([]).attributes.occasions).toEqual(["everyday"]);
  });

  it("does NOT default to beginner-friendly", () => {
    // Claiming a set is easy to apply when it is not produces a bad first
    // experience and a return. Claiming nothing merely means it does not
    // surface for "I'm new to this" — a much cheaper error.
    expect(parse([]).attributes.suitableFor).not.toContain("beginner");
  });
});

describe("productEmbeddingText", () => {
  const attributes = parse([
    "shape:almond",
    "length:short",
    "finish:matte",
    "occasion:bridal",
    "colour:warm-nude",
  ]).attributes;

  const text = productEmbeddingText({
    title: "Autumn Almond",
    description: "A warm, muted set for everyday wear.",
    productType: "Press-on Nails",
    attributes,
  });

  it("includes descriptive attributes", () => {
    expect(text).toContain("Autumn Almond");
    expect(text).toContain("Shape: almond");
    expect(text).toContain("warm nude");
  });

  it("contains NO price and NO inventory", () => {
    // The two-plane rule at the ingestion boundary. A vector must never encode
    // a fact that can change without the document changing.
    expect(text).not.toMatch(/\$|price|USD|\d+\.\d{2}/i);
    expect(text).not.toMatch(/stock|inventory|available|quantity/i);
  });
});
