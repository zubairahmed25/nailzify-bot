import { describe, expect, it } from "vitest";
import { InfrastructureError } from "./errors.js";

describe("wrapped causes survive Lambda serialization", () => {
  class TestFailure extends InfrastructureError {
    readonly code = "TEST_FAILURE";
    readonly retryable = true;
  }

  /** What AWS Lambda actually emits: own ENUMERABLE properties only. */
  const serializeLikeLambda = (error: Error): Record<string, unknown> => ({
    errorType: error.name,
    errorMessage: error.message,
    ...Object.fromEntries(Object.entries(error)),
  });

  it("puts the cause in the message, not only in the non-enumerable field", () => {
    // ⚠️ THE PRODUCTION BUG. `cause` was passed to super() correctly and was
    // still invisible in CloudWatch, because Lambda does not serialize a
    // non-enumerable property. The log read:
    //     {"errorType":"$d","errorMessage":"Pinecone upsert failed"}
    // from a minified bundle where even the class name is mangled.
    const error = new TestFailure("Pinecone upsert failed", {
      cause: new Error("metadata value must be a string, number, boolean or list of strings"),
    });

    const serialized = serializeLikeLambda(error);

    expect(String(serialized["errorMessage"])).toContain("Pinecone upsert failed");
    expect(String(serialized["errorMessage"])).toContain("must be a string, number, boolean");
  });

  it("still preserves the original error object for in-process handling", () => {
    const original = new Error("underlying");
    const error = new TestFailure("wrapper", { cause: original });

    expect(error.cause).toBe(original);
  });

  it("exposes the cause as an enumerable field for structured queries", () => {
    const error = new TestFailure("wrapper", { cause: new Error("underlying") });

    expect(serializeLikeLambda(error)["causeMessage"]).toBe("underlying");
  });

  it("leaves the message alone when there is no cause", () => {
    expect(new TestFailure("standalone").message).toBe("standalone");
    expect(new TestFailure("standalone").causeMessage).toBeNull();
  });

  it("does not repeat a cause the message already quotes", () => {
    const error = new TestFailure('Failed: already quoted', { cause: new Error("already quoted") });

    expect(error.message).toBe("Failed: already quoted");
  });

  it("truncates a huge cause rather than flooding the log", () => {
    // A GraphQL validation error can run to kilobytes. One log line should not.
    const error = new TestFailure("wrapper", { cause: new Error("x".repeat(5000)) });

    expect(error.message.length).toBeLessThan(400);
    expect(error.message).toContain("truncated");
  });

  it("handles a non-Error cause", () => {
    // Fetch and some SDKs reject with strings or plain objects.
    expect(new TestFailure("wrapper", { cause: "plain string" }).message).toContain("plain string");
  });
});
