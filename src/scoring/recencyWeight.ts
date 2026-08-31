const RECENCY_HALF_LIFE_DAYS = 30;

// Narrower than the recency half-life, so seasonal alignment only contributes
// meaningfully within a tight window around each yearly anniversary.
const SEASONAL_HALF_LIFE_DAYS = 15;

const SEASONAL_PEAK = 0.75;
const DAYS_PER_YEAR = 365;

// Half-life for the current-calendar-year component (see
// calculateCurrentYearComponent below). Chosen from real computed values
// across the requested 90-120 day candidate range -- at age 90 (this
// component's own headline test case), each candidate's raw decay value is:
//   HL=90:  2^(-90/90)  = 0.5000
//   HL=100: 2^(-90/100) = 0.5359
//   HL=110: 2^(-90/110) = 0.5672
//   HL=120: 2^(-90/120) = 0.5946
// and the resulting full 3-component combined weight at age 90 (vs. the old
// 2-component baseline of 0.13525 at that age) is:
//   HL=90:  0.56763 (4.20x baseline)
//   HL=100: 0.59866 (4.43x baseline)
//   HL=110: 0.62570 (4.63x baseline)
//   HL=120: 0.64944 (4.80x baseline)
// All four are a meaningful, comparable improvement over the baseline --
// this isn't a knife-edge choice sensitive to the exact value. 100 is the
// clean midpoint of the requested range, used here; the values above are
// what to recompute against if that choice ever needs revisiting.
const CURRENT_YEAR_HALF_LIFE_DAYS = 100;

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

// Rewards a reading recorded in the SAME calendar year as "now", decaying
// smoothly with age -- same exponential shape as calculateRecencyComponent,
// just with a far longer half-life (100 days vs. 30), so genuinely-current-
// year data stays meaningfully weighted well past where the base recency
// component has already decayed close to zero (e.g. a 90-150 day old
// reading). The reasoning: a reading from the year we're actually
// predicting for is real, current evidence in its own right -- current
// construction, current business openings/closings, current traffic
// patterns -- not merely a proxy for "recent", which is what the existing
// recency component already covers on its own, much shorter timescale.
//
// Gated on readingYear === currentYear EXACTLY, not on ageInDays crossing
// some threshold -- age alone can't distinguish "62 days into this year"
// from "62 days old but spanning a Dec 31/Jan 1 boundary into last year",
// and only the former should ever get this component. Because readingYear
// is fixed at the moment a reading was recorded and currentYear only ever
// moves forward, this can never retroactively switch back on for
// prior-year data: once the calendar rolls over, a reading permanently and
// irreversibly stops qualifying, no matter how the raw age-in-days math
// might otherwise happen to align with a fresh calendar year for some
// OTHER reading.
function calculateCurrentYearComponent(ageInDays: number, readingYear: number, currentYear: number): number {
  if (readingYear !== currentYear) {
    return 0;
  }
  return Math.pow(2, -ageInDays / CURRENT_YEAR_HALF_LIFE_DAYS);
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

// readingYear/currentYear are both discrete, exact calendar years computed
// upstream from trusted sources (a reading's own parsed date components, and
// Date.getFullYear()-equivalent Pacific resolution of "now" -- see
// blockfaceLookup.ts's readingYear field and getPacificCalendarYear) rather
// than direct external input, so -- unlike ageInDays -- they're compared
// with a plain === and given no separate clamp/validation layer here.
export function calculateRecencyWeight(ageInDays: number, readingYear: number, currentYear: number): number {
  const safeAgeInDays = clampAgeInDays(ageInDays);
  const recency = calculateRecencyComponent(safeAgeInDays);
  const seasonal = calculateSeasonalComponent(safeAgeInDays);
  const currentYearComponent = calculateCurrentYearComponent(safeAgeInDays, readingYear, currentYear);
  // Probabilistic-OR is associative (chaining combineWeights twice is
  // exactly 1 - (1-a)(1-b)(1-c)), so this is the same "same approach" used
  // to combine the original two components, just extended to three.
  return combineWeights(combineWeights(recency, seasonal), currentYearComponent);
}
