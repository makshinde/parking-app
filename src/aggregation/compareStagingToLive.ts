import { parseAccumulatorBucketKey, type AccumulatorSnapshot } from "./incrementalWeightedStats.ts";
import { fetchAccumulatorBuckets, type ArchiveStreamAccumulatorBucketsSupabaseClient } from "./streamArchiveWithResume.ts";

// A richer, real comparison between a staging identity and the current
// live identity than verifyAccumulatorIntegrity's own bucket-count-ratio
// sanity check -- built specifically to let a human actually look at what
// the xkas-9n43 catch-up changed before ever considering promotion, not
// just confirm nothing looks structurally broken.

export interface BucketComparison {
  bucketKey: string;
  blockfaceId: string;
  isoDay: number;
  hour: number;
  liveCount: number;
  stagingCount: number;
  countDelta: number;
  liveMeanPct: number; // 0-100, for human readability
  stagingMeanPct: number;
  meanShiftPts: number; // staging - live, in percentage points
}

export interface InvalidBucket {
  bucketKey: string;
  identity: "live" | "staging";
  reason: string;
}

export interface HourWeekdayShiftSummary {
  isoDay: number;
  hour: number;
  bucketCount: number;
  meanAbsShiftPts: number;
  maxAbsShiftPts: number;
}

export interface StagingComparisonReport {
  totalLiveBuckets: number;
  totalStagingBuckets: number;
  newInStaging: number; // present in staging, absent from live (expected: new, previously-sub-threshold buckets that now have enough data)
  missingFromStaging: number; // present in live, absent from staging -- should be 0 if staging was seeded as a superset copy of live
  shrunkBuckets: BucketComparison[]; // stagingCount < liveCount -- should never happen; accumulators only ever grow
  invalidBuckets: InvalidBucket[]; // NaN/negative count, weight, mean, or variance in either identity
  countDeltaPercentiles: { p10: number; median: number; p90: number; max: number };
  meanShiftByHourWeekday: HourWeekdayShiftSummary[]; // one entry per (isoDay, hour) actually present in both
  largestShiftExamples: BucketComparison[]; // the real buckets with the biggest |meanShiftPts|, for a human to look at directly
}

const LARGEST_SHIFT_EXAMPLE_COUNT = 15;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] as number;
}

function findInvalid(snapshot: AccumulatorSnapshot, identity: "live" | "staging"): InvalidBucket[] {
  const invalid: InvalidBucket[] = [];
  for (const [bucketKey, acc] of Object.entries(snapshot)) {
    if (!Number.isFinite(acc.count) || acc.count < 0) invalid.push({ bucketKey, identity, reason: `count=${acc.count}` });
    else if (!Number.isFinite(acc.totalWeight) || acc.totalWeight < 0) invalid.push({ bucketKey, identity, reason: `totalWeight=${acc.totalWeight}` });
    else if (!Number.isFinite(acc.mean)) invalid.push({ bucketKey, identity, reason: `mean=${acc.mean}` });
    else if (!Number.isFinite(acc.sumSquaredDiff) || acc.sumSquaredDiff < 0) invalid.push({ bucketKey, identity, reason: `sumSquaredDiff=${acc.sumSquaredDiff}` });
  }
  return invalid;
}

export function compareStagingToLive(liveSnapshot: AccumulatorSnapshot, stagingSnapshot: AccumulatorSnapshot): StagingComparisonReport {
  const liveKeys = new Set(Object.keys(liveSnapshot));
  const stagingKeys = new Set(Object.keys(stagingSnapshot));

  const newInStaging = [...stagingKeys].filter((k) => !liveKeys.has(k)).length;
  const missingFromStaging = [...liveKeys].filter((k) => !stagingKeys.has(k)).length;

  const invalidBuckets = [...findInvalid(liveSnapshot, "live"), ...findInvalid(stagingSnapshot, "staging")];

  const comparisons: BucketComparison[] = [];
  for (const bucketKey of liveKeys) {
    const stagingAcc = stagingSnapshot[bucketKey];
    if (stagingAcc === undefined) continue; // covered by missingFromStaging above
    const liveAcc = liveSnapshot[bucketKey] as NonNullable<typeof liveSnapshot[string]>;
    const { blockfaceId, isoDay, hour } = parseAccumulatorBucketKey(bucketKey);
    comparisons.push({
      bucketKey,
      blockfaceId,
      isoDay,
      hour,
      liveCount: liveAcc.count,
      stagingCount: stagingAcc.count,
      countDelta: stagingAcc.count - liveAcc.count,
      liveMeanPct: liveAcc.mean * 100,
      stagingMeanPct: stagingAcc.mean * 100,
      meanShiftPts: (stagingAcc.mean - liveAcc.mean) * 100,
    });
  }

  const shrunkBuckets = comparisons.filter((c) => c.countDelta < 0);

  const sortedDeltas = comparisons.map((c) => c.countDelta).sort((a, b) => a - b);
  const countDeltaPercentiles = {
    p10: percentile(sortedDeltas, 0.1),
    median: percentile(sortedDeltas, 0.5),
    p90: percentile(sortedDeltas, 0.9),
    max: sortedDeltas.length > 0 ? (sortedDeltas[sortedDeltas.length - 1] as number) : 0,
  };

  const byHourWeekday = new Map<string, number[]>();
  for (const c of comparisons) {
    const key = `${c.isoDay}-${c.hour}`;
    const list = byHourWeekday.get(key) ?? [];
    list.push(Math.abs(c.meanShiftPts));
    byHourWeekday.set(key, list);
  }
  const meanShiftByHourWeekday: HourWeekdayShiftSummary[] = [...byHourWeekday.entries()]
    .map(([key, shifts]) => {
      const [isoDay, hour] = key.split("-").map(Number);
      return {
        isoDay: isoDay as number,
        hour: hour as number,
        bucketCount: shifts.length,
        meanAbsShiftPts: shifts.reduce((s, v) => s + v, 0) / shifts.length,
        maxAbsShiftPts: Math.max(...shifts),
      };
    })
    .sort((a, b) => (a.isoDay - b.isoDay) || (a.hour - b.hour));

  const largestShiftExamples = [...comparisons].sort((a, b) => Math.abs(b.meanShiftPts) - Math.abs(a.meanShiftPts)).slice(0, LARGEST_SHIFT_EXAMPLE_COUNT);

  return {
    totalLiveBuckets: liveKeys.size,
    totalStagingBuckets: stagingKeys.size,
    newInStaging,
    missingFromStaging,
    shrunkBuckets,
    invalidBuckets,
    countDeltaPercentiles,
    meanShiftByHourWeekday,
    largestShiftExamples,
  };
}

export async function compareStagingToLiveFromDb(
  client: ArchiveStreamAccumulatorBucketsSupabaseClient,
  liveIdentity: string,
  stagingIdentity: string,
): Promise<StagingComparisonReport> {
  const [liveSnapshot, stagingSnapshot] = await Promise.all([
    fetchAccumulatorBuckets(client, liveIdentity),
    fetchAccumulatorBuckets(client, stagingIdentity),
  ]);
  return compareStagingToLive(liveSnapshot, stagingSnapshot);
}
