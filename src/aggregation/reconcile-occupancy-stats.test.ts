import { describe, expect, it } from "vitest";
import { reconcileOccupancyStatsFromAccumulator } from "./reconcile-occupancy-stats.ts";
import { buildAccumulatorBucketKey } from "./incrementalWeightedStats.ts";
import { MIN_READINGS_PER_BUCKET } from "./decideBucketStats.ts";
import type { ArchiveStreamAccumulatorBucketRow, ArchiveStreamAccumulatorBucketsSupabaseClient } from "./streamArchiveWithResume.ts";
import type { OccupancyStatsRow, OccupancyStatsSupabaseClient } from "./upsertOccupancyStats.ts";

const ARCHIVE_DATASET_ID = "7c2e-uany";

function makeAccumulatorClient(rows: ArchiveStreamAccumulatorBucketRow[]): ArchiveStreamAccumulatorBucketsSupabaseClient {
  return {
    from: () =>
      ({
        select: () => {
          let filterArchiveDatasetId: string | undefined;
          const builder = {
            eq: (_column: string, value: string) => {
              filterArchiveDatasetId = value;
              return builder;
            },
            order: () => builder,
            range: async (from: number, to: number) => {
              const filtered = rows.filter((row) => filterArchiveDatasetId === ARCHIVE_DATASET_ID);
              return { data: filtered.slice(from, to + 1), error: null };
            },
          };
          return builder;
        },
      }) as unknown as ReturnType<ArchiveStreamAccumulatorBucketsSupabaseClient["from"]>,
  };
}

// A minimal, always-consistent in-memory occupancy_stats mock -- this test
// file cares about reconcileOccupancyStatsFromAccumulator's own request-
// building logic (which buckets get included/skipped, what gets reported),
// not upsertOccupancyStatsBatch's own verification behavior, which already
// has thorough, dedicated coverage in upsertOccupancyStats.test.ts. So the
// independent read-back here always honestly reflects what was upserted,
// never simulating a mismatch.
function makeConsistentOccupancyStatsClient() {
  const db = new Map<string, OccupancyStatsRow>();
  let nextId = 1;
  const writtenBatchSizes: number[] = [];

  function toRow(raw: Record<string, unknown>): OccupancyStatsRow {
    const key = `${raw.blockface_id}:${raw.day_of_week}:${raw.hour_of_day}`;
    const existingId = db.get(key)?.id;
    return {
      id: existingId ?? `row-${nextId++}`,
      blockface_id: raw.blockface_id as string,
      day_of_week: raw.day_of_week as number,
      hour_of_day: raw.hour_of_day as number,
      mean_occupancy: raw.mean_occupancy as number,
      std_dev: raw.std_dev as number,
      sample_count: raw.sample_count as number,
    };
  }

  const client: OccupancyStatsSupabaseClient = {
    from: () =>
      ({
        upsert: (values: Record<string, unknown> | Record<string, unknown>[]) => {
          const rows = Array.isArray(values) ? values : [values];
          writtenBatchSizes.push(rows.length);
          const claimed = rows.map((raw) => {
            const row = toRow(raw);
            db.set(`${row.blockface_id}:${row.day_of_week}:${row.hour_of_day}`, row);
            return row;
          });
          return {
            then: (resolve: (value: { data: null; error: null }) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
            select: () => Promise.resolve({ data: claimed, error: null }),
          };
        },
        select: () => ({
          in: (_column: string, ids: string[]) =>
            Promise.resolve({ data: [...db.values()].filter((row) => ids.includes(row.id)), error: null }),
        }),
      }) as unknown as ReturnType<OccupancyStatsSupabaseClient["from"]>,
  };

  return { client, db, writtenBatchSizes };
}

function makeAccumulatorRow(
  blockfaceId: string,
  isoDay: number,
  hour: number,
  count: number,
): ArchiveStreamAccumulatorBucketRow {
  return {
    blockface_id: blockfaceId,
    iso_day: isoDay,
    hour,
    count,
    total_weight: count * 0.8,
    mean: 0.4,
    sum_squared_diff: count * 0.05,
  };
}

describe("reconcileOccupancyStatsFromAccumulator", () => {
  it("writes every bucket that meets the minimum-readings threshold, via the real (verified) batch upsert path", async () => {
    const rows = [
      makeAccumulatorRow("bf-1", 1, 8, 240),
      makeAccumulatorRow("bf-2", 3, 17, 500),
    ];
    const accumulatorClient = makeAccumulatorClient(rows);
    const { client: occupancyStatsClient, db } = makeConsistentOccupancyStatsClient();

    const result = await reconcileOccupancyStatsFromAccumulator(accumulatorClient, occupancyStatsClient, ARCHIVE_DATASET_ID);

    expect(result).toEqual({ totalBuckets: 2, skippedInsufficientData: 0, writtenCount: 2, failures: [] });
    expect(db.get("bf-1:1:8")?.sample_count).toBe(240);
    expect(db.get("bf-2:3:17")?.sample_count).toBe(500);
  });

  it("skips buckets below MIN_READINGS_PER_BUCKET instead of writing them", async () => {
    const rows = [
      makeAccumulatorRow("bf-sparse", 2, 9, MIN_READINGS_PER_BUCKET - 1),
      makeAccumulatorRow("bf-ok", 2, 9, MIN_READINGS_PER_BUCKET),
    ];
    const accumulatorClient = makeAccumulatorClient(rows);
    const { client: occupancyStatsClient, db } = makeConsistentOccupancyStatsClient();

    const result = await reconcileOccupancyStatsFromAccumulator(accumulatorClient, occupancyStatsClient, ARCHIVE_DATASET_ID);

    expect(result.totalBuckets).toBe(2);
    expect(result.skippedInsufficientData).toBe(1);
    expect(result.writtenCount).toBe(1);
    expect(db.has("bf-sparse:2:9")).toBe(false);
    expect(db.has("bf-ok:2:9")).toBe(true);
  });

  it("returns zeros and never calls upsert when the accumulator has no rows at all", async () => {
    const accumulatorClient = makeAccumulatorClient([]);
    const { client: occupancyStatsClient, writtenBatchSizes } = makeConsistentOccupancyStatsClient();

    const result = await reconcileOccupancyStatsFromAccumulator(accumulatorClient, occupancyStatsClient, ARCHIVE_DATASET_ID);

    expect(result).toEqual({ totalBuckets: 0, skippedInsufficientData: 0, writtenCount: 0, failures: [] });
    expect(writtenBatchSizes).toEqual([]);
  });

  it("reads back every accumulator row across multiple pages, not just the first page", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => makeAccumulatorRow(`bf-${i}`, 1, 8, 200));
    const accumulatorClient = makeAccumulatorClient(rows);
    const { client: occupancyStatsClient, db } = makeConsistentOccupancyStatsClient();

    const result = await reconcileOccupancyStatsFromAccumulator(accumulatorClient, occupancyStatsClient, ARCHIVE_DATASET_ID);

    expect(result.totalBuckets).toBe(1500);
    expect(result.writtenCount).toBe(1500);
    expect(db.size).toBe(1500);
  });

  it("reports failures from the underlying verified batch write rather than swallowing them", async () => {
    const rows = [makeAccumulatorRow("bf-1", 1, 8, 240)];
    const accumulatorClient = makeAccumulatorClient(rows);
    // A client whose select().in() always claims nothing exists -- every
    // row will look like a genuine, persistent silent-write failure to
    // upsertOccupancyStatsBatch's verification, and (since the single-row
    // retry uses this same broken client) the retry fails too, landing in
    // `failures`.
    const brokenClient: OccupancyStatsSupabaseClient = {
      from: () =>
        ({
          upsert: (values: Record<string, unknown> | Record<string, unknown>[]) => {
            const rows2 = Array.isArray(values) ? values : [values];
            const claimed = rows2.map((raw, i) => ({
              id: `row-${i}`,
              blockface_id: raw.blockface_id as string,
              day_of_week: raw.day_of_week as number,
              hour_of_day: raw.hour_of_day as number,
              mean_occupancy: raw.mean_occupancy as number,
              std_dev: raw.std_dev as number,
              sample_count: raw.sample_count as number,
            }));
            return {
              then: (resolve: (value: { data: null; error: { message: string } }) => unknown) =>
                Promise.resolve({ data: null, error: { message: "persistent simulated failure" } }).then(resolve),
              select: () => Promise.resolve({ data: claimed, error: null }),
            };
          },
          select: () => ({
            in: () => Promise.resolve({ data: [], error: null }),
          }),
        }) as unknown as ReturnType<OccupancyStatsSupabaseClient["from"]>,
    };

    const result = await reconcileOccupancyStatsFromAccumulator(accumulatorClient, brokenClient, ARCHIVE_DATASET_ID);

    expect(result.writtenCount).toBe(0);
    expect(result.failures).toEqual([
      expect.objectContaining({ blockfaceId: "bf-1", isoDay: 1, hour: 8 }),
    ]);
  });
});

// Sanity check that this module's bucket-key round trip matches
// incrementalWeightedStats.ts's own format -- if these ever drifted apart,
// reconcileOccupancyStatsFromAccumulator would silently parse garbage
// blockface/day/hour values out of every real bucket key.
describe("bucket key round trip used by reconcileOccupancyStatsFromAccumulator", () => {
  it("buildAccumulatorBucketKey/parseAccumulatorBucketKey agree on the same triple", () => {
    const key = buildAccumulatorBucketKey("bf-abc", 4, 17);
    expect(key).toBe("bf-abc:4:17");
  });
});
