import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calculateConfidenceScore } from "./confidenceScore";

describe("calculateConfidenceScore", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("gives the maximum score for abundant, consistent, same-day data", () => {
    expect(calculateConfidenceScore(200, 0, 0)).toBe(10);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("gives the minimum score for scarce, volatile, far-future data", () => {
    // Sample and consistency bottom out at 0, but recency has a floor of 1
    // point even a full week out, so 1 is the true minimum, not 0.
    expect(calculateConfidenceScore(0, 1, 7)).toBe(1);
  });

  it("scales sample size proportionally below the saturation count", () => {
    // 100/200 samples -> half of the 4 sample points -> 2
    // perfect consistency -> 4, today -> 2. Total 8.
    expect(calculateConfidenceScore(100, 0, 0)).toBe(8);
  });

  it("treats sample counts at or above the saturation point the same", () => {
    const atSaturation = calculateConfidenceScore(200, 0.5, 3);
    const wellAboveSaturation = calculateConfidenceScore(5000, 0.5, 3);
    expect(wellAboveSaturation).toBe(atSaturation);
  });

  it("rewards lower std_dev with a higher score", () => {
    const consistent = calculateConfidenceScore(200, 0.1, 0);
    const volatile = calculateConfidenceScore(200, 0.9, 0);
    expect(consistent).toBeGreaterThan(volatile);
  });

  it("tapers the recency contribution as days_in_future increases", () => {
    const today = calculateConfidenceScore(200, 0, 0);
    const midWeek = calculateConfidenceScore(200, 0, 3);
    const weekOut = calculateConfidenceScore(200, 0, 7);
    expect(today).toBeGreaterThanOrEqual(midWeek);
    expect(midWeek).toBeGreaterThanOrEqual(weekOut);
  });

  it("rounds to the nearest whole number", () => {
    // sample: 50/200 * 4 = 1, consistency: (1-0.4)*4 = 2.4, recency day 2: 2 - (2/7)*1 = 1.7143
    // total = 5.1143 -> rounds to 5
    expect(calculateConfidenceScore(50, 0.4, 2)).toBe(5);
  });

  it("clamps negative sample counts to zero contribution instead of going negative, and logs a warning", () => {
    // Sample contributes 0 and consistency contributes 0 (std_dev of 1), leaving
    // only the recency floor of 1 point.
    expect(calculateConfidenceScore(-50, 1, 7)).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "confidenceScore: sample_count -50 is invalid, clamping to 0",
    );
  });

  it("clamps out-of-range std_dev instead of producing an invalid score, and logs a warning", () => {
    const belowRange = calculateConfidenceScore(200, -0.5, 0);
    expect(belowRange).toBe(10);
    expect(warnSpy).toHaveBeenCalledWith(
      "confidenceScore: std_dev -0.5 is invalid, clamping to 0",
    );

    warnSpy.mockClear();

    const aboveRange = calculateConfidenceScore(200, 1.5, 0);
    expect(aboveRange).toBe(6); // sample 4 + consistency 0 + recency 2
    expect(warnSpy).toHaveBeenCalledWith(
      "confidenceScore: std_dev 1.5 is invalid, clamping to 1",
    );
  });

  it("clamps out-of-range days_in_future instead of extrapolating, and logs a warning", () => {
    const beforeToday = calculateConfidenceScore(200, 0, -3);
    expect(beforeToday).toBe(10);
    expect(warnSpy).toHaveBeenCalledWith(
      "confidenceScore: days_in_future -3 is invalid, clamping to 0",
    );

    warnSpy.mockClear();

    const beyondAWeek = calculateConfidenceScore(200, 0, 30);
    expect(beyondAWeek).toBe(9); // sample 4 + consistency 4 + recency floor 1
    expect(warnSpy).toHaveBeenCalledWith(
      "confidenceScore: days_in_future 30 is invalid, clamping to 7",
    );
  });

  it("never returns a score outside the 0-10 range, and logs a warning for every invalid input", () => {
    const score = calculateConfidenceScore(1000, -1, -10);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(10);
    expect(warnSpy).toHaveBeenCalledWith(
      "confidenceScore: sample_count 1000 is invalid, clamping to 200",
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "confidenceScore: std_dev -1 is invalid, clamping to 0",
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "confidenceScore: days_in_future -10 is invalid, clamping to 0",
    );
  });
});
