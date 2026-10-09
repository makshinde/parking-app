import { describe, expect, it } from "vitest";
import { compareStagingToLive } from "./compareStagingToLive.ts";
import type { AccumulatorSnapshot } from "./incrementalWeightedStats.ts";
import { buildAccumulatorBucketKey } from "./incrementalWeightedStats.ts";

function acc(count: number, totalWeight: number, mean: number, sumSquaredDiff: number) {
  return { count, totalWeight, mean, sumSquaredDiff };
}

describe("compareStagingToLive", () => {
  it("reports real, unchanged counts/means as zero delta for an identical copy", () => {
    const key = buildAccumulatorBucketKey("bf-1", 2, 14);
    const live: AccumulatorSnapshot = { [key]: acc(100, 80, 0.4, 2) };
    const staging: AccumulatorSnapshot = { [key]: acc(100, 80, 0.4, 2) };

    const report = compareStagingToLive(live, staging);

    expect(report.totalLiveBuckets).toBe(1);
    expect(report.totalStagingBuckets).toBe(1);
    expect(report.newInStaging).toBe(0);
    expect(report.missingFromStaging).toBe(0);
    expect(report.shrunkBuckets).toHaveLength(0);
    expect(report.invalidBuckets).toHaveLength(0);
    expect(report.largestShiftExamples[0]).toMatchObject({ meanShiftPts: 0, countDelta: 0 });
  });

  it("flags a real bucket present in live but missing from staging -- should never happen if staging was seeded as a copy", () => {
    const key = buildAccumulatorBucketKey("bf-1", 2, 14);
    const live: AccumulatorSnapshot = { [key]: acc(100, 80, 0.4, 2) };
    const staging: AccumulatorSnapshot = {};

    const report = compareStagingToLive(live, staging);

    expect(report.missingFromStaging).toBe(1);
  });

  it("counts a real new bucket in staging that didn't exist in live -- expected when a previously-sub-threshold bucket crosses MIN_READINGS_PER_BUCKET after the catch-up fold", () => {
    const key = buildAccumulatorBucketKey("bf-new", 3, 9);
    const report = compareStagingToLive({}, { [key]: acc(31, 25, 0.3, 1) });
    expect(report.newInStaging).toBe(1);
  });

  it("flags a real bucket that shrank -- a structural impossibility for an additive accumulator", () => {
    const key = buildAccumulatorBucketKey("bf-1", 2, 14);
    const live: AccumulatorSnapshot = { [key]: acc(500, 400, 0.4, 2) };
    const staging: AccumulatorSnapshot = { [key]: acc(100, 80, 0.4, 2) }; // count went DOWN

    const report = compareStagingToLive(live, staging);

    expect(report.shrunkBuckets).toHaveLength(1);
    expect(report.shrunkBuckets[0]).toMatchObject({ liveCount: 500, stagingCount: 100, countDelta: -400 });
  });

  it("flags a real NaN or negative value in either identity", () => {
    const k1 = buildAccumulatorBucketKey("bf-nan", 1, 1);
    const k2 = buildAccumulatorBucketKey("bf-neg", 1, 2);
    const live: AccumulatorSnapshot = { [k1]: acc(100, 80, NaN, 2) };
    const staging: AccumulatorSnapshot = { [k1]: acc(100, 80, 0.4, 2), [k2]: acc(100, -5, 0.4, 2) };

    const report = compareStagingToLive(live, staging);

    expect(report.invalidBuckets).toContainEqual({ bucketKey: k1, identity: "live", reason: "mean=NaN" });
    expect(report.invalidBuckets).toContainEqual({ bucketKey: k2, identity: "staging", reason: "totalWeight=-5" });
  });

  it("breaks the mean shift out by real (isoDay, hour), and surfaces the largest real shifts as examples", () => {
    const keyMon9 = buildAccumulatorBucketKey("bf-1", 1, 9);
    const keyMon9b = buildAccumulatorBucketKey("bf-2", 1, 9);
    const keyWed14 = buildAccumulatorBucketKey("bf-3", 3, 14);

    const live: AccumulatorSnapshot = {
      [keyMon9]: acc(100, 80, 0.3, 2),
      [keyMon9b]: acc(100, 80, 0.32, 2),
      [keyWed14]: acc(100, 80, 0.5, 2),
    };
    const staging: AccumulatorSnapshot = {
      [keyMon9]: acc(120, 95, 0.31, 2), // +1pt shift
      [keyMon9b]: acc(120, 95, 0.30, 2), // -2pt shift
      [keyWed14]: acc(120, 95, 0.9, 2), // +40pt shift -- the big one
    };

    const report = compareStagingToLive(live, staging);

    const mon9Summary = report.meanShiftByHourWeekday.find((s) => s.isoDay === 1 && s.hour === 9);
    expect(mon9Summary?.bucketCount).toBe(2);
    expect(mon9Summary?.maxAbsShiftPts).toBeCloseTo(2, 5);

    const wed14Summary = report.meanShiftByHourWeekday.find((s) => s.isoDay === 3 && s.hour === 14);
    expect(wed14Summary?.meanAbsShiftPts).toBeCloseTo(40, 5);

    expect(report.largestShiftExamples[0]).toMatchObject({ bucketKey: keyWed14, meanShiftPts: 40 });
  });

  it("computes real count-delta percentiles across every matched bucket", () => {
    const live: AccumulatorSnapshot = {};
    const staging: AccumulatorSnapshot = {};
    const deltas = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    deltas.forEach((delta, i) => {
      const key = buildAccumulatorBucketKey(`bf-${i}`, 1, 9);
      live[key] = acc(1000, 800, 0.4, 2);
      staging[key] = acc(1000 + delta, 800 + delta, 0.4, 2);
    });

    const report = compareStagingToLive(live, staging);

    expect(report.countDeltaPercentiles.max).toBe(100);
    expect(report.countDeltaPercentiles.median).toBe(50);
  });

  it("returns real, zero-valued empty-state fields for two empty snapshots", () => {
    const report = compareStagingToLive({}, {});
    expect(report).toMatchObject({ totalLiveBuckets: 0, totalStagingBuckets: 0, newInStaging: 0, missingFromStaging: 0, shrunkBuckets: [], invalidBuckets: [] });
  });
});
