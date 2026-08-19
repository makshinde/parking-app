import { describe, expect, it } from "vitest";
import { decideBucketStats, MIN_READINGS_PER_BUCKET } from "./decideBucketStats.ts";
import type { WeightedReading } from "./weightedStats.ts";

function makeReadings(count: number): WeightedReading[] {
  return Array.from({ length: count }, (_, i) => ({ value: (i % 10) / 10, weight: 1 }));
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
