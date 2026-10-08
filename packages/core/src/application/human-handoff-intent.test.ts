import { describe, expect, it } from "vitest";
import { humanHandoffPlan } from "./human-handoff-intent.js";

describe("humanHandoffPlan", () => {
  it.each([
    "I want to speak with a real person.",
    "Can I talk to a human agent?",
    "Please connect me to your support team.",
    "I need human help, but I do not want my chat transcript shared.",
  ])("routes an explicit request for human help: %s", (text) => {
    expect(humanHandoffPlan(text, "handoff-1")?.toolCall).toMatchObject({
      name: "escalate_to_human",
      input: { reason: "Customer requested human help" },
    });
  });

  it("does not mistake a support policy question for a handoff request", () => {
    expect(humanHandoffPlan("What is your customer support policy?", "handoff-1")).toBeNull();
  });
});
