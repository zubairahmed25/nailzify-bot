import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { makeReplyToken, verifyReplyToken } from "./reply-token.js";

describe("opaque ticket reply token", () => {
  it("fits a real ticket reply address within the email local-part limit", () => {
    const id = "TKT-MTV4F5S9-312938";
    const token = makeReplyToken(id, "secret");
    expect(Buffer.byteLength(`reply+${token}`)).toBeLessThanOrEqual(64);
    expect(verifyReplyToken(token, "secret")).toBe(id);
  });

  it("still accepts previously issued full-length tokens without accepting truncated signatures", () => {
    const encoded = Buffer.from("TKT-MTV4F5S9-312938").toString("base64url");
    const signature = createHmac("sha256", "secret").update(`ticket-reply:${encoded}`).digest("base64url");
    expect(verifyReplyToken(`${encoded}.${signature}`, "secret")).toBe("TKT-MTV4F5S9-312938");
    expect(verifyReplyToken(`${encoded}.${signature.slice(0, 22)}`, "secret")).toBeNull();
  });

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
