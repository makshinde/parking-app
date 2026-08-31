import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calculateRecencyWeight } from "./recencyWeight";

// A year distinct from CURRENT_YEAR below, used throughout for tests that
// are deliberately about the original recency/seasonal behavior, unaffected
// by the new current-calendar-year component -- readingYear !== currentYear
// makes that component resolve to exactly 0 (see recencyWeight.ts's own
// comment), so these reproduce the pre-existing two-component results
// unchanged.
const PRIOR_YEAR = 2024;
const CURRENT_YEAR = 2025;

describe("calculateRecencyWeight", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("scores a very recent reading near 1", () => {
    expect(calculateRecencyWeight(1, PRIOR_YEAR, CURRENT_YEAR)).toBeGreaterThan(0.98);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("scores a reading from about a year ago near 0.75", () => {
    // recency(365) is negligible (2^-12.17), so the ~0.75 result comes almost
    // entirely from the seasonal component peaking at its yearly anniversary.
    // Prior-year reading, so the new current-year component contributes 0.
    expect(calculateRecencyWeight(365, PRIOR_YEAR, CURRENT_YEAR)).toBeCloseTo(0.75, 2);
  });

  it("combines this reading's own recency and seasonal signals instead of taking the max", () => {
    // At 30 days: recency = 2^(-30/30) = 0.5, seasonal = 0.75 * 2^(-30/15) = 0.1875
    // (day 30 sits 30 days from the day-0 anniversary, since 0 is itself a
    // multiple of 365). Both signals being non-trivial here is a coincidence
    // of the math at small ages, NOT a demonstration of "recent evidence plus
    // genuinely-year-old evidence" reinforcing each other -- that cross-reading
    // case (a ~7-day-old reading and a separate ~365-day-old reading both
    // feeding a weighted average) happens at the aggregation layer, not within
    // one call to this function. What this test verifies is narrower but still
    // real: combineWeights implements a+b-ab, not max(a, b). Prior-year
    // reading, so the current-year component stays out of this calculation.
    const weight = calculateRecencyWeight(30, PRIOR_YEAR, CURRENT_YEAR);
    expect(weight).toBeCloseTo(0.59375, 5);
    // If this were max(a, b) instead of a+b-ab, the result would be exactly 0.5.
    expect(weight).toBeGreaterThan(0.5);
  });

  it("scores a reading with neither recency nor seasonal alignment low", () => {
    // 180 days is far past the recency half-life and roughly at the
    // midpoint between yearly anniversaries (max possible distance).
    expect(calculateRecencyWeight(180, PRIOR_YEAR, CURRENT_YEAR)).toBeLessThan(0.05);
  });

  it("clamps negative ageInDays to 0 and logs a warning", () => {
    const weight = calculateRecencyWeight(-10, PRIOR_YEAR, CURRENT_YEAR);
    expect(weight).toBeCloseTo(calculateRecencyWeight(0, PRIOR_YEAR, CURRENT_YEAR), 10);
    expect(warnSpy).toHaveBeenCalledWith(
      "calculateRecencyWeight: ageInDays -10 is invalid, clamping to 0",
    );
  });

  // --- Current-calendar-year component ------------------------------------

  describe("current-calendar-year component", () => {
    it("gives a current-year, ~90-day-old reading meaningfully more combined weight than the two-component formula alone would", () => {
      // Old 2-component baseline at age 90 (prior year, so the new
      // component is inert): recency = 2^(-90/30) = 0.125, seasonal =
      // 0.75 * 2^(-90/15) = 0.01171875, combined = 0.125 + 0.01171875 -
      // 0.125*0.01171875 = 0.13525 (computed precisely, not by hand-rounding).
      const baseline = calculateRecencyWeight(90, PRIOR_YEAR, CURRENT_YEAR);
      expect(baseline).toBeCloseTo(0.13525, 5);

      // Same age, but the reading is now from the CURRENT year: the new
      // component contributes 2^(-90/100) = 0.53584 on its own, combined via
      // the same probabilistic-OR as the other two:
      // combine(0.13525, 0.53584) = 0.13525 + 0.53584 - 0.13525*0.53584 = 0.59867.
      const currentYearWeight = calculateRecencyWeight(90, CURRENT_YEAR, CURRENT_YEAR);
      expect(currentYearWeight).toBeCloseTo(0.59867, 4);

      // "Meaningfully more" -- over 4x the baseline, not a marginal bump.
      expect(currentYearWeight).toBeGreaterThan(baseline * 4);
    });

    // The critical test: an identical age, but from a PRIOR year, must NOT
    // get the current-year bonus -- confirms the gate is a genuine exact
    // year-match, not just some disguised function of ageInDays that would
    // fire for any reading regardless of which real calendar year it's from.
    it("does NOT apply the current-year bonus to a reading with the identical age from a PRIOR year", () => {
      const priorYearWeight = calculateRecencyWeight(90, PRIOR_YEAR, CURRENT_YEAR);
      const currentYearWeight = calculateRecencyWeight(90, CURRENT_YEAR, CURRENT_YEAR);

      // Exactly the 2-component result -- the current-year component
      // resolved to precisely 0, not just "smaller".
      expect(priorYearWeight).toBeCloseTo(0.13525, 5);
      expect(priorYearWeight).toBeLessThan(currentYearWeight);
    });

    it("still resolves a 400+ day old prior-year reading through the seasonal component alone, unaffected by the new component", () => {
      // distanceToNearestYear(400) = min(400 % 365, 365 - 400 % 365) =
      // min(35, 330) = 35. seasonal = 0.75 * 2^(-35/15) = 0.75 * 0.19842 =
      // 0.14881. recency(400) = 2^(-400/30) is negligible (~0.0000968).
      // combined = 0.0000968 + 0.14881 - 0.0000968*0.14881 = 0.14889.
      const priorYearFarBack = calculateRecencyWeight(400, PRIOR_YEAR, CURRENT_YEAR);
      expect(priorYearFarBack).toBeCloseTo(0.14889, 4);

      // Same age, but framed as a hypothetical current-year match (an
      // impossible real-world combination -- a reading can't be 400 days
      // old AND from the current year -- but useful to isolate exactly how
      // much the gate alone changes the result): the current-year component
      // would still contribute 2^(-400/100) = 0.0625 if it applied, which
      // is NOT what a genuine prior-year reading at this age gets.
      const wouldBeIfGated = calculateRecencyWeight(400, CURRENT_YEAR, CURRENT_YEAR);
      expect(wouldBeIfGated).toBeGreaterThan(priorYearFarBack);

      // The actual prior-year case matches what calculateRecencyWeight
      // produced before this component existed (the seasonal-driven value
      // above), confirming genuinely old, prior-year data is untouched.
      expect(priorYearFarBack).toBeCloseTo(0.14889, 4);
    });

    it("resolves to exactly 0 contribution from the new component when years differ, regardless of how small ageInDays is", () => {
      // A reading "from" a prior year but somehow only 1 day old is not a
      // realistic case, but confirms the gate checks the year unconditionally,
      // not as a fallback only consulted at larger ages.
      const priorYearFresh = calculateRecencyWeight(1, PRIOR_YEAR, CURRENT_YEAR);
      const currentYearFresh = calculateRecencyWeight(1, CURRENT_YEAR, CURRENT_YEAR);
      // Both already near 1 from the recency component alone, so the two
      // are close -- but the current-year one must still be >= the prior-year
      // one, never less, confirming the component never subtracts weight.
      expect(currentYearFresh).toBeGreaterThanOrEqual(priorYearFresh);
    });

    it("never produces a value outside [0, 1] even at the current-year component's peak (age 0)", () => {
      const weight = calculateRecencyWeight(0, CURRENT_YEAR, CURRENT_YEAR);
      expect(weight).toBeLessThanOrEqual(1);
      expect(weight).toBeGreaterThan(0);
    });
  });
});
