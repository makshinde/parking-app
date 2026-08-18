import { describe, expect, it } from "vitest";
import { calculateWeightedStats } from "./weightedStats";

describe("calculateWeightedStats", () => {
  it("throws for empty input -- there is no meaningful mean/stdDev for zero readings", () => {
    expect(() => calculateWeightedStats([])).toThrow(/must not be empty/);
  });

  it("returns the reading's own value as mean and 0 as stdDev for a single reading", () => {
    expect(calculateWeightedStats([{ value: 42, weight: 3 }])).toEqual({ mean: 42, stdDev: 0 });
  });

  it("throws instead of dividing by zero when every weight is 0", () => {
    expect(() =>
      calculateWeightedStats([
        { value: 1, weight: 0 },
        { value: 2, weight: 0 },
      ]),
    ).toThrow(/total weight is 0/);
  });

  it("throws for a single reading with weight 0 (still a total weight of 0)", () => {
    expect(() => calculateWeightedStats([{ value: 5, weight: 0 }])).toThrow(/total weight is 0/);
  });

  it("does not throw when some weights are 0 as long as the total is nonzero", () => {
    const result = calculateWeightedStats([
      { value: 10, weight: 0 },
      { value: 20, weight: 1 },
    ]);
    // The zero-weight reading contributes nothing -- result should be
    // identical to a single {value: 20, weight: 1} reading.
    expect(result).toEqual({ mean: 20, stdDev: 0 });
  });

  it("matches the plain unweighted mean/stdDev when all weights are equal (sanity check that weighting doesn't distort the simple case)", () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    const readings = values.map((value) => ({ value, weight: 1 }));

    const unweightedMean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const unweightedVariance = values.reduce((sum, v) => sum + (v - unweightedMean) ** 2, 0) / values.length;
    const unweightedStdDev = Math.sqrt(unweightedVariance);

    const result = calculateWeightedStats(readings);

    expect(result.mean).toBeCloseTo(unweightedMean, 10);
    expect(result.stdDev).toBeCloseTo(unweightedStdDev, 10);
    // This specific dataset's well-known population stddev is 2, as an
    // independent check on the unweighted values above.
    expect(unweightedMean).toBe(5);
    expect(unweightedStdDev).toBe(2);
  });

  it("also matches the unweighted case when the shared weight is something other than 1", () => {
    const values = [10, 20, 30];
    const readings = values.map((value) => ({ value, weight: 2.5 }));

    const result = calculateWeightedStats(readings);

    expect(result.mean).toBeCloseTo(20, 10);
    expect(result.stdDev).toBeCloseTo(Math.sqrt(200 / 3), 10);
  });

  // Hand-calculated example with genuinely different weights, worked out
  // by hand (not just asserted against a re-implementation):
  //
  //   readings: value=1 weight=1, value=2 weight=2, value=3 weight=3
  //   totalWeight = 1 + 2 + 3 = 6
  //
  //   mean = (1*1 + 2*2 + 3*3) / 6 = (1 + 4 + 9) / 6 = 14/6 = 7/3 ≈ 2.3333333333
  //
  //   deviations from the mean (7/3):
  //     1 - 7/3 = -4/3, squared = 16/9
  //     2 - 7/3 = -1/3, squared =  1/9
  //     3 - 7/3 =  2/3, squared =  4/9
  //
  //   variance = (1*16/9 + 2*1/9 + 3*4/9) / 6
  //            = (16/9 + 2/9 + 12/9) / 6
  //            = (30/9) / 6
  //            = (10/3) / 6
  //            = 10/18 = 5/9 ≈ 0.5555555556
  //
  //   stdDev = sqrt(5/9) = sqrt(5)/3 ≈ 0.7453559925
  it("matches a hand-calculated result for readings with genuinely different weights", () => {
    const result = calculateWeightedStats([
      { value: 1, weight: 1 },
      { value: 2, weight: 2 },
      { value: 3, weight: 3 },
    ]);

    expect(result.mean).toBeCloseTo(7 / 3, 10);
    expect(result.stdDev).toBeCloseTo(Math.sqrt(5) / 3, 10);
    // Same values pinned as plain decimals too, so the expectation is
    // readable without re-deriving the fractions above.
    expect(result.mean).toBeCloseTo(2.3333333333, 9);
    expect(result.stdDev).toBeCloseTo(0.7453559925, 9);
  });

  it("throws for a non-finite value", () => {
    expect(() => calculateWeightedStats([{ value: NaN, weight: 1 }])).toThrow(/readings\[0\]\.value/);
    expect(() => calculateWeightedStats([{ value: Infinity, weight: 1 }])).toThrow(/readings\[0\]\.value/);
  });

  it("throws for a non-finite weight", () => {
    expect(() => calculateWeightedStats([{ value: 1, weight: NaN }])).toThrow(/readings\[0\]\.weight/);
    expect(() => calculateWeightedStats([{ value: 1, weight: Infinity }])).toThrow(/readings\[0\]\.weight/);
  });

  it("throws for a negative weight rather than clamping it to 0", () => {
    expect(() =>
      calculateWeightedStats([
        { value: 1, weight: 1 },
        { value: 2, weight: -1 },
      ]),
    ).toThrow(/readings\[1\]\.weight must not be negative/);
  });

  it("identifies the offending index when multiple readings are present", () => {
    expect(() =>
      calculateWeightedStats([
        { value: 1, weight: 1 },
        { value: 2, weight: 1 },
        { value: NaN, weight: 1 },
      ]),
    ).toThrow(/readings\[2\]\.value/);
  });
});
