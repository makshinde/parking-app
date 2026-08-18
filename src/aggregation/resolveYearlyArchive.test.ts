import { describe, expect, it } from "vitest";
import { getPriorYear, resolveYearlyArchiveDatasetId } from "./resolveYearlyArchive";

describe("resolveYearlyArchiveDatasetId", () => {
  it("resolves 2020 to its live-verified dataset ID", () => {
    expect(resolveYearlyArchiveDatasetId(2020)).toBe("wtpb-jp8d");
  });

  it("resolves 2025 to its live-verified dataset ID", () => {
    expect(resolveYearlyArchiveDatasetId(2025)).toBe("7c2e-uany");
  });

  it("throws a clear, informative error for an unverified year, naming the year and listing what's available", () => {
    expect(() => resolveYearlyArchiveDatasetId(2023)).toThrow(
      /no live-verified Socrata dataset ID for year 2023.*Available years: 2020, 2025/s,
    );
  });

  it("does not guess at an unverified year even when it's plausible/nearby", () => {
    expect(() => resolveYearlyArchiveDatasetId(2021)).toThrow(/year 2021/);
    expect(() => resolveYearlyArchiveDatasetId(2026)).toThrow(/year 2026/);
  });
});

describe("getPriorYear", () => {
  it("returns the year before a real date in 2026", () => {
    expect(getPriorYear(new Date("2026-07-30T12:00:00Z"))).toBe(2025);
  });

  it("returns the year before a real date in 2021", () => {
    expect(getPriorYear(new Date("2021-01-01T00:00:00Z"))).toBe(2020);
  });

  it("returns the year before a real date near a year boundary, using the UTC year", () => {
    // 2025-12-31T23:00:00Z is still December 31st in UTC (even though it's
    // already Dec 31 evening / Jan 1 in some other timezones) -- UTC year
    // is 2025, so the prior year is 2024.
    expect(getPriorYear(new Date("2025-12-31T23:00:00Z"))).toBe(2024);
  });

  it("throws for an invalid Date", () => {
    expect(() => getPriorYear(new Date("not-a-date"))).toThrow(/invalid Date/);
  });
});
