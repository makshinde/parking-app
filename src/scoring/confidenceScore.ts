// Points on the 0-10 scale allotted to each contributing factor.
const MAX_SAMPLE_SIZE_POINTS = 4;
const MAX_CONSISTENCY_POINTS = 4;
const MAX_RECENCY_POINTS = 2;

// Number of historical observations at which sample size stops adding value.
// Beyond this, more data doesn't meaningfully improve confidence.
const SAMPLE_SIZE_SATURATION_COUNT = 200;

// Furthest we forecast; recency score decays linearly to its floor by this
// point. Exported so resolveRequestTime.ts can reject a request beyond this
// same horizon at the request-validation layer, rather than maintaining a
// second, separately-tracked "7" that could silently drift out of sync
// with this one.
export const MAX_DAYS_IN_FUTURE = 7;

// Recency score never drops below this fraction of its max, since even a
// week-out forecast is still informed by the same underlying historical pattern.
const MIN_RECENCY_FRACTION = 0.5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// Clamps an input parameter and logs a warning when the raw value was out of
// range, so callers can spot bad upstream data without the score computation failing.
function clampInput(value: number, min: number, max: number, label: string): number {
  const clamped = clamp(value, min, max);
  if (clamped !== value) {
    console.warn(`confidenceScore: ${label} ${value} is invalid, clamping to ${clamped}`);
  }
  return clamped;
}

// Scales linearly from 0 to MAX_SAMPLE_SIZE_POINTS as sample_count goes from
// 0 to the saturation count; negative counts (invalid input) are treated as 0.
function scoreSampleSize(sampleCount: number): number {
  const safeCount = clampInput(sampleCount, 0, SAMPLE_SIZE_SATURATION_COUNT, "sample_count");
  return (safeCount / SAMPLE_SIZE_SATURATION_COUNT) * MAX_SAMPLE_SIZE_POINTS;
}

// Lower variance (std_dev closer to 0) means occupancy is more predictable,
// so it earns more points. Out-of-range input is clamped to the valid [0, 1] domain.
function scoreConsistency(stdDev: number): number {
  const safeStdDev = clampInput(stdDev, 0, 1, "std_dev");
  return (1 - safeStdDev) * MAX_CONSISTENCY_POINTS;
}

// Today's prediction is most reliable; confidence tapers linearly down to half
// of the max at MAX_DAYS_IN_FUTURE, since forecasts further out are more likely
// to be thrown off by unpredictable day-to-day changes.
function scoreRecency(daysInFuture: number): number {
  const safeDays = clampInput(daysInFuture, 0, MAX_DAYS_IN_FUTURE, "days_in_future");
  const decayFraction = safeDays / MAX_DAYS_IN_FUTURE;
  const fraction = 1 - decayFraction * (1 - MIN_RECENCY_FRACTION);
  return fraction * MAX_RECENCY_POINTS;
}

export function calculateConfidenceScore(
  sampleCount: number,
  stdDev: number,
  daysInFuture: number,
): number {
  const rawScore =
    scoreSampleSize(sampleCount) +
    scoreConsistency(stdDev) +
    scoreRecency(daysInFuture);

  return Math.round(clamp(rawScore, 0, 10));
}
