import { describe, expect, it } from "vitest";
import { splitAtOrderPanel } from "./order-timeline.js";

describe("order timeline", () => {
  it("keeps messages sent after the order panel below it", () => {
    const initialMessages = ["track my order"];
    const orderPanelIndex = initialMessages.length;

    const timeline = splitAtOrderPanel(
      [...initialMessages, "what does fulfilled mean?", "It means your order has shipped."],
      orderPanelIndex,
    );

    expect(timeline.before).toEqual(["track my order"]);
    expect(timeline.after).toEqual([
      "what does fulfilled mean?",
      "It means your order has shipped.",
    ]);
  });

  it("puts all messages before the panel when no order panel is open", () => {
    const timeline = splitAtOrderPanel(["hello", "hi"], null);

    expect(timeline.before).toEqual(["hello", "hi"]);
    expect(timeline.after).toEqual([]);
  });
});
