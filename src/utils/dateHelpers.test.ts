import { describe, expect, it } from "vitest";
import { jsDayToIsoDay } from "./dateHelpers";

describe("jsDayToIsoDay", () => {
  it.each([
    [0, 7], // Sunday
    [1, 1], // Monday
    [2, 2], // Tuesday
    [3, 3], // Wednesday
    [4, 4], // Thursday
    [5, 5], // Friday
    [6, 6], // Saturday
  ])("maps JS day %i to ISO day %i", (jsDay, isoDay) => {
    expect(jsDayToIsoDay(jsDay)).toBe(isoDay);
  });

  it("matches a real Date.getDay() call for a known date", () => {
    // 2026-07-20 is a Monday: JS getDay() -> 1, ISO day-of-week -> 1.
    const monday = new Date("2026-07-20T12:00:00Z");
    expect(jsDayToIsoDay(monday.getDay())).toBe(1);
  });

  it.each([-1, 7, 100])("throws a RangeError for out-of-range input %i", (invalidDay) => {
    expect(() => jsDayToIsoDay(invalidDay)).toThrow(RangeError);
  });

  it.each([1.5, NaN])("throws a RangeError for non-integer input %s", (invalidDay) => {
    expect(() => jsDayToIsoDay(invalidDay)).toThrow(RangeError);
  });
});
