import { describe, expect, it } from "vitest";
import { addReading, createEmptyAccumulator, finalizeStats, type WeightedStatsAccumulator } from "./incrementalWeightedStats.ts";
import { calculateWeightedStats, type WeightedReading } from "./weightedStats.ts";

function processAllAtOnce(readings: WeightedReading[]): WeightedStatsAccumulator {
  return readings.reduce((acc, reading) => addReading(acc, reading.value, reading.weight), createEmptyAccumulator());
}

describe("addReading / finalizeStats", () => {
  it("throws for an empty accumulator -- there is no meaningful mean/stdDev for zero readings", () => {
    expect(() => finalizeStats(createEmptyAccumulator())).toThrow(/no readings/);
  });

  it("returns the reading's own value as mean and 0 as stdDev for a single reading", () => {
    const acc = addReading(createEmptyAccumulator(), 42, 3);
    expect(finalizeStats(acc)).toEqual({ mean: 42, stdDev: 0, sampleCount: 1 });
  });

  it("throws instead of dividing by zero when every weight is 0", () => {
    let acc = createEmptyAccumulator();
    acc = addReading(acc, 1, 0);
    acc = addReading(acc, 2, 0);
    expect(() => finalizeStats(acc)).toThrow(/total weight is 0/);
  });

  it("does not let a zero-weight reading distort the result, but still counts it in sampleCount", () => {
    let acc = createEmptyAccumulator();
    acc = addReading(acc, 10, 0);
    acc = addReading(acc, 20, 1);
    expect(finalizeStats(acc)).toEqual({ mean: 20, stdDev: 0, sampleCount: 2 });
  });

  it("throws for a non-finite value", () => {
    expect(() => addReading(createEmptyAccumulator(), NaN, 1)).toThrow(/value must be a finite number/);
    expect(() => addReading(createEmptyAccumulator(), Infinity, 1)).toThrow(/value must be a finite number/);
  });

  it("throws for a non-finite weight", () => {
    expect(() => addReading(createEmptyAccumulator(), 1, NaN)).toThrow(/weight must be a finite number/);
    expect(() => addReading(createEmptyAccumulator(), 1, Infinity)).toThrow(/weight must be a finite number/);
  });

  it("throws for a negative weight rather than clamping it to 0", () => {
    let acc = createEmptyAccumulator();
    acc = addReading(acc, 1, 1);
    expect(() => addReading(acc, 2, -1)).toThrow(/weight must not be negative/);
  });

  it("identifies the offending reading's index in the error message", () => {
    let acc = createEmptyAccumulator();
    acc = addReading(acc, 1, 1);
    acc = addReading(acc, 2, 1);
    expect(() => addReading(acc, NaN, 1)).toThrow(/reading index 2/);
  });

  // Hand-calculated example, identical to weightedStats.test.ts's own:
  // value=1 weight=1, value=2 weight=2, value=3 weight=3 -> mean 7/3,
  // stdDev sqrt(5)/3. The critical correctness check here is that the
  // incremental, one-at-a-time path agrees with the already-proven batch
  // calculateWeightedStats given the exact same readings, not just that
  // it's internally consistent with itself.
  it("matches calculateWeightedStats's hand-calculated result for readings with genuinely different weights", () => {
    const readings: WeightedReading[] = [
      { value: 1, weight: 1 },
      { value: 2, weight: 2 },
      { value: 3, weight: 3 },
    ];

    const incremental = finalizeStats(processAllAtOnce(readings));
    const batch = calculateWeightedStats(readings);

    expect(incremental.mean).toBeCloseTo(7 / 3, 10);
    expect(incremental.stdDev).toBeCloseTo(Math.sqrt(5) / 3, 10);
    expect(incremental.mean).toBeCloseTo(batch.mean, 10);
    expect(incremental.stdDev).toBeCloseTo(batch.stdDev, 10);
    expect(incremental.sampleCount).toBe(readings.length);
  });

  it("matches calculateWeightedStats across a larger, more varied set of readings", () => {
    const readings: WeightedReading[] = [
      { value: 0.2, weight: 0.9 },
      { value: 0.55, weight: 0.6 },
      { value: 0.9, weight: 1 },
      { value: 0.1, weight: 0.3 },
      { value: 0.7, weight: 0.75 },
      { value: 1.0, weight: 0.5 },
      { value: 0.4, weight: 0.85 },
    ];

    const incremental = finalizeStats(processAllAtOnce(readings));
    const batch = calculateWeightedStats(readings);

    expect(incremental.mean).toBeCloseTo(batch.mean, 10);
    expect(incremental.stdDev).toBeCloseTo(batch.stdDev, 10);
    expect(incremental.sampleCount).toBe(readings.length);
  });

  it("produces the same result regardless of the order readings are added in", () => {
    const readings: WeightedReading[] = [
      { value: 0.2, weight: 0.9 },
      { value: 0.55, weight: 0.6 },
      { value: 0.9, weight: 1 },
      { value: 0.1, weight: 0.3 },
      { value: 0.7, weight: 0.75 },
    ];
    const reversed = [...readings].reverse();
    const shuffled = [readings[2], readings[0], readings[4], readings[1], readings[3]] as WeightedReading[];

    const forward = finalizeStats(processAllAtOnce(readings));
    const backward = finalizeStats(processAllAtOnce(reversed));
    const outOfOrder = finalizeStats(processAllAtOnce(shuffled));

    expect(backward.mean).toBeCloseTo(forward.mean, 9);
    expect(backward.stdDev).toBeCloseTo(forward.stdDev, 9);
    expect(outOfOrder.mean).toBeCloseTo(forward.mean, 9);
    expect(outOfOrder.stdDev).toBeCloseTo(forward.stdDev, 9);
  });

  it("matches the plain unweighted mean/stdDev when all weights are equal", () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    const readings: WeightedReading[] = values.map((value) => ({ value, weight: 1 }));

    const result = finalizeStats(processAllAtOnce(readings));

    // Same well-known population stddev (2) weightedStats.test.ts pins for
    // this exact dataset.
    expect(result.mean).toBeCloseTo(5, 10);
    expect(result.stdDev).toBeCloseTo(2, 10);
  });
});
