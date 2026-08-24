import { describe, expect, it } from "vitest";
import { inboundTextForTest } from "./inbound.js";

describe("inbound email reply extraction", () => {
  it("keeps only the new customer text above our delimiter", () => {
    expect(inboundTextForTest("Here is the photo you requested.\n\n--- Reply above this line ---\nOld reply"))
      .toBe("Here is the photo you requested.");
  });

  it("strips a common quoted reply block", () => {
    expect(inboundTextForTest("Yes, that works.\n\nOn Aug 23, Nailzify wrote:\n> old"))
      .toBe("Yes, that works.");
  });
});
