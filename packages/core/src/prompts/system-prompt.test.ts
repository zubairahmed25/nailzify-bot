import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import { TOOL_NAMES, TOOLS } from "./tools.js";

describe("production grounding instructions", () => {
  it("forbids store wide absence claims from incomplete search evidence", () => {
    expect(SYSTEM_PROMPT).toContain("does not prove that the store does not offer it");
  });

  it("requires explicit evidence for opened or used return eligibility", () => {
    expect(SYSTEM_PROMPT).toContain("does not establish whether opened or used products qualify");
  });

  it("keeps collection sizing rules separate and requires physical measurements", () => {
    expect(SYSTEM_PROMPT).toContain("Do not combine sizing rules from different collection types");
    expect(SYSTEM_PROMPT).toContain("Do not recommend a phone measurement app");
  });

  it("describes handoff as a form that has not created a ticket yet", () => {
    expect(SYSTEM_PROMPT).toContain("A handoff signal does not create a ticket");
    expect(SYSTEM_PROMPT).toContain("Sharing the transcript is optional");

    const handoff = TOOLS.find((tool) => tool.name === TOOL_NAMES.escalate);
    expect(handoff?.description).toContain("No ticket exists until the customer submits the form");
    expect(handoff?.description).toContain("declines to share the transcript");
  });
});
