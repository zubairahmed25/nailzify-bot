import { describe, expect, it } from "vitest";
import { productEmbeddingText } from "@nailzify/core";
import { parseMetafields, type RawMetafields } from "./attributes.js";

const parse = (raw: Partial<RawMetafields>) =>
  parseMetafields(
    { shape: null, style: null, colours: [], finishes: [], tags: [], ...raw },
    "Test Product",
  );

describe("parsing metafields", () => {
  it("reads the core dimensions", () => {
    const { attributes } = parse({
      shape: "Almond",
      style: "Chrome",
      finishes: ["Matte"],
      colours: ["Pink"],
    });

    expect(attributes.shape).toBe("almond");
    expect(attributes.finishes).toEqual(["matte"]);
    expect(attributes.style).toBe("Chrome");
    expect(attributes.colourNotes).toEqual(["Pink"]);
  });

  it("is case and whitespace tolerant", () => {
    // Merchandisers type these by hand in the Shopify admin.
    const { attributes } = parse({ shape: "  ALMOND ", finishes: [" Gloss "] });

    expect(attributes.shape).toBe("almond");
    expect(attributes.finishes).toEqual(["gloss"]);
  });

  it("splits a length out of a compound shape value", () => {
    // 2 of 40 live products pack two dimensions into custom.nail_text as
    // "Short Almond" / "Long Almond". There is no length metafield at all, so
    // this is the only place a length can come from.
    const shortAlmond = parse({ shape: "Short Almond" }).attributes;
    expect(shortAlmond.shape).toBe("almond");
    expect(shortAlmond.length).toBe("short");

    const longAlmond = parse({ shape: "Long Almond" }).attributes;
    expect(longAlmond.shape).toBe("almond");
    expect(longAlmond.length).toBe("long");
  });

  it("leaves length null when the shape field carries only a shape", () => {
    // The common case — 33 of the 35 products with a shape. Length is genuinely
    // unknown, and unknown must not become a guess.
    expect(parse({ shape: "Coffin" }).attributes.length).toBeNull();
  });

  it("treats glossy as gloss", () => {
    expect(parse({ finishes: ["Glossy"] }).attributes.finishes).toEqual(["gloss"]);
  });

  it("keeps style verbatim rather than normalising it", () => {
    // "3D Cat-eye" and "Cat-eye 3D" both exist live. Canonicalising them needs a
    // synonym table that rots; the embedding handles both, and the customer
    // should see the merchandiser's own wording.
    expect(parse({ style: "3D Cat-eye" }).attributes.style).toBe("3D Cat-eye");
    expect(parse({ style: "Cat-eye 3D" }).attributes.style).toBe("Cat-eye 3D");
  });
});

describe("warnings make silent merchandising bugs visible", () => {
  it("leaves an unrecognised shape UNKNOWN rather than guessing", () => {
    // THE BUG A LIVE CATALOGUE CHECK CAUGHT. This used to fall back to "almond",
    // so the model was handed a fabricated fact and stated it to a customer as
    // truth. Parsing still succeeds — but it must not invent.
    const { attributes, warnings } = parse({ shape: "Almnod" });

    expect(attributes.shape).toBeNull();
    expect(warnings.some((w) => w.includes("Almnod"))).toBe(true);
  });

  it("warns when a nail set is missing its shape", () => {
    // "Snowflake Wishes" on the live catalogue — clearly a nail set (it has a
    // colour) but with no shape metafield. The one genuine merchandising gap.
    const { attributes, warnings } = parse({ colours: ["White"] });

    expect(attributes.shape).toBeNull();
    expect(warnings.some((w) => w.includes("custom.nail_text"))).toBe(true);
  });

  it("does NOT warn about an accessory having no nail shape", () => {
    // A nail file, a remover and two glues have no shape by nature. Reporting
    // them as broken nail sets was 4 of the 7 live warnings — the noise that
    // trains a merchandiser to stop reading warnings at all.
    expect(parse({}).warnings).toEqual([]);
  });

  it("invents nothing for a product with no metafields at all", () => {
    const { attributes } = parse({});

    expect(attributes.shape).toBeNull();
    expect(attributes.length).toBeNull();
    expect(attributes.finishes).toEqual([]);
    expect(attributes.style).toBeNull();
    expect(attributes.colourNotes).toEqual([]);
  });

  it("warns on an unrecognised finish and stores nothing", () => {
    const { attributes, warnings } = parse({ finishes: ["Holographic"] });

    expect(attributes.finishes).toEqual([]);
    expect(warnings.some((w) => w.includes("Holographic"))).toBe(true);
  });

  it("keeps every finish rather than discarding all but the first", () => {
    // "Frozen" and "Chloe" are live products carrying Gloss AND Metallic.
    // shopify.finish is declared `list.metaobject_reference` — Shopify itself
    // says it is multi-valued. Taking [0] lost real data, made both products
    // unfindable by "metallic", and warned about correct merchandising.
    const { attributes, warnings } = parse({ shape: "Almond", finishes: ["Gloss", "Metallic"] });

    expect(attributes.finishes).toEqual(["gloss", "metallic"]);
    expect(warnings).toEqual([]);
  });

  it("keeps the recognised finishes and warns only about the unknown one", () => {
    const { attributes, warnings } = parse({ finishes: ["Gloss", "Holographic"] });

    expect(attributes.finishes).toEqual(["gloss"]);
    expect(warnings.some((w) => w.includes("Holographic"))).toBe(true);
  });

  it("stays quiet for a fully populated product", () => {
    const { warnings } = parse({
      shape: "Almond",
      style: "Chrome",
      colours: ["Pink"],
      finishes: ["Gloss"],
    });

    expect(warnings).toEqual([]);
  });

  it("does not warn about a missing finish", () => {
    // Only 15 of 40 products carry one. Warning on the other 25 would bury the
    // signal that actually matters — a shape that failed to parse.
    const { warnings } = parse({ shape: "Almond" });

    expect(warnings).toEqual([]);
  });
});

describe("the few remaining defaults are chosen to be un-misleading", () => {
  it("defaults a nail set's occasion to everyday", () => {
    // Occasion is not stored anywhere on the store. Unlike shape or finish,
    // "everyday" makes no specific claim a customer could be misled by — it only
    // affects which queries surface the product. Still a default, but an honest one.
    expect(parse({ shape: "Almond" }).attributes.occasions).toEqual(["everyday"]);
  });

  it("does NOT default to beginner-friendly", () => {
    // Claiming a set is easy to apply when it is not produces a bad first
    // experience and a return. Claiming nothing merely means it does not surface
    // for "I'm new to this" — a much cheaper error.
    expect(parse({ shape: "Almond" }).attributes.suitableFor).not.toContain("beginner");
  });

  it("gives an accessory no occasion and no experience level at all", () => {
    // A nail file has no occasion. Handing it "everyday" let it score points on
    // "what's good for every day?" — a fabricated attribute doing exactly the
    // damage fabricated attributes do.
    const { attributes } = parse({});

    expect(attributes.kind).toBe("accessory");
    expect(attributes.occasions).toEqual([]);
    expect(attributes.suitableFor).toEqual([]);
  });
});

describe("classifying nail sets against accessories", () => {
  it("treats a product with no nail attributes as an accessory", () => {
    // Nail Remover, Glass Nail File and two glues on the live catalogue.
    expect(parse({}).attributes.kind).toBe("accessory");
  });

  it("treats a shape-less product that has a colour as a nail set", () => {
    // "Snowflake Wishes" — the one genuine merchandising gap. It must NOT be
    // demoted to an accessory just because its shape metafield is unset, or it
    // disappears from every nail query.
    const { attributes } = parse({ colours: ["White"] });

    expect(attributes.kind).toBe("nail-set");
    expect(attributes.shape).toBeNull();
  });

  it("treats any single nail attribute as sufficient evidence", () => {
    expect(parse({ shape: "Almond" }).attributes.kind).toBe("nail-set");
    expect(parse({ style: "Chrome" }).attributes.kind).toBe("nail-set");
    expect(parse({ finishes: ["Gloss"] }).attributes.kind).toBe("nail-set");
  });
});

describe("productEmbeddingText", () => {
  const attributes = parse({
    shape: "Short Almond",
    style: "Chrome",
    colours: ["Pink", "Floral"],
    finishes: ["Matte"],
  }).attributes;

  const text = productEmbeddingText({
    title: "Autumn Almond",
    description: "A warm, muted set for everyday wear.",
    productType: "Press-on Nails",
    attributes,
  });

  it("includes descriptive attributes", () => {
    expect(text).toContain("Autumn Almond");
    expect(text).toContain("Shape: almond");
    expect(text).toContain("Length: short");
    expect(text).toContain("Style: Chrome");
  });

  it("separates patterns from colours", () => {
    // shopify.color-pattern is one taxonomy field covering both, so "Floral"
    // arrives alongside "Pink". Both help retrieval; only one is a colour.
    expect(text).toContain("Colours: Pink");
    expect(text).toContain("Pattern: Floral");
  });

  it("omits unknown attributes instead of guessing", () => {
    const sparse = productEmbeddingText({
      title: "Mystery Set",
      description: "",
      productType: "Press-on Nails",
      attributes: parse({}).attributes,
    });

    expect(sparse).not.toContain("Shape:");
    expect(sparse).not.toContain("Finish:");
  });

  it("contains NO price and NO inventory", () => {
    // The two-plane rule at the ingestion boundary. A vector must never encode a
    // fact that can change without the document changing.
    expect(text).not.toMatch(/\$|price|USD|\d+\.\d{2}/i);
    expect(text).not.toMatch(/stock|inventory|available|quantity/i);
  });
});

describe("tags carry what no metafield does", () => {
  it("promotes a Bridal tag into a real occasion", () => {
    // THE FIX. Occasion was fabricated as "everyday" for every nail set because
    // nothing in the store recorded it, so "nails for a wedding" could not filter.
    const { attributes } = parse({ shape: "Almond", tags: ["Bridal"] });

    expect(attributes.occasions).toEqual(["bridal"]);
  });

  it("accepts the words a merchandiser actually types", () => {
    expect(parse({ shape: "Almond", tags: ["Wedding"] }).attributes.occasions).toEqual(["bridal"]);
    expect(parse({ shape: "Almond", tags: ["NYE"] }).attributes.occasions).toEqual(["party"]);
    expect(parse({ shape: "Almond", tags: ["Office"] }).attributes.occasions).toEqual([
      "professional",
    ]);
  });

  it("keeps a non-occasion tag as free text instead of forcing it into the enum", () => {
    // "Summer" is a season, not an occasion. Mapping it onto `holiday` because
    // both feel seasonal would invent a claim the merchandiser never made — and
    // the model states these to customers as fact.
    const { attributes } = parse({ shape: "Almond", tags: ["Summer", "Bestseller"] });

    expect(attributes.tags).toEqual(["Summer", "Bestseller"]);
    expect(attributes.occasions).toEqual(["everyday"]);
  });

  it("falls back to the honest default when no tag is an occasion", () => {
    expect(parse({ shape: "Almond", tags: ["Bestseller"] }).attributes.occasions).toEqual([
      "everyday",
    ]);
  });

  it("collects several occasions without duplicating", () => {
    const { attributes } = parse({ shape: "Almond", tags: ["Bridal", "Wedding", "Party"] });

    expect(attributes.occasions).toEqual(["bridal", "party"]);
  });

  it("still gives an accessory no occasion, however it is tagged", () => {
    // A nail file tagged "Bridal" is still a nail file.
    expect(parse({ tags: ["Bridal"] }).attributes.occasions).toEqual([]);
  });

  it("puts tags in the embedded text so search can reach them", () => {
    const attributes = parse({ shape: "Almond", tags: ["Summer", "Bridal"] }).attributes;
    const text = productEmbeddingText({
      title: "Azure",
      description: "",
      productType: "",
      attributes,
    });

    // Without this a customer searching "summer nails" cannot reach a product
    // tagged Summer — no metafield covers seasons.
    expect(text).toContain("Summer");
  });
});
