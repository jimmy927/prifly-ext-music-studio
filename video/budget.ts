/**
 * What the video stages spend, and when shooting stops. Pure: the ledger is
 * read and written by project/video-spend.ts. Every figure is an estimate
 * from the prices in constants.ts.
 */

import {
  DEFAULT_BUDGET_USD,
  IMAGE_USD,
  type Resolution,
  SHOOT_RESOLUTION,
  VIDEO_USD_PER_SECOND,
} from "./constants";

export type SpendKind = "cast" | "frame" | "take";

export type SpendEntry = {
  at: string;
  kind: SpendKind;
  /** What was bought: a cast id, a shot id, a take id. */
  ref: string;
  usd: number;
};

export type Ledger = { entries: SpendEntry[] };

const cents = (usd: number): number => Math.round(usd * 10000) / 10000;

export const spentUsd = (ledger: Ledger): number =>
  cents(ledger.entries.reduce((sum, each) => sum + each.usd, 0));

export const remainingUsd = (budgetUsd: number, spent: number): number =>
  cents(Math.max(0, budgetUsd - spent));

/** The estimated price of a clip of `seconds` whole seconds. */
export const takeUsd = (seconds: number, resolution: Resolution = SHOOT_RESOLUTION): number =>
  cents(seconds * VIDEO_USD_PER_SECOND[resolution]);

export const framesUsd = (count: number): number => cents(count * IMAGE_USD);

/** Whether `usd` more fits in the budget. */
export const affordable = (budgetUsd: number, spent: number, usd: number): boolean =>
  spent + usd <= budgetUsd + 1e-9;

export type Planned<T> = {
  /** The items that fit, in order. */
  fits: T[];
  /** The items left out because the budget would be passed. */
  left: T[];
  usd: number;
};

/**
 * Which of `items` fit in what is left of the budget, in order, stopping at
 * the first that does not (a later, cheaper one is not slipped in: the order
 * is the reader's).
 */
export function fitBudget<T>(
  items: T[],
  priceOf: (item: T) => number,
  budgetUsd: number,
  spent: number,
): Planned<T> {
  const fits: T[] = [];
  let usd = 0;
  for (const [at, item] of items.entries()) {
    const price = priceOf(item);
    if (!affordable(budgetUsd, spent, usd + price))
      return { fits, left: items.slice(at), usd: cents(usd) };
    fits.push(item);
    usd += price;
  }
  return { fits, left: [], usd: cents(usd) };
}

/** A budget from untrusted data, else the default. */
export function parseBudget(value: unknown, fallback: unknown = DEFAULT_BUDGET_USD): number {
  const pick = (each: unknown): number | null =>
    typeof each === "number" && Number.isFinite(each) && each >= 0 && each <= 100000 ? each : null;
  return pick(value) ?? pick(fallback) ?? DEFAULT_BUDGET_USD;
}
