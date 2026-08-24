import { describe, expect, it } from "vitest";
import { makeReplyToken, verifyReplyToken } from "./reply-token.js";

describe("opaque ticket reply token", () => {
  it("round trips a ticket id only with the signing secret", () => {
    const token = makeReplyToken("TKT-ABC-123", "secret");
    expect(verifyReplyToken(token, "secret")).toBe("TKT-ABC-123");
    expect(verifyReplyToken(token, "wrong")).toBeNull();
  });

  it("rejects modification", () => {
    const token = makeReplyToken("TKT-ABC-123", "secret");
    expect(verifyReplyToken(`${token}x`, "secret")).toBeNull();
  });
});
