export interface WeightedReading {
  value: number;
  weight: number;
}

export interface WeightedStats {
  mean: number;
  stdDev: number;
}

// value is continuous (any finite number could be a real reading), but a
// non-finite value has no meaningful "nearest valid" reading, same reasoning
// as reprojectCoordinates.ts's x/y check -- so this throws rather than
// clamping. weight is different: it's never actually negative in this
// codebase's own usage (calculateRecencyWeight and confidenceScore both only
// ever produce values in [0, 1]), so a negative weight signals a real bug
// upstream, not an imprecise-but-real estimate -- there's no meaningful
// "nearest valid" weight to clamp a negative one toward, the same reasoning
// parseRateValue.ts uses for rejecting a negative rate outright rather than
// clamping it to 0.
function assertValidReading(reading: WeightedReading, index: number): void {
  if (!Number.isFinite(reading.value)) {
    throw new RangeError(`calculateWeightedStats: readings[${index}].value must be a finite number, got ${reading.value}`);
  }
  if (!Number.isFinite(reading.weight)) {
    throw new RangeError(`calculateWeightedStats: readings[${index}].weight must be a finite number, got ${reading.weight}`);
  }
  if (reading.weight < 0) {
    throw new RangeError(`calculateWeightedStats: readings[${index}].weight must not be negative, got ${reading.weight}`);
  }
}

// Empty input has no meaningful mean/stdDev at all -- not an imprecise
// estimate to fall back on, so this throws rather than returning e.g. 0 or
// NaN (same reasoning as formatLineForPostgis.ts requiring at least 2
// points for a line).
export function calculateWeightedStats(readings: WeightedReading[]): WeightedStats {
  if (readings.length === 0) {
    throw new Error("calculateWeightedStats: readings must not be empty -- there is no meaningful mean/stdDev for zero readings");
  }

  readings.forEach((reading, index) => assertValidReading(reading, index));

  const totalWeight = readings.reduce((sum, reading) => sum + reading.weight, 0);
  if (totalWeight === 0) {
    // Every individual weight is >= 0 (enforced above), so totalWeight === 0
    // only happens when every reading's weight is exactly 0 -- there's no
    // way to compute a weighted average across readings that all carry zero
    // importance, so this throws instead of dividing by zero into NaN.
    throw new Error(
      "calculateWeightedStats: total weight is 0 -- cannot compute a weighted mean when every reading has zero weight",
    );
  }

  const mean = readings.reduce((sum, reading) => sum + reading.value * reading.weight, 0) / totalWeight;

  // Population variance (divides by the total weight, not weight - 1 or any
  // Bessel-style correction): the readings passed in are the complete set of
  // observations for whatever window/bucket is being summarized (e.g. all
  // recorded occupancy readings for one blockface/day-of-week/hour), not a
  // sample drawn to estimate some larger population's variance -- so no
  // Bessel correction is needed.
  const variance = readings.reduce((sum, reading) => sum + reading.weight * (reading.value - mean) ** 2, 0) / totalWeight;
  const stdDev = Math.sqrt(variance);

  return { mean, stdDev };
}
