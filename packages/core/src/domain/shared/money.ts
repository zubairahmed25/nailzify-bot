/**
 * Money.
 *
 * WHY NOT `number`: floating-point arithmetic on currency is a classic
 * correctness bug. `0.1 + 0.2 === 0.30000000000000004` in every IEEE-754
 * language, JavaScript included. Store MINOR UNITS (cents) as an integer and the
 * problem disappears.
 *
 * WHY A CURRENCY FIELD: an amount without a currency is meaningless, and Nailzify
 * may sell internationally. Pairing them makes "add USD to GBP" a runtime error
 * we can actually catch, instead of a silently wrong total.
 *
 * NOTE ON THE ARCHITECTURE: every `Money` in this system originates from a live
 * Shopify response in the current request. There is deliberately no path that
 * constructs one from a cached or embedded value — see `ProductCandidate` in
 * ../catalog/product.ts.
 */

import { assertNever } from "./result.js";

export type CurrencyCode = "USD" | "GBP" | "EUR" | "CAD" | "AUD";

export interface Money {
  /** Integer minor units. 1899 = $18.99. Never fractional. */
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

export function money(amountMinor: number, currency: CurrencyCode): Money {
  if (!Number.isInteger(amountMinor)) {
    throw new TypeError(
      `Money must be integer minor units, received ${amountMinor}. ` +
        `Use fromDecimalString() to parse "18.99".`,
    );
  }
  return { amountMinor, currency };
}

/**
 * Parse the decimal string shape Shopify's API returns (`"18.99"`).
 *
 * Deliberately string-based rather than `parseFloat` — going through a float,
 * even briefly, reintroduces exactly the rounding error we're avoiding.
 */
export function fromDecimalString(value: string, currency: CurrencyCode): Money {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new TypeError(`Cannot parse "${value}" as a monetary amount`);

  const [, sign, whole, frac = "0"] = match;
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return money(sign === "-" ? -minor : minor, currency);
}

/** Format for display. Falls back gracefully if the runtime lacks the locale. */
export function formatMoney(m: Money, locale = "en-US"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: m.currency,
  }).format(m.amountMinor / 100);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`Cannot combine ${a.currency} with ${b.currency}`);
  }
}

export const addMoney = (a: Money, b: Money): Money => {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
};

export const compareMoney = (a: Money, b: Money): number => {
  assertSameCurrency(a, b);
  return a.amountMinor - b.amountMinor;
};

export const isAtMost = (m: Money, limit: Money): boolean => compareMoney(m, limit) <= 0;

// ---------------------------------------------------------------------------
// Price bands
// ---------------------------------------------------------------------------

/**
 * A coarse price bucket, stored as vector metadata so "under $20" can pre-filter
 * candidates before search runs (docs/03-ingestion.md §3.8).
 *
 * WHY A BAND AND NOT THE PRICE: a band is stable across ordinary price movement
 * in a way an exact figure is not. If a sale moves a product across a boundary,
 * the nightly sync corrects it and the worst case is a slightly imperfect
 * candidate list — never a wrong price shown to a customer, because the exact
 * price still comes from the live hydration call.
 */
export type PriceBand = "under-15" | "15-25" | "25-plus";

export function priceBandOf(m: Money): PriceBand {
  if (m.amountMinor < 1500) return "under-15";
  if (m.amountMinor < 2500) return "15-25";
  return "25-plus";
}

/** Which bands could contain a product at or below `maxPrice`. */
export function bandsAtOrBelow(maxPrice: Money): readonly PriceBand[] {
  const band = priceBandOf(maxPrice);
  switch (band) {
    case "under-15":
      return ["under-15"];
    case "15-25":
      return ["under-15", "15-25"];
    case "25-plus":
      return ["under-15", "15-25", "25-plus"];
    default:
      return assertNever(band, "PriceBand");
  }
}
