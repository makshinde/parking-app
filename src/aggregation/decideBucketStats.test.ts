import { describe, expect, it } from "vitest";
import { decideBucketStats, decideBucketStatsFromAccumulator, MIN_READINGS_PER_BUCKET } from "./decideBucketStats.ts";
import type { WeightedReading } from "./weightedStats.ts";
import { addReading, createEmptyAccumulator, type WeightedStatsAccumulator } from "./incrementalWeightedStats.ts";

function makeReadings(count: number): WeightedReading[] {
  return Array.from({ length: count }, (_, i) => ({ value: (i % 10) / 10, weight: 1 }));
}

function accumulatorFromReadings(readings: WeightedReading[]): WeightedStatsAccumulator {
  return readings.reduce((acc, r) => addReading(acc, r.value, r.weight), createEmptyAccumulator());
}

describe("decideBucketStats", () => {
  it("computes stats when reading count is exactly at the threshold", () => {
    const result = decideBucketStats(makeReadings(MIN_READINGS_PER_BUCKET));

    expect(result).not.toBeNull();
    expect(result?.sampleCount).toBe(MIN_READINGS_PER_BUCKET);
    expect(result?.mean).toBeCloseTo(0.45);
  });

  it("skips (returns null) when reading count is one below the threshold", () => {
    const result = decideBucketStats(makeReadings(MIN_READINGS_PER_BUCKET - 1));

    expect(result).toBeNull();
  });

  it("computes stats when reading count is well above the threshold", () => {
    const result = decideBucketStats(makeReadings(2760));

    expect(result).not.toBeNull();
    expect(result?.sampleCount).toBe(2760);
  });

  it("skips cleanly (returns null, not an error) for zero readings", () => {
    expect(() => decideBucketStats([])).not.toThrow();
    expect(decideBucketStats([])).toBeNull();
  });
});

describe("decideBucketStatsFromAccumulator", () => {
  it("computes the same stats as decideBucketStats given the same readings, at the threshold", () => {
    const readings = makeReadings(MIN_READINGS_PER_BUCKET);
    const batchResult = decideBucketStats(readings);

    const result = decideBucketStatsFromAccumulator(accumulatorFromReadings(readings));

    expect(result).not.toBeNull();
    expect(result?.sampleCount).toBe(MIN_READINGS_PER_BUCKET);
    expect(result?.mean).toBeCloseTo(batchResult!.mean, 10);
    expect(result?.stdDev).toBeCloseTo(batchResult!.stdDev, 10);
  });

  it("skips (returns null) when accumulator count is one below the threshold", () => {
    const accumulator = accumulatorFromReadings(makeReadings(MIN_READINGS_PER_BUCKET - 1));
    expect(decideBucketStatsFromAccumulator(accumulator)).toBeNull();
  });

  it("computes stats when accumulator count is well above the threshold", () => {
    const accumulator = accumulatorFromReadings(makeReadings(2760));
    const result = decideBucketStatsFromAccumulator(accumulator);

    expect(result).not.toBeNull();
    expect(result?.sampleCount).toBe(2760);
  });

  it("skips cleanly (returns null, not an error) for a fresh, empty accumulator", () => {
    expect(() => decideBucketStatsFromAccumulator(createEmptyAccumulator())).not.toThrow();
    expect(decideBucketStatsFromAccumulator(createEmptyAccumulator())).toBeNull();
  });
});
