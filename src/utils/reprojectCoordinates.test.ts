import { describe, expect, it } from "vitest";
import { reprojectLine, reprojectPoint } from "./reprojectCoordinates";

describe("reprojectPoint", () => {
  it("reprojects a real verified curb-spaces point in Belltown to WGS84", () => {
    // Real point from our verified curb-spaces data (SRID 2926). Independently
    // cross-checked with PROJ's cs2cs CLI (a separate C implementation, not
    // the proj4 JS package under test here) using the same EPSG:2926
    // definition: cs2cs reported lat 47.61669889, lon -122.35229401 --
    // matching to 4 decimal places (sub-meter difference, from cs2cs using
    // PROJ's grid-based NAD83(HARN)->WGS84 pipeline vs. this file's static
    // towgs84 shift; both are correct to well under blockface-level precision).
    const { lat, lon } = reprojectPoint(1265813.38993298, 228647.898526177);

    expect(lat).toBeCloseTo(47.6167, 3);
    expect(lon).toBeCloseTo(-122.3523, 3);

    // Sanity range check: Seattle proper, not some other state plane zone.
    expect(lat).toBeGreaterThan(47.6);
    expect(lat).toBeLessThan(47.7);
    expect(lon).toBeGreaterThan(-122.4);
    expect(lon).toBeLessThan(-122.3);
  });

  it("throws a RangeError for a non-finite x", () => {
    expect(() => reprojectPoint(NaN, 228647.9)).toThrow(RangeError);
    expect(() => reprojectPoint(Infinity, 228647.9)).toThrow(RangeError);
  });

  it("throws a RangeError for a non-finite y", () => {
    expect(() => reprojectPoint(1265813.4, NaN)).toThrow(RangeError);
    expect(() => reprojectPoint(1265813.4, -Infinity)).toThrow(RangeError);
  });
});

describe("reprojectLine", () => {
  it("reprojects each coordinate pair in order, reusing reprojectPoint", () => {
    const coordinates: [number, number][] = [
      [1265813.38993298, 228647.898526177],
      [1265813.38993298 + 100, 228647.898526177 + 100],
    ];

    const result = reprojectLine(coordinates);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(reprojectPoint(coordinates[0][0], coordinates[0][1]));
    expect(result[1]).toEqual(reprojectPoint(coordinates[1][0], coordinates[1][1]));
    // Confirms the two points didn't collapse to the same output.
    expect(result[0]).not.toEqual(result[1]);
  });

  it("returns an empty array for an empty LineString", () => {
    expect(reprojectLine([])).toEqual([]);
  });

  it("propagates a RangeError from a non-finite coordinate in the array", () => {
    expect(() => reprojectLine([[NaN, 228647.9]])).toThrow(RangeError);
  });
});
