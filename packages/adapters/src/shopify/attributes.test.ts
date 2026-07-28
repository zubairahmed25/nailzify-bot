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
  it("leaves a typo'd attribute UNKNOWN rather than guessing", () => {
    // THE BUG A LIVE CATALOGUE CHECK CAUGHT. This used to fall back to "almond",
    // so the model was handed a fabricated fact and would state it to a customer
    // as truth. Parse still succeeds — but it must not invent.
    const { attributes, warnings } = parse(["shape:almnod", "length:short", "finish:matte"]);

    expect(attributes.shape).toBeNull();
    expect(warnings.some((w) => w.includes("almnod"))).toBe(true);
  });

  it("warns on a missing dimension and leaves it null", () => {
    const { attributes, warnings } = parse(["shape:almond"]);

    expect(attributes.length).toBeNull();
    expect(attributes.finish).toBeNull();
    expect(warnings.some((w) => w.includes("no length tag"))).toBe(true);
    expect(warnings.some((w) => w.includes("no finish tag"))).toBe(true);
  });

  it("invents nothing for a completely untagged product", () => {
    // The live catalogue reported `fully tagged 0/40`, so this is the common
    // case, not an edge case.
    const { attributes } = parse(["bestseller", "new-in"]);

    expect(attributes.shape).toBeNull();
    expect(attributes.length).toBeNull();
    expect(attributes.finish).toBeNull();
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

describe("the few remaining defaults are chosen to be un-misleading", () => {
  it("defaults occasion to everyday", () => {
    // Unlike shape/length/finish, "everyday" makes no specific claim a customer
    // could be misled by — it only affects which queries the product surfaces
    // for. Still a default, but an honest one.
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
