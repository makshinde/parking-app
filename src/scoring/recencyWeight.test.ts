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

  // The baseline every guarantee test below is measured against: a
  // prior-year reading sitting exactly on its seasonal peak (age 365,
  // distance 0 from the anniversary). Computed once, precisely, rather than
  // repeated as a hand-rounded literal in every test.
  const SEASONAL_PEAK_BASELINE = calculateRecencyWeight(365, PRIOR_YEAR, CURRENT_YEAR);

  describe("current-calendar-year component", () => {
    it("SEASONAL_PEAK_BASELINE is the real, precise value every guarantee below is measured against", () => {
      expect(SEASONAL_PEAK_BASELINE).toBeCloseTo(0.75005, 5);
    });

    it("gives a current-year, ~90-day-old reading meaningfully more combined weight than the two-component formula alone would", () => {
      // Old 2-component baseline at age 90 (prior year, so the new
      // component is inert): recency = 2^(-90/30) = 0.125, seasonal =
      // 0.75 * 2^(-90/15) = 0.01171875, combined = 0.125 + 0.01171875 -
      // 0.125*0.01171875 = 0.13525 (computed precisely, not by hand-rounding).
      const baseline = calculateRecencyWeight(90, PRIOR_YEAR, CURRENT_YEAR);
      expect(baseline).toBeCloseTo(0.13525, 5);

      // Same age, but the reading is now from the CURRENT year: the new
      // component contributes CURRENT_YEAR_PEAK_WEIGHT * 2^(-90/120) =
      // 4.0 * 0.59460 = 2.37841 on its own (deliberately > 1 -- see
      // recencyWeight.ts's own comment), combined via the same
      // probabilistic-OR as the other two: combine(0.13525, 2.37841) =
      // 0.13525 + 2.37841 - 0.13525*2.37841 = 2.19198.
      const currentYearWeight = calculateRecencyWeight(90, CURRENT_YEAR, CURRENT_YEAR);
      expect(currentYearWeight).toBeCloseTo(2.19198, 4);

      // "Meaningfully more" -- over 16x the baseline, not a marginal bump.
      expect(currentYearWeight).toBeGreaterThan(baseline * 16);
    });

    // The critical test: an identical age, but from a PRIOR year, must NOT
    // get the current-year bonus -- confirms the gate is a genuine exact
    // year-match, not just some disguised function of ageInDays that would
    // fire for any reading regardless of which real calendar year it's from.
    it("does NOT apply the current-year bonus to a reading with the identical age from a PRIOR year", () => {
      const priorYearWeight = calculateRecencyWeight(90, PRIOR_YEAR, CURRENT_YEAR);
      const currentYearWeight = calculateRecencyWeight(90, CURRENT_YEAR, CURRENT_YEAR);

      // Exactly the 2-component result -- the current-year component
      // resolved to precisely 0, not just "smaller". This value is
      // unchanged by CURRENT_YEAR_PEAK_WEIGHT entirely -- raising that
      // constant moves current-year weights, never prior-year ones.
      expect(priorYearWeight).toBeCloseTo(0.13525, 5);
      expect(priorYearWeight).toBeLessThan(currentYearWeight);
    });

    it("still resolves a 400+ day old prior-year reading through the seasonal component alone, unaffected by the new component or its peak weight", () => {
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
      // would still contribute 4.0 * 2^(-400/120) = 0.39685 if it applied,
      // giving a combined 0.48666 -- NOT what a genuine prior-year reading
      // at this age gets.
      const wouldBeIfGated = calculateRecencyWeight(400, CURRENT_YEAR, CURRENT_YEAR);
      expect(wouldBeIfGated).toBeCloseTo(0.48666, 4);
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
      expect(priorYearFresh).toBeLessThan(1);
      // The current-year one now genuinely exceeds 1 -- CURRENT_YEAR_PEAK_WEIGHT
      // (4.0) makes the raw current-year component at 1 day old (~3.977)
      // large enough to push the combined result above 1, unlike the old
      // (peak=1.0) design where every value stayed capped at 1.
      expect(currentYearFresh).toBeGreaterThan(1);
      expect(currentYearFresh).toBeGreaterThan(priorYearFresh);
    });

    // At exactly age=0, recency(0) = 2^0 = 1 exactly, and combine(1, y) =
    // 1 + y - y = 1 for ANY y -- so the very first combine (recency with
    // seasonal) already saturates the result to exactly 1, before the
    // current-year component (however large) ever gets a chance to push it
    // higher. This is a genuine, hand-verifiable invariant, not a design
    // limitation: the current-year component's real effect shows up at any
    // age > 0, once recency itself is no longer exactly 1 (see the age=1
    // test above, where the combined result already exceeds 1).
    it("resolves to exactly 1 at age=0, regardless of year or peak weight, since recency(0) itself already saturates the combine", () => {
      expect(calculateRecencyWeight(0, PRIOR_YEAR, CURRENT_YEAR)).toBe(1);
      expect(calculateRecencyWeight(0, CURRENT_YEAR, CURRENT_YEAR)).toBe(1);
    });

    // The guarantee this whole component's peak weight was solved for: even
    // the oldest current-year reading expected in practice (~270 days, the
    // age Q1 2026 data reaches roughly three-quarters through the year)
    // must still outweigh a prior-year reading sitting exactly on its
    // seasonal peak -- the strongest possible prior-year competitor.
    it("guarantees a ~270-day-old current-year reading (the oldest realistic case) outweighs a prior-year reading exactly at its seasonal peak", () => {
      const oldestRealisticCurrentYear = calculateRecencyWeight(270, CURRENT_YEAR, CURRENT_YEAR);
      expect(oldestRealisticCurrentYear).toBeCloseTo(0.84268, 4);
      expect(oldestRealisticCurrentYear).toBeGreaterThan(SEASONAL_PEAK_BASELINE);
    });

    // The same guarantee, confirmed at every distance requested, not just
    // the worst-case edge -- current-year data must structurally outweigh
    // the strongest possible prior-year competitor everywhere in this
    // range, not only right at the boundary it was solved for.
    it.each([
      [30, 1.96021],
      [90, 2.19198],
      [150, 1.66000],
      [240, 1.0], // mathematically exact (4.0 * 2^(-240/120) = 1.0, and combine(x, 1) = 1 for any x)
      // but not floating-point bit-exact (live-checked: 0.9999999999999999,
      // 1 ULP off) -- toBeCloseTo below, not toBe, is deliberate here.
      [270, 0.84268],
    ])("current-year weight at age=%i days (%f) exceeds the seasonal-peak baseline", (age, expected) => {
      const weight = calculateRecencyWeight(age, CURRENT_YEAR, CURRENT_YEAR);
      expect(weight).toBeCloseTo(expected, 4);
      expect(weight).toBeGreaterThan(SEASONAL_PEAK_BASELINE);
    });
  });
});
