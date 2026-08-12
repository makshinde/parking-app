const RECENCY_HALF_LIFE_DAYS = 30;

// Narrower than the recency half-life, so seasonal alignment only contributes
// meaningfully within a tight window around each yearly anniversary.
const SEASONAL_HALF_LIFE_DAYS = 15;

const SEASONAL_PEAK = 0.75;
const DAYS_PER_YEAR = 365;

// ageInDays is continuous/estimated (an age, not a fixed category), so an
// invalid value is clamped and logged rather than rejected outright.
function clampAgeInDays(ageInDays: number): number {
  if (ageInDays < 0) {
    console.warn(`calculateRecencyWeight: ageInDays ${ageInDays} is invalid, clamping to 0`);
    return 0;
  }
  return ageInDays;
}

// Halves every RECENCY_HALF_LIFE_DAYS: a reading loses half its recency
// weight every 30 days.
function calculateRecencyComponent(ageInDays: number): number {
  return Math.pow(2, -ageInDays / RECENCY_HALF_LIFE_DAYS);
}

// How far ageInDays sits from the closest multiple of a year (0, 365, 730,
// ...), so a reading from ~1 or ~2 years ago is treated as seasonally close.
function calculateDistanceToNearestYear(ageInDays: number): number {
  const remainder = ageInDays % DAYS_PER_YEAR;
  return Math.min(remainder, DAYS_PER_YEAR - remainder);
}

function calculateSeasonalComponent(ageInDays: number): number {
  const distanceToNearestYear = calculateDistanceToNearestYear(ageInDays);
  return SEASONAL_PEAK * Math.pow(2, -distanceToNearestYear / SEASONAL_HALF_LIFE_DAYS);
}

// Probabilistic-OR combination (1 - (1-a)(1-b), rearranged to a+b-ab) instead
// of max(a, b), so this reading's own recency and seasonal signals reinforce
// each other rather than one simply overriding the other. Always stays
// within [0, 1] when a and b do.
//
// This only combines the two signals for a single reading. The broader
// reinforcement this function is meant to enable -- a ~7-day-old reading and
// a separate ~365-day-old reading both contributing meaningfully to a
// prediction -- happens when their individual weights are combined during
// aggregation (e.g. a weighted average across readings), not inside this
// function.
function combineWeights(a: number, b: number): number {
  return a + b - a * b;
}

export function calculateRecencyWeight(ageInDays: number): number {
  const safeAgeInDays = clampAgeInDays(ageInDays);
  const recency = calculateRecencyComponent(safeAgeInDays);
  const seasonal = calculateSeasonalComponent(safeAgeInDays);
  return combineWeights(recency, seasonal);
}
