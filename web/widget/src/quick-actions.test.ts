import { describe, expect, it } from "vitest";
import { OTHER_PROMPT, QUICK_ACTIONS } from "./quick-actions.js";

describe("quick action definitions", () => {
  it("gives every pill a unique stable intent", () => {
    const intents = QUICK_ACTIONS.map((action) => action.intent);

    expect(new Set(intents).size).toBe(QUICK_ACTIONS.length);
    expect(intents).toEqual([
      "help_choose",
      "current_promos",
      "wear_care",
      "my_order",
      "best_sellers",
      "other",
    ]);
  });

  it("uses the approved assistant question for Other", () => {
    expect(OTHER_PROMPT).toBe("What else can I help you with today?");
  });
});
