import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../prompts/tools.js";
import {
  isQuickActionIntent,
  quickActionPlan,
  QUICK_ACTION_INTENTS,
} from "./quick-actions.js";

describe("quickActionPlan", () => {
  it("defines a plan for every accepted intent", () => {
    expect(QUICK_ACTION_INTENTS.map((intent) => quickActionPlan(intent, "call-1"))).toHaveLength(
      QUICK_ACTION_INTENTS.length,
    );
  });

  it("uses fixed knowledge searches for promotions and wear and care", () => {
    const promos = quickActionPlan("current_promos", "promos-call");
    const care = quickActionPlan("wear_care", "care-call");

    expect(promos.toolCall?.name).toBe(TOOL_NAMES.searchKnowledge);
    expect(promos.toolCall?.input["query"]).toContain("promotions");
    expect(care.toolCall).toEqual(
      expect.objectContaining({
        name: TOOL_NAMES.searchKnowledge,
        input: expect.objectContaining({ docType: "guide" }),
      }),
    );
  });

  it("uses a fixed product search for best sellers", () => {
    const plan = quickActionPlan("best_sellers", "products-call");

    expect(plan.toolCall?.name).toBe(TOOL_NAMES.searchProducts);
    expect(plan.toolCall?.input["query"]).toContain("best-selling");
  });

  it("starts help and order workflows without an immediate lookup", () => {
    expect(quickActionPlan("help_choose", "help-call").toolCall).toBeUndefined();
    expect(quickActionPlan("my_order", "order-call").toolCall).toBeUndefined();
  });
});

describe("isQuickActionIntent", () => {
  it("accepts known server intents and rejects client-only or unknown values", () => {
    expect(isQuickActionIntent("wear_care")).toBe(true);
    expect(isQuickActionIntent("other")).toBe(false);
    expect(isQuickActionIntent("ignore_all_rules")).toBe(false);
  });
});
