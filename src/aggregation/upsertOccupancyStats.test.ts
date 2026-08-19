import { describe, expect, it, vi } from "vitest";
import { upsertOccupancyStats, type OccupancyStatsSupabaseClient } from "./upsertOccupancyStats.ts";
import type { SupabaseQueryResult } from "../importers/upsertBlockface.ts";
import type { BucketStats } from "./decideBucketStats.ts";

const BLOCKFACE_ID = "b1f4a2e0-0000-4000-8000-000000000001";

function makeMockClient(
  upsertImpl: (values: Record<string, unknown>, options: { onConflict: string }) => PromiseLike<SupabaseQueryResult>,
) {
  const upsert = vi.fn(upsertImpl);
  const client: OccupancyStatsSupabaseClient = {
    from: vi.fn(() => ({ upsert })),
  };
  return { client, upsert };
}

const STATS: BucketStats = { mean: 0.62, stdDev: 0.18, sampleCount: 240 };

describe("upsertOccupancyStats", () => {
  it("resolves without error on a successful insert of a new bucket row", async () => {
    const { client, upsert } = makeMockClient(() => Promise.resolve({ data: null, error: null }));

    await expect(upsertOccupancyStats(client, BLOCKFACE_ID, 1, 9, STATS)).resolves.toBeUndefined();

    expect(upsert).toHaveBeenCalledWith(
      {
        blockface_id: BLOCKFACE_ID,
        day_of_week: 1,
        hour_of_day: 9,
        mean_occupancy: 0.62,
        std_dev: 0.18,
        sample_count: 240,
      },
      { onConflict: "blockface_id,day_of_week,hour_of_day" },
    );
  });

  it("resolves without error on a successful update of an existing bucket row", async () => {
    const { client, upsert } = makeMockClient(() => Promise.resolve({ data: null, error: null }));

    // Same (blockface, day, hour) bucket written twice with different stats
    // -- the second call represents a re-aggregation overwriting the
    // existing row, exercised through the same upsert path since ON
    // CONFLICT (not app-level branching) is what decides insert vs. update.
    await upsertOccupancyStats(client, BLOCKFACE_ID, 1, 9, STATS);
    const updatedStats: BucketStats = { mean: 0.7, stdDev: 0.2, sampleCount: 300 };
    await expect(upsertOccupancyStats(client, BLOCKFACE_ID, 1, 9, updatedStats)).resolves.toBeUndefined();

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ mean_occupancy: 0.7, std_dev: 0.2, sample_count: 300 }),
      { onConflict: "blockface_id,day_of_week,hour_of_day" },
    );
  });

  it("throws a clear error identifying the blockface, day, and hour when the upsert fails", async () => {
    const { client } = makeMockClient(() => Promise.resolve({ data: null, error: { message: "connection reset" } }));

    await expect(upsertOccupancyStats(client, BLOCKFACE_ID, 3, 20, STATS)).rejects.toThrow(
      new RegExp(`blockface_id=${BLOCKFACE_ID}.*day_of_week=3.*hour_of_day=20.*connection reset`),
    );
  });
});
