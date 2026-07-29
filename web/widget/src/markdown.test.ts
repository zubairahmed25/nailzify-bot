import { describe, expect, it } from "vitest";
import { parseMarkdown, type Block, type Inline } from "./markdown.js";

const spans = (blocks: readonly Block[]): readonly Inline[] =>
  blocks.flatMap((b) => (b.kind === "paragraph" ? b.spans : b.items.flat()));

const kinds = (source: string) => spans(parseMarkdown(source)).map((s) => s.kind);
const text = (source: string) =>
  spans(parseMarkdown(source))
    .map((s) => s.value)
    .join("");

// ---------------------------------------------------------------------------
// Security. This renders text a language model wrote after reading retrieved
// documents and Shopify product descriptions, on a merchant's live storefront.
// ---------------------------------------------------------------------------

describe("link scheme allowlist", () => {
  it("rejects javascript: URLs", () => {
    const source = "[click me](javascript:alert(1))";
    const blocks = parseMarkdown(source);

    // No link span survives, and no javascript: string reaches the tree.
    expect(kinds(source)).not.toContain("link");
    expect(JSON.stringify(blocks)).not.toContain("javascript:");
    // The link TEXT survives — dropping it would silently delete part of an
    // answer. The stray ")" is an artifact of the href pattern stopping at the
    // first close paren; cosmetic, and preferable to a regex that tries to
    // balance parentheses inside a URL.
    expect(text(source)).toBe("click me)");
  });

  it("rejects data: URLs", () => {
    expect(kinds("[x](data:text/html;base64,PHNjcmlwdD4=)")).toEqual(["text"]);
  });

  it("rejects protocol-relative URLs", () => {
    // `//evil.com` inherits the page scheme. On a storefront the customer sees a
    // link that appears to be on nailzify.com — a real phishing vector.
    expect(kinds("[deals](//evil.example)")).toEqual(["text"]);
  });

  it("rejects plain http", () => {
    expect(kinds("[x](http://nailzify.com)")).toEqual(["text"]);
  });

  it("allows https", () => {
    const [span] = spans(parseMarkdown("[size guide](https://nailzify.com/pages/size-guide)"));

    expect(span?.kind).toBe("link");
    if (span?.kind === "link") expect(span.href).toBe("https://nailzify.com/pages/size-guide");
  });
});

describe("raw HTML is never markup", () => {
  it("keeps a script tag as literal text", () => {
    // The parser returns a TREE and React renders it as elements, so a text node
    // is escaped by React. There is no path from model output to markup.
    const source = "<script>alert(1)</script>";

    expect(kinds(source)).toEqual(["text"]);
    expect(text(source)).toBe(source);
  });

  it("keeps an img onerror payload as literal text", () => {
    const source = '<img src=x onerror="alert(1)">';
    expect(text(source)).toBe(source);
  });
});

// ---------------------------------------------------------------------------

describe("formatting", () => {
  it("parses bold, italic and code", () => {
    expect(kinds("**a** *b* `c`")).toEqual(["strong", "text", "em", "text", "code"]);
  });

  it("parses bullet and numbered lists", () => {
    const bullets = parseMarkdown("- one\n- two");
    const first = bullets[0];
    expect(first?.kind).toBe("list");
    if (first?.kind === "list") expect(first.items).toHaveLength(2);

    const numbered = parseMarkdown("1. one\n2. two");
    expect(numbered[0]!.kind).toBe("list");
  });

  it("flattens headings to bold rather than storefront display type", () => {
    // A model writing "## Returns" inside a chat bubble must not produce an h2,
    // which would inherit the merchant's theme typography.
    const blocks = parseMarkdown("## Returns");

    expect(blocks[0]!.kind).toBe("paragraph");
    expect(kinds("## Returns")).toEqual(["strong"]);
  });

  it("keeps a partial bold marker readable mid-stream", () => {
    // Tokens arrive one at a time, so the parser sees "**Ret" long before it
    // sees the closing marker. Rendering an asterisk is fine; crashing is not.
    expect(() => parseMarkdown("**Ret")).not.toThrow();
    expect(text("**Ret")).toBe("**Ret");
  });

  it("handles empty and whitespace-only input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("   \n\n  ")).toEqual([]);
  });

  it("preserves text around inline markers", () => {
    expect(text("Sets cost **$13.99** each.")).toBe("Sets cost $13.99 each.");
  });
});
