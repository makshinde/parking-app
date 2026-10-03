import { describe, expect, it } from "vitest";
import { compareOccupancyStatsToAccumulator, verifyAccumulatorIntegrity } from "./accumulatorIntegrity.ts";
import type { ArchiveStreamAccumulatorBucketsSupabaseClient } from "./streamArchiveWithResume.ts";
import type { OccupancyStatsBulkReadSupabaseClient } from "./accumulatorIntegrity.ts";

interface RawBucketRow {
  archive_dataset_id: string;
  blockface_id: string;
  iso_day: number;
  hour: number;
  count: number;
  total_weight: number;
  mean: number;
  sum_squared_diff: number;
}

function makeMockAccumulatorBucketsClient(rows: RawBucketRow[]): ArchiveStreamAccumulatorBucketsSupabaseClient {
  return {
    from: () => ({
      select: () => {
        let filterArchiveDatasetId: string | undefined;
        const builder = {
          eq: (_column: string, value: string) => {
            filterArchiveDatasetId = value;
            return builder;
          },
          order: () => builder,
          range: async (from: number, to: number) => {
            const filtered = rows.filter((row) => row.archive_dataset_id === filterArchiveDatasetId);
            return { data: filtered.slice(from, to + 1), error: null };
          },
        };
        return builder;
      },
      upsert: async () => ({ data: null, error: null }),
    }),
  } as unknown as ArchiveStreamAccumulatorBucketsSupabaseClient;
}

function bucketRow(overrides: Partial<RawBucketRow> & { archive_dataset_id: string; blockface_id: string }): RawBucketRow {
  return {
    iso_day: 2,
    hour: 14,
    count: 100,
    total_weight: 80,
    mean: 0.4,
    sum_squared_diff: 2,
    ...overrides,
  };
}

describe("verifyAccumulatorIntegrity", () => {
  it("reports ok=true for a real, clean staging snapshot with no comparison identity", async () => {
    const client = makeMockAccumulatorBucketsClient([
      bucketRow({ archive_dataset_id: "staging-1", blockface_id: "bf-1" }),
      bucketRow({ archive_dataset_id: "staging-1", blockface_id: "bf-2" }),
    ]);

    const result = await verifyAccumulatorIntegrity(client, "staging-1", null);

    expect(result).toEqual({ ok: true, bucketCount: 2, compareBucketCount: null, problems: [] });
  });

  it("flags a bucket with a negative count as a real problem, not silently ignored", async () => {
    const client = makeMockAccumulatorBucketsClient([
      bucketRow({ archive_dataset_id: "staging-1", blockface_id: "bf-1", count: -5 }),
    ]);

    const result = await verifyAccumulatorIntegrity(client, "staging-1", null);

    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.reason).toMatch(/count is invalid/);
  });

  it("flags a non-finite mean/totalWeight/sumSquaredDiff", async () => {
    const client = makeMockAccumulatorBucketsClient([
      bucketRow({ archive_dataset_id: "staging-1", blockface_id: "bf-1", mean: NaN }),
      bucketRow({ archive_dataset_id: "staging-1", blockface_id: "bf-2", total_weight: Infinity }),
      bucketRow({ archive_dataset_id: "staging-1", blockface_id: "bf-3", sum_squared_diff: -1 }),
    ]);

    const result = await verifyAccumulatorIntegrity(client, "staging-1", null);

    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(3);
  });

  it("passes when the staging bucket count is within +/-20% of the live identity's", async () => {
    const liveRows = Array.from({ length: 100 }, (_, i) => bucketRow({ archive_dataset_id: "live", blockface_id: `bf-${i}` }));
    const stagingRows = Array.from({ length: 110 }, (_, i) => bucketRow({ archive_dataset_id: "staging-1", blockface_id: `bf-${i}` }));
    const client = makeMockAccumulatorBucketsClient([...liveRows, ...stagingRows]);

    const result = await verifyAccumulatorIntegrity(client, "staging-1", "live");

    expect(result.ok).toBe(true);
    expect(result.bucketCount).toBe(110);
    expect(result.compareBucketCount).toBe(100);
  });

  it("flags a staging bucket count that collapsed to a fraction of the live identity's -- the catastrophic-partial-run case", async () => {
    const liveRows = Array.from({ length: 100 }, (_, i) => bucketRow({ archive_dataset_id: "live", blockface_id: `bf-${i}` }));
    const stagingRows = Array.from({ length: 10 }, (_, i) => bucketRow({ archive_dataset_id: "staging-1", blockface_id: `bf-${i}` }));
    const client = makeMockAccumulatorBucketsClient([...liveRows, ...stagingRows]);

    const result = await verifyAccumulatorIntegrity(client, "staging-1", "live");

    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.reason.includes("outside"))).toBe(true);
  });

  it("does not flag the bucket-count ratio when there is nothing to compare against (first-ever run)", async () => {
    const client = makeMockAccumulatorBucketsClient([bucketRow({ archive_dataset_id: "staging-1", blockface_id: "bf-1" })]);

    const result = await verifyAccumulatorIntegrity(client, "staging-1", "live-but-empty");

    expect(result.ok).toBe(true);
    expect(result.compareBucketCount).toBe(0);
  });
});

interface RawOccupancyStatsRow {
  id: string;
  blockface_id: string;
  day_of_week: number;
  hour_of_day: number;
  mean_occupancy: number;
  std_dev: number;
  sample_count: number;
}

function makeMockOccupancyStatsBulkReadClient(rows: RawOccupancyStatsRow[]): OccupancyStatsBulkReadSupabaseClient {
  return {
    from: () => ({
      select: () => ({
        range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }),
        then: (onFulfilled?: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(onFulfilled),
      }),
    }),
  } as unknown as OccupancyStatsBulkReadSupabaseClient;
}

describe("compareOccupancyStatsToAccumulator", () => {
  it("reports zero stale rows when occupancy_stats exactly matches what the accumulator would produce", async () => {
    // mean=0.4, totalWeight=80, sumSquaredDiff=2 -> variance = 2/80 = 0.025 -> stdDev = sqrt(0.025)
    const stdDev = Math.sqrt(2 / 80);
    const accumulatorClient = makeMockAccumulatorBucketsClient([
      bucketRow({ archive_dataset_id: "live", blockface_id: "bf-1", count: 100, total_weight: 80, mean: 0.4, sum_squared_diff: 2 }),
    ]);
    const occupancyStatsClient = makeMockOccupancyStatsBulkReadClient([
      { id: "row-1", blockface_id: "bf-1", day_of_week: 2, hour_of_day: 14, mean_occupancy: 0.4, std_dev: stdDev, sample_count: 100 },
    ]);

    const report = await compareOccupancyStatsToAccumulator(accumulatorClient, occupancyStatsClient, "live");

    expect(report).toEqual({ totalOccupancyStatsRows: 1, staleCount: 0, staleSamples: [] });
  });

  it("flags a real, live-found-shape mismatch: occupancy_stats disagrees with what the accumulator currently says", async () => {
    const accumulatorClient = makeMockAccumulatorBucketsClient([
      bucketRow({ archive_dataset_id: "live", blockface_id: "bf-1", count: 100, total_weight: 80, mean: 0.4, sum_squared_diff: 2 }),
    ]);
    const occupancyStatsClient = makeMockOccupancyStatsBulkReadClient([
      { id: "row-1", blockface_id: "bf-1", day_of_week: 2, hour_of_day: 14, mean_occupancy: 0.9, std_dev: 0.1, sample_count: 30 },
    ]);

    const report = await compareOccupancyStatsToAccumulator(accumulatorClient, occupancyStatsClient, "live");

    expect(report.staleCount).toBe(1);
    expect(report.staleSamples[0]).toMatchObject({ blockfaceId: "bf-1", isoDay: 2, hour: 14 });
  });

  it("flags an occupancy_stats row with no matching bucket in the promoted accumulator at all", async () => {
    const accumulatorClient = makeMockAccumulatorBucketsClient([]);
    const occupancyStatsClient = makeMockOccupancyStatsBulkReadClient([
      { id: "row-1", blockface_id: "bf-orphan", day_of_week: 2, hour_of_day: 14, mean_occupancy: 0.5, std_dev: 0.1, sample_count: 50 },
    ]);

    const report = await compareOccupancyStatsToAccumulator(accumulatorClient, occupancyStatsClient, "live");

    expect(report.staleCount).toBe(1);
    expect(report.staleSamples[0]?.reason).toMatch(/no matching bucket/);
  });

  it("flags an occupancy_stats row whose accumulator bucket has since dropped below MIN_READINGS_PER_BUCKET", async () => {
    const accumulatorClient = makeMockAccumulatorBucketsClient([
      bucketRow({ archive_dataset_id: "live", blockface_id: "bf-1", count: 5, total_weight: 4, mean: 0.3, sum_squared_diff: 1 }),
    ]);
    const occupancyStatsClient = makeMockOccupancyStatsBulkReadClient([
      { id: "row-1", blockface_id: "bf-1", day_of_week: 2, hour_of_day: 14, mean_occupancy: 0.3, std_dev: 0.1, sample_count: 5 },
    ]);

    const report = await compareOccupancyStatsToAccumulator(accumulatorClient, occupancyStatsClient, "live");

    expect(report.staleCount).toBe(1);
    expect(report.staleSamples[0]?.reason).toMatch(/too few readings/);
  });

  it("reports zero stale rows against a real, empty occupancy_stats (nothing to compare, nothing stale)", async () => {
    const accumulatorClient = makeMockAccumulatorBucketsClient([]);
    const occupancyStatsClient = makeMockOccupancyStatsBulkReadClient([]);

    const report = await compareOccupancyStatsToAccumulator(accumulatorClient, occupancyStatsClient, "live");

    expect(report).toEqual({ totalOccupancyStatsRows: 0, staleCount: 0, staleSamples: [] });
  });
});
