import { describe, expect, it } from "vitest";
import { isoDayToSocrataDow } from "./isoDayToSocrataDow";

describe("isoDayToSocrataDow", () => {
  it.each([
    [1, 1], // Monday
    [2, 2], // Tuesday
    [3, 3], // Wednesday
    [4, 4], // Thursday
    [5, 5], // Friday
    [6, 6], // Saturday
    [7, 0], // Sunday
  ])("maps ISO day %i to Socrata date_extract_dow %i", (isoDay, socrataDow) => {
    expect(isoDayToSocrataDow(isoDay)).toBe(socrataDow);
  });

  it.each([-1, 0, 8, 100])("throws a RangeError for out-of-range input %i", (invalidDay) => {
    expect(() => isoDayToSocrataDow(invalidDay)).toThrow(RangeError);
  });

  it.each([1.5, NaN])("throws a RangeError for non-integer input %s", (invalidDay) => {
    expect(() => isoDayToSocrataDow(invalidDay)).toThrow(RangeError);
  });
});
