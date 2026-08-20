import { describe, expect, it, vi } from "vitest";
import {
  upsertOccupancyStats,
  upsertOccupancyStatsBatch,
  type OccupancyStatsSupabaseClient,
  type OccupancyStatsWriteRequest,
} from "./upsertOccupancyStats.ts";
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

// Mirrors the real, live-verified Supabase/Postgres behavior: a batch
// upsert containing any failing row aborts the whole call atomically (none
// of that call's rows get written), not just the bad row -- confirmed
// directly against a live table (a mean_occupancy=1.5 row mixed with 4
// valid ones: the call errored and 0 of 5 rows were present afterward).
function makeMockBatchClient(failForBlockfaceIds: Set<string> = new Set()) {
  const writtenRows: Record<string, unknown>[] = [];
  const upsertCallSizes: number[] = [];
  const upsert = vi.fn(async (values: Record<string, unknown> | Record<string, unknown>[]) => {
    const rows = Array.isArray(values) ? values : [values];
    upsertCallSizes.push(rows.length);
    const failingRow = rows.find((row) => failForBlockfaceIds.has(row.blockface_id as string));
    if (failingRow !== undefined) {
      return { data: null, error: { message: `simulated failure for ${failingRow.blockface_id}` } };
    }
    writtenRows.push(...rows);
    return { data: null, error: null };
  });
  const client: OccupancyStatsSupabaseClient = { from: vi.fn(() => ({ upsert })) };
  return { client, upsert, writtenRows, upsertCallSizes };
}

function makeWriteRequest(blockfaceId: string, overrides: Partial<OccupancyStatsWriteRequest> = {}): OccupancyStatsWriteRequest {
  return { blockfaceId, isoDay: 1, hour: 9, stats: { mean: 0.62, stdDev: 0.18, sampleCount: 240 }, ...overrides };
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

describe("upsertOccupancyStatsBatch", () => {
  it("writes every request in a single upsert call when nothing fails", async () => {
    const { client, upsert, writtenRows } = makeMockBatchClient();
    const requests = [makeWriteRequest("bf-1"), makeWriteRequest("bf-2"), makeWriteRequest("bf-3")];

    const result = await upsertOccupancyStatsBatch(client, requests);

    expect(result).toEqual({ writtenCount: 3, failures: [] });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(writtenRows).toHaveLength(3);
  });

  it("returns writtenCount 0 and no failures for an empty request list, without calling upsert", async () => {
    const { client, upsert } = makeMockBatchClient();

    const result = await upsertOccupancyStatsBatch(client, []);

    expect(result).toEqual({ writtenCount: 0, failures: [] });
    expect(upsert).not.toHaveBeenCalled();
  });

  // The chunk size is 500 (upsertOccupancyStats.ts) -- 501 requests should
  // split into two upsert calls (500 + 1) instead of one call carrying
  // every row, keeping each request's payload bounded.
  it("splits more than 500 requests into multiple upsert calls", async () => {
    const { client, upsert, upsertCallSizes, writtenRows } = makeMockBatchClient();
    const requests = Array.from({ length: 501 }, (_, i) => makeWriteRequest(`bf-${i}`));

    const result = await upsertOccupancyStatsBatch(client, requests);

    expect(result).toEqual({ writtenCount: 501, failures: [] });
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsertCallSizes).toEqual([500, 1]);
    expect(writtenRows).toHaveLength(501);
  });

  it("falls back to one-row-at-a-time writes for a chunk that fails, isolating just the bad row", async () => {
    const { client, upsert, writtenRows } = makeMockBatchClient(new Set(["bf-bad"]));
    const requests = [makeWriteRequest("bf-good-1"), makeWriteRequest("bf-bad"), makeWriteRequest("bf-good-2")];

    const result = await upsertOccupancyStatsBatch(client, requests);

    // First call: the whole batch, fails atomically because of bf-bad.
    // Then 3 individual fallback calls, one per request.
    expect(upsert).toHaveBeenCalledTimes(4);
    expect(result.writtenCount).toBe(2);
    expect(result.failures).toEqual([
      expect.objectContaining({ blockfaceId: "bf-bad", errorMessage: expect.stringContaining("simulated failure for bf-bad") }),
    ]);
    expect(writtenRows.map((r) => r.blockface_id)).toEqual(["bf-good-1", "bf-good-2"]);
  });

  it("reports multiple bad rows within the same failed chunk as separate failures", async () => {
    const { client } = makeMockBatchClient(new Set(["bf-bad-1", "bf-bad-2"]));
    const requests = [makeWriteRequest("bf-bad-1"), makeWriteRequest("bf-good"), makeWriteRequest("bf-bad-2")];

    const result = await upsertOccupancyStatsBatch(client, requests);

    expect(result.writtenCount).toBe(1);
    expect(result.failures.map((f) => f.blockfaceId).sort()).toEqual(["bf-bad-1", "bf-bad-2"]);
  });

  it("does not let one chunk's failure affect a later, independent chunk", async () => {
    const { client, upsertCallSizes, writtenRows } = makeMockBatchClient(new Set(["bf-bad"]));
    // First 500 requests include the bad one (forces a fallback); the last
    // request lands in its own, second chunk and should succeed cleanly.
    const firstChunk = Array.from({ length: 499 }, (_, i) => makeWriteRequest(`bf-ok-${i}`));
    const requests = [...firstChunk, makeWriteRequest("bf-bad"), makeWriteRequest("bf-in-second-chunk")];

    const result = await upsertOccupancyStatsBatch(client, requests);

    expect(upsertCallSizes[0]).toBe(500); // the failing first chunk's batch attempt
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.blockfaceId).toBe("bf-bad");
    expect(result.writtenCount).toBe(500); // 499 good fallback writes + the second chunk's 1
    expect(writtenRows.map((r) => r.blockface_id)).toContain("bf-in-second-chunk");
  });
});
