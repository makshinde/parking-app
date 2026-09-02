const RECENCY_HALF_LIFE_DAYS = 30;

// Narrower than the recency half-life, so seasonal alignment only contributes
// meaningfully within a tight window around each yearly anniversary.
const SEASONAL_HALF_LIFE_DAYS = 15;

const SEASONAL_PEAK = 0.75;
const DAYS_PER_YEAR = 365;

// Half-life for the current-calendar-year component (see
// calculateCurrentYearComponent below). Chosen from real computed values
// across the requested 90-120 day candidate range, checked at four
// distances, not just the headline age-90 case -- the four candidates
// track closely at small ages but diverge sharply as age grows:
//
// Raw current-year component value, 2^(-age/HL):
//   age    HL=90   HL=100  HL=110  HL=120
//    30    0.7937  0.8123  0.8278  0.8409
//    90    0.5000  0.5359  0.5672  0.5946
//   150    0.3150  0.3536  0.3886  0.4204
//   250    0.1458  0.1768  0.2069  0.2360
//
// Full 3-component combined weight for a current-year reading (old
// 2-component, prior-year baseline shown for reference -- unaffected by
// this choice):
//   age    HL=90    HL=100   HL=110   HL=120   baseline
//    30    0.91619  0.92373  0.93002  0.93536  0.59375
//    90    0.56763  0.59866  0.62570  0.64944  0.13525
//   150    0.33687  0.37421  0.40814  0.43897  0.03196
//   250    0.15161  0.18236  0.21232  0.24115  0.00678
//
// At 250 days the ratio-vs-baseline spans 22x (HL=90) to 36x (HL=120) --
// a real, meaningful difference, not noise -- so this was picked
// deliberately for the shape at the far end, not just as the range's
// midpoint: 120 keeps a 250-day-old current-year reading meaningfully
// weighted (0.236 raw, 0.241 combined) rather than letting it decay away
// too quickly, on the reasoning that genuinely-current-year data stays
// valuable evidence for longer than a 90-100 day half-life would allow.
// The values above are what to recompute against if this ever needs
// revisiting.
const CURRENT_YEAR_HALF_LIFE_DAYS = 120;

// Peak (age-0) amplitude for the current-year component -- deliberately
// greater than 1.0, unlike SEASONAL_PEAK's 0.75 cap. This is a real product
// decision, not an arbitrary tuning choice: for this application, recency
// within the current calendar year is considered MORE informative than a
// prior-year seasonal echo, because Seattle's real-world parking conditions
// (rapid new development, business openings/closings, road and construction
// changes, shifting traffic patterns) move fast enough that a same-year
// reading reflects the actual current state of a blockface in a way a
// year-old reading from the same season fundamentally cannot, no matter how
// well its season lines up.
//
// The concrete requirement this value was solved for: even the oldest
// current-year reading expected in practice (~270 days -- the age Q1 2026
// data reaches by the time roughly three-quarters of the year has passed)
// must still combine to a HIGHER total weight than a prior-year reading
// sitting exactly on its seasonal peak (age 365, combined weight 0.75005 --
// see CURRENT_YEAR_PEAK_WEIGHT's own verification below). Solving
// combine(x, y) = x + y(1-x) > 0.75005 for y at age=270 (where x, the
// recency+seasonal contribution alone, is 0.011236) requires the raw
// current-year component to exceed roughly 0.7472 at that age, which in
// turn requires PEAK * 2^(-270/120) > 0.7472, i.e. PEAK > 3.5544. 4.0 is
// used here: a clean number with real, comfortable margin at every age
// checked, not a knife's-edge value -- see the age-by-age table below.
//
//   age (days)  raw = 4.0 * 2^(-age/120)   combined (3-component)   margin over 0.75005 baseline
//    30         3.3636                      1.96021                  +1.21015
//    90         2.3784                      2.19198                  +1.44192
//   150         1.6818                      1.66000                  +0.90995
//   240         1.0000                      1.00000                  +0.24995
//   270         0.8409                      0.84268                  +0.09263
//
// (At exactly age=240, PEAK*2^(-240/120) = 4.0*0.25 = 1.0 precisely, and
// combine(x, 1) = x + 1 - x = 1 for any x -- mathematically exact, a
// hand-verifiable checkpoint, though not floating-point bit-exact:
// live-checked at 0.9999999999999999, 1 ULP off from 1, due to ordinary
// floating-point rounding in the intermediate x+1-x subtraction.) The
// guarantee erodes
// gradually past 270 (crossing back below baseline around day 290-291),
// which is expected and fine: 270 is the real worst case this was solved
// for, not an arbitrary cutoff, and Q1 2026 data doesn't reach that age
// until the very end of the year regardless.
//
// A necessary consequence: unlike the original two-component design,
// calculateRecencyWeight's output is no longer bounded to [0, 1] once a
// current-year reading is young enough (raw current-year component > 1
// combined with any recency/seasonal contribution pushes the total above
// 1 -- see combineWeights' own comment). This is fine for this function's
// actual use (a per-reading weight feeding a weighted mean/variance, see
// calculateWeightedStats.ts and incrementalWeightedStats.ts), which only
// needs weights to be non-negative and to reflect each reading's RELATIVE
// importance -- it never assumes or requires weights to be capped at 1.
const CURRENT_YEAR_PEAK_WEIGHT = 4.0;

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
// just with a far longer half-life (120 days vs. 30) and a peak above 1.0
// (see CURRENT_YEAR_PEAK_WEIGHT), so genuinely-current-year data stays
// weighted ABOVE even a prior-year reading at its seasonal peak, all the
// way out past 270 days -- not just "meaningfully weighted" the way the
// base recency component alone would decay to near zero by then. The
// reasoning: a reading from the year we're actually predicting for is
// real, current evidence in its own right -- current construction, current
// business openings/closings, current traffic patterns -- which this
// application deliberately treats as more informative than a prior-year
// seasonal echo (see CURRENT_YEAR_PEAK_WEIGHT's comment for the full
// product reasoning and the exact numbers this was solved against).
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
  return CURRENT_YEAR_PEAK_WEIGHT * Math.pow(2, -ageInDays / CURRENT_YEAR_HALF_LIFE_DAYS);
}

// Probabilistic-OR combination (1 - (1-a)(1-b), rearranged to a+b-ab) instead
// of max(a, b), so this reading's own recency and seasonal signals reinforce
// each other rather than one simply overriding the other. Stays within
// [0, 1] when BOTH a and b do -- true for every combination in this module
// except when the current-year component is involved, since
// CURRENT_YEAR_PEAK_WEIGHT is deliberately > 1 (see its own comment for
// why); combining a value above 1 with anything pushes the result above 1
// too. That's an intentional, accepted consequence for this specific
// component, not a bug -- see calculateRecencyWeight's own comment.
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
//
// Return value is NOT guaranteed to be within [0, 1] -- a young enough
// current-year reading can push it above 1 (see CURRENT_YEAR_PEAK_WEIGHT's
// comment for why that's deliberate and safe for how this weight is
// actually used downstream).
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
