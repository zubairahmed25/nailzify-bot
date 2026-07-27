import { describe, expect, it } from "vitest";
import { MessageId } from "../shared/brand.js";
import type { Message } from "./message.js";
import { buildWindow, messagesToSummarize, needsResummarize } from "./window.js";

function msg(n: number, content = `message ${n}`): Message {
  return {
    id: MessageId(`m${n}`),
    role: n % 2 === 0 ? "assistant" : "user",
    content,
    createdAt: 1_700_000_000_000 + n * 1000,
  };
}

describe("buildWindow", () => {
  it("keeps everything in a short conversation", () => {
    const history = [msg(1), msg(2), msg(3)];
    const window = buildWindow(history, null);

    expect(window.messages).toHaveLength(3);
    expect(window.droppedCount).toBe(0);
  });

  it("keeps the most recent messages when history exceeds the limit", () => {
    // Cost control: without this, turn 20 re-pays for turns 1-19 and per-
    // conversation cost grows quadratically.
    const history = Array.from({ length: 25 }, (_, i) => msg(i + 1));
    const window = buildWindow(history, null, {
      maxVerbatimMessages: 10,
      maxEstimatedTokens: 100_000,
    });

    expect(window.messages).toHaveLength(10);
    expect(window.droppedCount).toBe(15);
    expect(window.messages[0]!.id).toBe(MessageId("m16"));
    expect(window.messages.at(-1)!.id).toBe(MessageId("m25"));
  });

  it("trims from the oldest end when a few long messages blow the token budget", () => {
    const history = [
      msg(1, "x".repeat(20_000)),
      msg(2, "y".repeat(20_000)),
      msg(3, "short"),
    ];

    const window = buildWindow(history, null, {
      maxVerbatimMessages: 10,
      maxEstimatedTokens: 2_000,
    });

    expect(window.messages.at(-1)!.id).toBe(MessageId("m3"));
    expect(window.droppedCount).toBeGreaterThan(0);
  });

  it("never drops the newest message, even if it alone exceeds the budget", () => {
    // Answering the wrong question to save tokens is not a trade worth making.
    const history = [msg(1, "short"), msg(2, "z".repeat(100_000))];

    const window = buildWindow(history, null, {
      maxVerbatimMessages: 10,
      maxEstimatedTokens: 100,
    });

    expect(window.messages).toHaveLength(1);
    expect(window.messages[0]!.id).toBe(MessageId("m2"));
  });

  it("handles an empty conversation", () => {
    const window = buildWindow([], null);
    expect(window.messages).toEqual([]);
    expect(window.estimatedTokens).toBe(0);
  });

  it("counts the rolling summary against the token budget", () => {
    const history = [msg(1)];
    const withoutSummary = buildWindow(history, null);
    const withSummary = buildWindow(history, "A long prior summary ".repeat(50));

    expect(withSummary.estimatedTokens).toBeGreaterThan(withoutSummary.estimatedTokens);
  });

  it("carries the existing summary through untouched", () => {
    const window = buildWindow([msg(1)], "prior context");
    expect(window.summary).toBe("prior context");
  });
});

describe("summarization triggers", () => {
  it("does not resummarize until enough messages have fallen out", () => {
    // Summarizing costs an LLM call, so batch it rather than doing it per turn.
    const history = Array.from({ length: 13 }, (_, i) => msg(i + 1));
    const window = buildWindow(history, null, {
      maxVerbatimMessages: 10,
      maxEstimatedTokens: 100_000,
    });

    expect(window.droppedCount).toBe(3);
    expect(needsResummarize(window, 6)).toBe(false);
  });

  it("triggers once the threshold is crossed", () => {
    const history = Array.from({ length: 20 }, (_, i) => msg(i + 1));
    const window = buildWindow(history, null, {
      maxVerbatimMessages: 10,
      maxEstimatedTokens: 100_000,
    });

    expect(needsResummarize(window, 6)).toBe(true);
  });

  it("selects exactly the dropped messages for summarization", () => {
    const history = Array.from({ length: 15 }, (_, i) => msg(i + 1));
    const window = buildWindow(history, null, {
      maxVerbatimMessages: 10,
      maxEstimatedTokens: 100_000,
    });

    const toSummarize = messagesToSummarize(history, window);

    expect(toSummarize).toHaveLength(5);
    expect(toSummarize.at(-1)!.id).toBe(MessageId("m5"));
    // No overlap with what stays verbatim — otherwise the model sees duplicates.
    expect(toSummarize.at(-1)!.id).not.toBe(window.messages[0]!.id);
  });
});
