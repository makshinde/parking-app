import type { AccumulatorSnapshot } from "./incrementalWeightedStats.ts";
import { parseAccumulatorBucketKey } from "./incrementalWeightedStats.ts";
import { fetchAccumulatorBuckets, type ArchiveStreamAccumulatorBucketsSupabaseClient } from "./streamArchiveWithResume.ts";
import { decideBucketStatsFromAccumulator } from "./decideBucketStats.ts";
import type { BucketStats } from "./decideBucketStats.ts";
import type { SupabaseQueryResult } from "../importers/upsertBlockface.ts";
import type { OccupancyStatsRow } from "./upsertOccupancyStats.ts";

// Makes CLAUDE.md's "Rebuild policy" promote step 3 ("internal-consistency
// sanity checks on every bucket, not just a row-count match") and step 4
// ("the same systematic occupancy_stats-vs-accumulator comparison... to
// confirm zero stale rows") into real, reusable, tested code for the first
// time -- previously done ad hoc, by hand, during the one proven Q1 2026
// ingestion (see CLAUDE.md's "RESOLVED" note on the 7c2e-uany accumulator
// for what that comparison actually looked like).

// --- Per-bucket sanity checks ----------------------------------------------

export interface BucketProblem {
  bucketKey: string;
  reason: string;
}

export interface IntegrityCheckResult {
  ok: boolean;
  bucketCount: number;
  compareBucketCount: number | null;
  problems: BucketProblem[];
}

// A real WeightedStatsAccumulator (see incrementalWeightedStats.ts) can
// never legitimately have a negative count/totalWeight/sumSquaredDiff, or a
// non-finite value in any field -- addReading's own assertValidReading
// already rejects a non-finite/negative value or weight at fold time, so
// any row failing these checks signals real corruption somewhere between
// folding and persistence, not a normal data edge case.
function findBucketProblems(bucketKey: string, accumulator: AccumulatorSnapshot[string]): string | null {
  if (!Number.isFinite(accumulator.count) || accumulator.count < 0) {
    return `count is invalid: ${accumulator.count}`;
  }
  if (!Number.isFinite(accumulator.totalWeight) || accumulator.totalWeight < 0) {
    return `totalWeight is invalid: ${accumulator.totalWeight}`;
  }
  if (!Number.isFinite(accumulator.mean)) {
    return `mean is invalid: ${accumulator.mean}`;
  }
  if (!Number.isFinite(accumulator.sumSquaredDiff) || accumulator.sumSquaredDiff < 0) {
    return `sumSquaredDiff is invalid: ${accumulator.sumSquaredDiff}`;
  }
  return null;
}

// How far a staging identity's bucket count may differ from the current
// live identity's before it's flagged as a likely sign of a catastrophic
// partial run (e.g. one of the two folds silently didn't run, or ran
// against the wrong source) -- not a precise statistical bound, a coarse
// sanity guard. 20% is generous (real week-to-week bucket-count drift from
// ordinary data changes is expected to be far smaller than this) while
// still catching an order-of-magnitude-wrong run.
const BUCKET_COUNT_TOLERANCE_FRACTION = 0.2;

function checkBucketCountRatio(stagingCount: number, compareCount: number): string | null {
  if (compareCount === 0) {
    // Nothing to compare against (e.g. the very first run ever for this
    // identity) -- a staging count of 0 would still be caught by the
    // caller treating a wholly-empty staging snapshot as its own failure,
    // so this isn't a case this ratio check needs to handle.
    return null;
  }
  const lowerBound = compareCount * (1 - BUCKET_COUNT_TOLERANCE_FRACTION);
  const upperBound = compareCount * (1 + BUCKET_COUNT_TOLERANCE_FRACTION);
  if (stagingCount < lowerBound || stagingCount > upperBound) {
    return `staging bucket count (${stagingCount}) is outside +/-${BUCKET_COUNT_TOLERANCE_FRACTION * 100}% of the current live identity's bucket count (${compareCount})`;
  }
  return null;
}

// Verifies a freshly-folded staging identity before it's ever eligible for
// promotion. compareAgainstIdentity is the CURRENT live identity to sanity-
// check the staging bucket count against -- null only for a genuinely
// first-ever run (no live identity exists yet to compare against).
export async function verifyAccumulatorIntegrity(
  client: ArchiveStreamAccumulatorBucketsSupabaseClient,
  stagingIdentity: string,
  compareAgainstIdentity: string | null,
): Promise<IntegrityCheckResult> {
  const stagingSnapshot = await fetchAccumulatorBuckets(client, stagingIdentity);
  const problems: BucketProblem[] = [];

  for (const [bucketKey, accumulator] of Object.entries(stagingSnapshot)) {
    const reason = findBucketProblems(bucketKey, accumulator);
    if (reason !== null) {
      problems.push({ bucketKey, reason });
    }
  }

  const bucketCount = Object.keys(stagingSnapshot).length;
  let compareBucketCount: number | null = null;
  if (compareAgainstIdentity !== null) {
    const compareSnapshot = await fetchAccumulatorBuckets(client, compareAgainstIdentity);
    compareBucketCount = Object.keys(compareSnapshot).length;
    const ratioProblem = checkBucketCountRatio(bucketCount, compareBucketCount);
    if (ratioProblem !== null) {
      problems.push({ bucketKey: "(whole staging identity)", reason: ratioProblem });
    }
  }

  return { ok: problems.length === 0, bucketCount, compareBucketCount, problems };
}

// --- occupancy_stats vs. accumulator comparison ---------------------------

export interface StaleRowSample {
  blockfaceId: string;
  isoDay: number;
  hour: number;
  reason: string;
}

export interface StaleRowReport {
  totalOccupancyStatsRows: number;
  staleCount: number;
  // Capped (see MAX_STALE_SAMPLES below) -- this is a sanity report for a
  // human to read, not a full dump of every mismatch.
  staleSamples: StaleRowSample[];
}

const MAX_STALE_SAMPLES = 20;

// A mean/stdDev float derived from the accumulator should match what's
// already written to occupancy_stats closely, but not bit-for-bit (two
// independently-computed floating-point paths) -- this matches CLAUDE.md's
// own real-world finding of a 1-in-105,608 benign off-by-one count due to a
// live, concurrently-updating accumulator, not a meaningful tolerance
// chosen for its own sake.
const MEAN_TOLERANCE = 1e-6;
const STD_DEV_TOLERANCE = 1e-6;

function statsMatch(expected: BucketStats, actual: OccupancyStatsRow): boolean {
  return (
    actual.sample_count === expected.sampleCount &&
    Math.abs(actual.mean_occupancy - expected.mean) < MEAN_TOLERANCE &&
    Math.abs(actual.std_dev - expected.stdDev) < STD_DEV_TOLERANCE
  );
}

export interface OccupancyStatsBulkReadQueryBuilder extends PromiseLike<SupabaseQueryResult<OccupancyStatsRow[]>> {
  range(from: number, to: number): PromiseLike<SupabaseQueryResult<OccupancyStatsRow[]>>;
}

export interface OccupancyStatsBulkReadSupabaseTableBuilder {
  select(columns: string): OccupancyStatsBulkReadQueryBuilder;
}

export interface OccupancyStatsBulkReadSupabaseClient {
  from(table: string): OccupancyStatsBulkReadSupabaseTableBuilder;
}

const OCCUPANCY_STATS_READ_PAGE_SIZE = 1000;

async function fetchAllOccupancyStats(client: OccupancyStatsBulkReadSupabaseClient): Promise<OccupancyStatsRow[]> {
  const allRows: OccupancyStatsRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from("occupancy_stats")
      .select("id, blockface_id, day_of_week, hour_of_day, mean_occupancy, std_dev, sample_count")
      .range(from, from + OCCUPANCY_STATS_READ_PAGE_SIZE - 1);
    if (error !== null) {
      throw new Error(`compareOccupancyStatsToAccumulator: reading occupancy_stats failed: ${error.message}`);
    }
    const page = data ?? [];
    allRows.push(...page);
    if (page.length < OCCUPANCY_STATS_READ_PAGE_SIZE) break;
    from += OCCUPANCY_STATS_READ_PAGE_SIZE;
  }
  return allRows;
}

// The final, post-reconcile check: every row currently in occupancy_stats
// should match what the now-promoted accumulator identity would itself
// produce for that same bucket. A mismatch here is exactly what CLAUDE.md's
// one real, live-found stale row looked like (see its "RESOLVED" note) --
// this makes that same comparison a real, reusable, always-run step instead
// of a one-off manual investigation.
export async function compareOccupancyStatsToAccumulator(
  accumulatorClient: ArchiveStreamAccumulatorBucketsSupabaseClient,
  occupancyStatsClient: OccupancyStatsBulkReadSupabaseClient,
  stableIdentity: string,
): Promise<StaleRowReport> {
  const [accumulatorSnapshot, occupancyStatsRows] = await Promise.all([
    fetchAccumulatorBuckets(accumulatorClient, stableIdentity),
    fetchAllOccupancyStats(occupancyStatsClient),
  ]);

  const staleSamples: StaleRowSample[] = [];
  let staleCount = 0;

  for (const row of occupancyStatsRows) {
    const bucketKey = `${row.blockface_id}:${row.day_of_week}:${row.hour_of_day}`;
    const accumulator = accumulatorSnapshot[bucketKey];

    if (accumulator === undefined) {
      staleCount += 1;
      if (staleSamples.length < MAX_STALE_SAMPLES) {
        staleSamples.push({ blockfaceId: row.blockface_id, isoDay: row.day_of_week, hour: row.hour_of_day, reason: "no matching bucket in the promoted accumulator at all" });
      }
      continue;
    }

    const expected = decideBucketStatsFromAccumulator(accumulator);
    if (expected === null) {
      staleCount += 1;
      if (staleSamples.length < MAX_STALE_SAMPLES) {
        staleSamples.push({ blockfaceId: row.blockface_id, isoDay: row.day_of_week, hour: row.hour_of_day, reason: "accumulator bucket now has too few readings to justify this occupancy_stats row at all" });
      }
      continue;
    }

    if (!statsMatch(expected, row)) {
      staleCount += 1;
      if (staleSamples.length < MAX_STALE_SAMPLES) {
        staleSamples.push({
          blockfaceId: row.blockface_id,
          isoDay: row.day_of_week,
          hour: row.hour_of_day,
          reason: `occupancy_stats has mean=${row.mean_occupancy}/stdDev=${row.std_dev}/count=${row.sample_count}, accumulator says mean=${expected.mean}/stdDev=${expected.stdDev}/count=${expected.sampleCount}`,
        });
      }
    }
  }

  return { totalOccupancyStatsRows: occupancyStatsRows.length, staleCount, staleSamples };
}

// Re-exported purely so callers of this module don't also need to import
// parseAccumulatorBucketKey from incrementalWeightedStats.ts separately for
// the (admittedly rare) case of wanting to inspect a raw BucketProblem's
// bucketKey further.
export { parseAccumulatorBucketKey };
