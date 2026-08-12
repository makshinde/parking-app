import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calculateRecencyWeight } from "./recencyWeight";

describe("calculateRecencyWeight", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("scores a very recent reading near 1", () => {
    expect(calculateRecencyWeight(1)).toBeGreaterThan(0.98);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("scores a reading from about a year ago near 0.75", () => {
    // recency(365) is negligible (2^-12.17), so the ~0.75 result comes almost
    // entirely from the seasonal component peaking at its yearly anniversary.
    expect(calculateRecencyWeight(365)).toBeCloseTo(0.75, 2);
  });

  it("combines moderate recency and moderate seasonal alignment into something higher than either alone", () => {
    // At 30 days: recency = 2^(-30/30) = 0.5, seasonal = 0.75 * 2^(-30/15) = 0.1875
    // (distance to the day-0 anniversary is 30 days). Neither is dominant on
    // its own, which is exactly the case the combined formula is meant for.
    const weight = calculateRecencyWeight(30);
    expect(weight).toBeCloseTo(0.59375, 5);
    // The whole point of a+b-ab over max(a,b): this must beat the larger
    // component (recency, 0.5) alone, not just match it.
    expect(weight).toBeGreaterThan(0.5);
  });

  it("scores a reading with neither recency nor seasonal alignment low", () => {
    // 180 days is far past the recency half-life and roughly at the
    // midpoint between yearly anniversaries (max possible distance).
    expect(calculateRecencyWeight(180)).toBeLessThan(0.05);
  });

  it("clamps negative ageInDays to 0 and logs a warning", () => {
    const weight = calculateRecencyWeight(-10);
    expect(weight).toBeCloseTo(calculateRecencyWeight(0), 10);
    expect(warnSpy).toHaveBeenCalledWith(
      "calculateRecencyWeight: ageInDays -10 is invalid, clamping to 0",
    );
  });
});
