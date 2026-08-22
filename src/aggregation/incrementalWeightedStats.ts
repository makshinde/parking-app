import type { BucketStats } from "./decideBucketStats.ts";

// Streaming counterpart to weightedStats.ts's calculateWeightedStats. That
// function needs every reading held in memory at once (readings: WeightedReading[]);
// this module produces the same mean/stdDev instead by folding one reading
// at a time into a small, fixed-size accumulator, which is what makes it
// usable for streaming the full multi-hundred-million-row archive (see
// CLAUDE.md's Architecture section) without holding raw readings in memory.
//
// Uses West's algorithm (weighted online mean/variance): each new reading
// updates the running mean via a weight-proportional correction, and
// accumulates the variance term (sumSquaredDiff) using the *old* mean's
// delta times the *new* mean's delta, rather than the reading's deviation
// from a single fixed mean the way the batch version does. This is
// algebraically equivalent to calculateWeightedStats's
// sum(weight * (value - finalMean)^2), just re-derived so it can be computed
// incrementally without knowing the final mean in advance -- verified
// directly against calculateWeightedStats's own hand-calculated example in
// this module's tests, not just internally consistent with itself.
export interface WeightedStatsAccumulator {
  count: number;
  totalWeight: number;
  mean: number;
  sumSquaredDiff: number;
}

export function createEmptyAccumulator(): WeightedStatsAccumulator {
  return { count: 0, totalWeight: 0, mean: 0, sumSquaredDiff: 0 };
}

// A full set of per-bucket accumulators, keyed by whatever bucket-key
// convention the caller uses (e.g. `${blockfaceId}:${isoDay}:${hour}`).
// WeightedStatsAccumulator is already a plain object of finite numbers, so
// this is directly JSON-serializable/deserializable with no conversion step
// -- used by streamArchiveWithResume.ts to checkpoint accumulator state
// alongside the stream's own position, so a resume restores accumulation
// progress exactly rather than replaying already-counted readings into it
// (see that module's comments for the full reasoning).
export type AccumulatorSnapshot = Record<string, WeightedStatsAccumulator>;

// Same validity rules as weightedStats.ts's assertValidReading: value is
// continuous but a non-finite value has no meaningful "nearest valid"
// reading, so it throws rather than clamping. weight is never actually
// negative in this codebase's own usage, so a negative weight signals a
// real upstream bug rather than an imprecise-but-real estimate, and also
// throws rather than clamping to 0.
function assertValidReading(acc: WeightedStatsAccumulator, value: number, weight: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`addReading: value must be a finite number, got ${value} (reading index ${acc.count})`);
  }
  if (!Number.isFinite(weight)) {
    throw new RangeError(`addReading: weight must be a finite number, got ${weight} (reading index ${acc.count})`);
  }
  if (weight < 0) {
    throw new RangeError(`addReading: weight must not be negative, got ${weight} (reading index ${acc.count})`);
  }
}

// Folds one more reading into the accumulator, returning a new accumulator
// (the input is left untouched, so a caller holding onto a prior snapshot --
// e.g. for a checkpoint -- isn't affected by later readings).
export function addReading(acc: WeightedStatsAccumulator, value: number, weight: number): WeightedStatsAccumulator {
  assertValidReading(acc, value, weight);

  const newCount = acc.count + 1;

  // A zero-weight reading is still counted (sampleCount downstream reflects
  // the number of readings seen, same as calculateWeightedStats/
  // decideBucketStats), but contributes nothing to mean/variance -- and
  // must be special-cased here since weight / newTotalWeight would divide
  // 0/0 into NaN if every reading seen so far (including this one) has zero
  // weight.
  if (weight === 0) {
    return { ...acc, count: newCount };
  }

  const newTotalWeight = acc.totalWeight + weight;
  const meanDelta = value - acc.mean;
  const newMean = acc.mean + (weight / newTotalWeight) * meanDelta;
  const newSumSquaredDiff = acc.sumSquaredDiff + weight * meanDelta * (value - newMean);

  return { count: newCount, totalWeight: newTotalWeight, mean: newMean, sumSquaredDiff: newSumSquaredDiff };
}

// Converts a finished accumulator into the same {mean, stdDev, sampleCount}
// shape calculateWeightedStats/decideBucketStats already produce, so
// downstream code doesn't need to know or care whether the stats came from
// the batch or the streaming path. Same empty-input and all-zero-weight
// error cases as calculateWeightedStats, for the same reasons: neither has
// a meaningful mean/stdDev to fall back on.
export function finalizeStats(acc: WeightedStatsAccumulator): BucketStats {
  if (acc.count === 0) {
    throw new Error("finalizeStats: accumulator has no readings -- there is no meaningful mean/stdDev for zero readings");
  }
  if (acc.totalWeight === 0) {
    throw new Error(
      "finalizeStats: total weight is 0 -- cannot compute a weighted mean when every reading has zero weight",
    );
  }

  const variance = acc.sumSquaredDiff / acc.totalWeight;
  return { mean: acc.mean, stdDev: Math.sqrt(variance), sampleCount: acc.count };
}
