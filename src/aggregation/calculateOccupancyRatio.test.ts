import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calculateOccupancyRatio } from "./calculateOccupancyRatio";

describe("calculateOccupancyRatio", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns a normal in-range ratio", () => {
    expect(calculateOccupancyRatio(3, 8)).toBe(3 / 8);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns exactly 0 for zero occupancy", () => {
    expect(calculateOccupancyRatio(0, 8)).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns exactly 1.0 for exactly full occupancy, without clamping or warning", () => {
    expect(calculateOccupancyRatio(8, 8)).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("clamps to 1.0 and logs a warning with both raw values when occupancy exceeds capacity", () => {
    const result = calculateOccupancyRatio(10, 8);

    expect(result).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("paidOccupancy=10");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("parkingSpaceCount=8");
  });

  it("throws for zero parkingSpaceCount -- no meaningful ratio for zero capacity", () => {
    expect(() => calculateOccupancyRatio(0, 0)).toThrow(/parkingSpaceCount must be a positive number/);
  });

  it("throws for negative parkingSpaceCount", () => {
    expect(() => calculateOccupancyRatio(2, -5)).toThrow(/parkingSpaceCount must be a positive number/);
  });

  it("throws for non-finite parkingSpaceCount", () => {
    expect(() => calculateOccupancyRatio(2, NaN)).toThrow(/parkingSpaceCount must be a positive number/);
    expect(() => calculateOccupancyRatio(2, Infinity)).toThrow(/parkingSpaceCount must be a positive number/);
  });

  // Negative occupancy: treated as clampable (continuous/estimated), not
  // structurally invalid, matching recencyWeight.ts's clampAgeInDays
  // precedent -- a negative reading can't reflect a real physical count, but
  // unlike parkingSpaceCount <= 0 (no meaningful "nearest valid" capacity
  // exists) or a non-finite value (no direction to clamp in at all), 0 is a
  // clear, meaningful nearest-valid occupancy to fall back to. Clamped and
  // logged, same as the exceeds-capacity case, rather than thrown.
  it("clamps negative occupancy to 0 and logs a warning, rather than throwing", () => {
    const result = calculateOccupancyRatio(-2, 8);

    expect(result).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("-2");
  });

  it("throws for non-finite paidOccupancy", () => {
    expect(() => calculateOccupancyRatio(NaN, 8)).toThrow(/paidOccupancy must be a finite number/);
    expect(() => calculateOccupancyRatio(Infinity, 8)).toThrow(/paidOccupancy must be a finite number/);
  });
});
