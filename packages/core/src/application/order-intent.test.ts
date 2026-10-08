import { describe, expect, it } from "vitest";
import { classifyOrderIntent } from "./order-intent.js";

describe("classifyOrderIntent", () => {
  it.each([
    "Where is my order?",
    "Has my package shipped yet?",
    "Can you show my orders",
    "What did I purchase?",
    "Track order",
  ])("routes a live read for %s", (text) => {
    expect(classifyOrderIntent(text)).toBe("lookup");
  });

  it("routes the order quick action without reading its label", () => {
    expect(classifyOrderIntent("anything", "my_order")).toBe("lookup");
  });

  it.each([
    "Cancel my order",
    "I need a refund for this purchase",
    "Change the shipping address on my order",
    "My package has a missing item",
  ])("keeps a mutation or problem in support for %s", (text) => {
    expect(classifyOrderIntent(text)).toBe("support");
  });

  it.each([
    "What is your shipping policy?",
    "How long does delivery usually take?",
    "Can I return an order?",
    "Which nail shape should I choose?",
  ])("does not treat a policy or catalog question as a private lookup for %s", (text) => {
    expect(classifyOrderIntent(text)).toBe("none");
  });
});
