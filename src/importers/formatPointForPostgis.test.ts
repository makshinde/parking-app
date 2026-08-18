import { describe, expect, it } from "vitest";
import { reprojectPoint } from "../utils/reprojectCoordinates";
import { formatPointForPostgis } from "./formatPointForPostgis";

// Same real, verified Belltown curb-spaces point (SRID 2926) used in
// reprojectCoordinates.test.ts and formatLineForPostgis.test.ts, cross-checked
// there against PROJ's cs2cs CLI.
const BELLTOWN_X = 1265813.38993298;
const BELLTOWN_Y = 228647.898526177;

describe("formatPointForPostgis", () => {
  it("reprojects a real point and formats it as SRID=4326 WKT", () => {
    const { lat, lon } = reprojectPoint(BELLTOWN_X, BELLTOWN_Y);

    const result = formatPointForPostgis(BELLTOWN_X, BELLTOWN_Y);

    expect(result).toBe(`SRID=4326;POINT(${lon} ${lat})`);
  });

  it("does not swap lat/lon order -- WKT is (longitude latitude), not (latitude longitude)", () => {
    const { lat, lon } = reprojectPoint(BELLTOWN_X, BELLTOWN_Y);
    // Sanity-anchors: Seattle longitude is negative (~-122.3), latitude is
    // positive (~47.6) -- if the two were swapped, the WKT's first number
    // would read positive, not negative.
    expect(lon).toBeLessThan(0);
    expect(lat).toBeGreaterThan(0);

    const result = formatPointForPostgis(BELLTOWN_X, BELLTOWN_Y);
    const inner = result.slice(result.indexOf("(") + 1, result.indexOf(")"));
    const [firstNumber, secondNumber] = inner.trim().split(" ").map(Number);

    expect(firstNumber).toBe(lon);
    expect(secondNumber).toBe(lat);
  });

  it("propagates a RangeError from a non-finite coordinate", () => {
    expect(() => formatPointForPostgis(NaN, BELLTOWN_Y)).toThrow(RangeError);
    expect(() => formatPointForPostgis(BELLTOWN_X, Infinity)).toThrow(RangeError);
  });
});
