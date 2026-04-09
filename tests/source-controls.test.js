"use strict";

const {
  applySourceOverrides,
  getItemLimit,
  getPageLimit,
  isItemLimitReached,
  limitRecords,
  parsePositiveInt,
  takeRemaining,
} = require("../lib/source-controls");

describe("source-controls", () => {
  test("parsePositiveInt accepts positive integers", () => {
    expect(parsePositiveInt("3")).toBe(3);
    expect(parsePositiveInt(5.9)).toBe(5);
  });

  test("parsePositiveInt rejects invalid values", () => {
    expect(() => parsePositiveInt(0)).toThrow(/positive integer/i);
    expect(() => parsePositiveInt("abc")).toThrow(/positive integer/i);
  });

  test("page and item limits fall back correctly", () => {
    expect(getPageLimit({}, 4)).toBe(4);
    expect(getItemLimit({})).toBeNull();
    expect(getItemLimit({ itemLimit: 7 })).toBe(7);
  });

  test("takeRemaining and limitRecords cap lists", () => {
    expect(takeRemaining([1, 2, 3], 1, 2)).toEqual([1]);
    expect(limitRecords([1, 2, 3], 2)).toEqual([1, 2]);
    expect(limitRecords([1, 2, 3], null)).toEqual([1, 2, 3]);
  });

  test("isItemLimitReached reports limit state", () => {
    expect(isItemLimitReached(2, 2)).toBe(true);
    expect(isItemLimitReached(1, 2)).toBe(false);
    expect(isItemLimitReached(10, null)).toBe(false);
  });

  test("applySourceOverrides merges parsed overrides", () => {
    const result = applySourceOverrides(
      { id: "prisjakt", pageLimit: 2 },
      { pageLimit: 1, itemLimit: 5, dryRun: true },
    );

    expect(result).toMatchObject({
      id: "prisjakt",
      pageLimit: 1,
      itemLimit: 5,
      dryRun: true,
    });
  });
});
