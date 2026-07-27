import { describe, expect, it } from "vitest";
import {
  addMoney,
  bandsAtOrBelow,
  fromDecimalString,
  isAtMost,
  money,
  priceBandOf,
} from "./money.js";

describe("money avoids floating-point error", () => {
  it("adds cents exactly where floats would not", () => {
    // The canonical demonstration: 0.1 + 0.2 !== 0.3 in IEEE-754.
    expect(0.1 + 0.2).not.toBe(0.3);

    const sum = addMoney(money(10, "USD"), money(20, "USD"));
    expect(sum.amountMinor).toBe(30);
  });

  it("rejects fractional minor units", () => {
    expect(() => money(18.5, "USD")).toThrow(TypeError);
  });

  it("refuses to combine different currencies", () => {
    expect(() => addMoney(money(100, "USD"), money(100, "GBP"))).toThrow(TypeError);
  });
});

describe("fromDecimalString", () => {
  it("parses the shape Shopify returns", () => {
    expect(fromDecimalString("18.99", "USD").amountMinor).toBe(1899);
    expect(fromDecimalString("18.9", "USD").amountMinor).toBe(1890);
    expect(fromDecimalString("18", "USD").amountMinor).toBe(1800);
  });

  it("parses without going through a float", () => {
    // parseFloat("0.29") * 100 gives 28.999999999999996 — this must not.
    expect(fromDecimalString("0.29", "USD").amountMinor).toBe(29);
    expect(fromDecimalString("1.10", "USD").amountMinor).toBe(110);
  });

  it("handles negatives for refunds and adjustments", () => {
    expect(fromDecimalString("-5.00", "USD").amountMinor).toBe(-500);
  });

  it("rejects malformed input rather than coercing it", () => {
    expect(() => fromDecimalString("abc", "USD")).toThrow(TypeError);
    expect(() => fromDecimalString("18.999", "USD")).toThrow(TypeError);
    expect(() => fromDecimalString("", "USD")).toThrow(TypeError);
  });
});

describe("comparison", () => {
  it("compares within a budget", () => {
    expect(isAtMost(money(1500, "USD"), money(2000, "USD"))).toBe(true);
    expect(isAtMost(money(2000, "USD"), money(2000, "USD"))).toBe(true);
    expect(isAtMost(money(2500, "USD"), money(2000, "USD"))).toBe(false);
  });
});

describe("price bands", () => {
  it("buckets by amount", () => {
    expect(priceBandOf(money(999, "USD"))).toBe("under-15");
    expect(priceBandOf(money(1500, "USD"))).toBe("15-25");
    expect(priceBandOf(money(2500, "USD"))).toBe("25-plus");
  });

  it("expands a budget into every band that could satisfy it", () => {
    // Used as a vector-search pre-filter. Must be inclusive of cheaper bands, or
    // "under $20" would silently exclude a $12 product.
    expect(bandsAtOrBelow(money(2000, "USD"))).toEqual(["under-15", "15-25"]);
    expect(bandsAtOrBelow(money(1000, "USD"))).toEqual(["under-15"]);
    expect(bandsAtOrBelow(money(9999, "USD"))).toEqual(["under-15", "15-25", "25-plus"]);
  });
});
