import { describe, expect, it } from "vitest";
import { reprojectPoint } from "../utils/reprojectCoordinates";
import { formatLineForPostgis } from "./formatLineForPostgis";

// Same real, verified Belltown curb-spaces point (SRID 2926) used in
// reprojectCoordinates.test.ts, cross-checked there against PROJ's cs2cs CLI.
const BELLTOWN_X = 1265813.38993298;
const BELLTOWN_Y = 228647.898526177;

describe("formatLineForPostgis", () => {
  it("reprojects a real two-point line and formats it as SRID=4326 WKT", () => {
    const rawLineCoordinates: [number, number][] = [
      [BELLTOWN_X, BELLTOWN_Y],
      [BELLTOWN_X + 100, BELLTOWN_Y + 100],
    ];

    const [first, second] = rawLineCoordinates.map(([x, y]) => reprojectPoint(x, y));
    if (!first || !second) {
      throw new Error("expected two reprojected points in this test's fixture");
    }

    const result = formatLineForPostgis(rawLineCoordinates);

    expect(result).toBe(`SRID=4326;LINESTRING(${first.lon} ${first.lat}, ${second.lon} ${second.lat})`);
  });

  it("does not swap lat/lon order -- WKT is (longitude latitude), not (latitude longitude)", () => {
    const result = formatLineForPostgis([
      [BELLTOWN_X, BELLTOWN_Y],
      [BELLTOWN_X + 100, BELLTOWN_Y + 100],
    ]);

    const { lat, lon } = reprojectPoint(BELLTOWN_X, BELLTOWN_Y);
    // Sanity-anchors: Seattle longitude is negative (~-122.3), latitude is
    // positive (~47.6) -- if the two were swapped, this first pair would
    // read as a positive value first, not a negative one.
    expect(lon).toBeLessThan(0);
    expect(lat).toBeGreaterThan(0);

    const firstPair = result.slice(result.indexOf("(") + 1, result.indexOf(","));
    const [firstNumber, secondNumber] = firstPair.trim().split(" ").map(Number);

    expect(firstNumber).toBe(lon);
    expect(secondNumber).toBe(lat);
  });

  it("formats a multi-point (3+ vertex) line, preserving point order", () => {
    const rawLineCoordinates: [number, number][] = [
      [BELLTOWN_X, BELLTOWN_Y],
      [BELLTOWN_X + 100, BELLTOWN_Y + 100],
      [BELLTOWN_X + 200, BELLTOWN_Y - 50],
    ];

    const expectedPoints = rawLineCoordinates
      .map(([x, y]) => reprojectPoint(x, y))
      .map(({ lat, lon }) => `${lon} ${lat}`)
      .join(", ");

    const result = formatLineForPostgis(rawLineCoordinates);

    expect(result).toBe(`SRID=4326;LINESTRING(${expectedPoints})`);
  });

  it("throws when given fewer than 2 points", () => {
    expect(() => formatLineForPostgis([])).toThrow(/at least 2 points, got 0/);
    expect(() => formatLineForPostgis([[BELLTOWN_X, BELLTOWN_Y]])).toThrow(/at least 2 points, got 1/);
  });

  it("propagates a RangeError from a non-finite coordinate", () => {
    expect(() =>
      formatLineForPostgis([
        [NaN, BELLTOWN_Y],
        [BELLTOWN_X, BELLTOWN_Y],
      ]),
    ).toThrow(RangeError);
  });
});
