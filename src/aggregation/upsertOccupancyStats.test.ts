import { describe, expect, it, vi } from "vitest";
import {
  upsertOccupancyStats,
  upsertOccupancyStatsBatch,
  verifyBatchPersisted,
  type OccupancyStatsRow,
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
    from: vi.fn(() => ({ upsert }) as unknown as ReturnType<OccupancyStatsSupabaseClient["from"]>),
  };
  return { client, upsert };
}

// A realistic in-memory fake occupancy_stats table, keyed by
// blockface:day:hour, that models the exact ambiguity this whole
// investigation is about: what upsert().select() CLAIMS was written
// (its own same-request "returned representation") is tracked separately
// from what actually lands in the underlying table, so a test can simulate
// the real, live-confirmed bug -- a batch reporting a clean, correct-looking
// success while a row never actually persists -- and confirm
// verifyBatchPersisted's independent follow-up read catches exactly that.
function makeMockBatchClient(
  options: {
    // Whole-chunk atomic failure -- the pre-existing, already-tested
    // behavior (a single bad row aborts the entire upsert call).
    hardFailForBlockfaceIds?: Set<string>;
    // The real bug being investigated: upsert().select() reports success
    // and returns a correct-looking row for this blockface, but the row is
    // never actually stored -- only visible via the independent read-back
    // failing to find it.
    silentlyFailForBlockfaceIds?: Set<string>;
    // A different shape of the same class of bug: upsert().select()'s own
    // returned representation itself already has the wrong values (not
    // just a later independent-read gap).
    misreportValuesForBlockfaceIds?: Set<string>;
    // The independent follow-up read itself erroring for a sub-chunk.
    independentReadError?: { message: string } | null;
    // Applies ONLY to a single-row call (fallbackRowByRow's retry shape,
    // Array.isArray(values) === false), never to the initial batch call --
    // lets a test simulate "silently failed in the batch, AND genuinely
    // fails again on its individual retry" without that also poisoning the
    // initial batch call for every other row in it.
    hardFailOnRetryForBlockfaceIds?: Set<string>;
  } = {},
) {
  const db = new Map<string, OccupancyStatsRow>();
  let nextId = 1;
  const upsertCallSizes: number[] = [];
  const independentReadCalls: string[][] = [];

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

  const upsert = vi.fn((values: Record<string, unknown> | Record<string, unknown>[]) => {
    const isSingleRowRetry = !Array.isArray(values);
    const rows = Array.isArray(values) ? values : [values];
    upsertCallSizes.push(rows.length);
    const hardFailingRow = rows.find(
      (row) =>
        options.hardFailForBlockfaceIds?.has(row.blockface_id as string) ||
        (isSingleRowRetry && options.hardFailOnRetryForBlockfaceIds?.has(row.blockface_id as string)),
    );

    const builder = {
      then: (
        resolve: (value: SupabaseQueryResult) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => {
        // Used only by the single-row path (upsertOccupancyStats/
        // fallbackRowByRow, no .select() chained) -- still needs to
        // actually persist to `db` on success, same as .select() below
        // does, or a retry would never show up in `db` at all.
        if (hardFailingRow !== undefined) {
          return Promise.resolve({ data: null, error: { message: `simulated failure for ${hardFailingRow.blockface_id}` } }).then(resolve, reject);
        }
        for (const raw of rows) {
          const claimed = toRow(raw);
          db.set(`${claimed.blockface_id}:${claimed.day_of_week}:${claimed.hour_of_day}`, claimed);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
      select: (_columns: string): PromiseLike<SupabaseQueryResult<OccupancyStatsRow[]>> => {
        if (hardFailingRow !== undefined) {
          return Promise.resolve({ data: null, error: { message: `simulated failure for ${hardFailingRow.blockface_id}` } });
        }
        const returned = rows.map((raw) => {
          const claimed = toRow(raw);
          const blockfaceId = raw.blockface_id as string;
          if (options.misreportValuesForBlockfaceIds?.has(blockfaceId)) {
            // The upsert's own returned representation already lies about
            // what it wrote -- store the CORRECT row but claim a wrong one.
            db.set(`${claimed.blockface_id}:${claimed.day_of_week}:${claimed.hour_of_day}`, claimed);
            return { ...claimed, sample_count: claimed.sample_count + 9999 };
          }
          if (options.silentlyFailForBlockfaceIds?.has(blockfaceId)) {
            // The classic bug: claim success with the correct-looking row,
            // but never actually store it.
            return claimed;
          }
          db.set(`${claimed.blockface_id}:${claimed.day_of_week}:${claimed.hour_of_day}`, claimed);
          return claimed;
        });
        return Promise.resolve({ data: returned, error: null });
      },
    };
    return builder as unknown as ReturnType<OccupancyStatsSupabaseClient["from"]>["upsert"] extends (...args: never[]) => infer R ? R : never;
  });

  const select = vi.fn((_columns: string) => ({
    in: (_column: string, ids: string[]): PromiseLike<SupabaseQueryResult<OccupancyStatsRow[]>> => {
      independentReadCalls.push(ids);
      if (options.independentReadError !== undefined && options.independentReadError !== null) {
        return Promise.resolve({ data: null, error: options.independentReadError });
      }
      const found = [...db.values()].filter((row) => ids.includes(row.id));
      return Promise.resolve({ data: found, error: null });
    },
  }));

  const client: OccupancyStatsSupabaseClient = {
    from: vi.fn(() => ({ upsert, select }) as unknown as ReturnType<OccupancyStatsSupabaseClient["from"]>),
  };

  return { client, upsert, select, db, upsertCallSizes, independentReadCalls };
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
    const { client, upsert, db } = makeMockBatchClient();
    const requests = [makeWriteRequest("bf-1"), makeWriteRequest("bf-2"), makeWriteRequest("bf-3")];

    const result = await upsertOccupancyStatsBatch(client, requests);

    expect(result).toEqual({ writtenCount: 3, failures: [] });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(db.size).toBe(3);
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
    const { client, upsert, upsertCallSizes, db } = makeMockBatchClient();
    const requests = Array.from({ length: 501 }, (_, i) => makeWriteRequest(`bf-${i}`));

    const result = await upsertOccupancyStatsBatch(client, requests);

    expect(result).toEqual({ writtenCount: 501, failures: [] });
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsertCallSizes).toEqual([500, 1]);
    expect(db.size).toBe(501);
  });

  it("falls back to one-row-at-a-time writes for a chunk that fails outright, isolating just the bad row", async () => {
    const { client, upsert, db } = makeMockBatchClient({ hardFailForBlockfaceIds: new Set(["bf-bad"]) });
    const requests = [makeWriteRequest("bf-good-1"), makeWriteRequest("bf-bad"), makeWriteRequest("bf-good-2")];

    const result = await upsertOccupancyStatsBatch(client, requests);

    // First call: the whole batch, fails atomically because of bf-bad.
    // Then 3 individual fallback calls, one per request.
    expect(upsert).toHaveBeenCalledTimes(4);
    expect(result.writtenCount).toBe(2);
    expect(result.failures).toEqual([
      expect.objectContaining({ blockfaceId: "bf-bad", errorMessage: expect.stringContaining("simulated failure for bf-bad") }),
    ]);
    expect([...db.keys()].sort()).toEqual(["bf-good-1:1:9", "bf-good-2:1:9"]);
  });

  it("reports multiple bad rows within the same failed chunk as separate failures", async () => {
    const { client } = makeMockBatchClient({ hardFailForBlockfaceIds: new Set(["bf-bad-1", "bf-bad-2"]) });
    const requests = [makeWriteRequest("bf-bad-1"), makeWriteRequest("bf-good"), makeWriteRequest("bf-bad-2")];

    const result = await upsertOccupancyStatsBatch(client, requests);

    expect(result.writtenCount).toBe(1);
    expect(result.failures.map((f) => f.blockfaceId).sort()).toEqual(["bf-bad-1", "bf-bad-2"]);
  });

  it("does not let one chunk's failure affect a later, independent chunk", async () => {
    const { client, upsertCallSizes, db } = makeMockBatchClient({ hardFailForBlockfaceIds: new Set(["bf-bad"]) });
    // First 500 requests include the bad one (forces a fallback); the last
    // request lands in its own, second chunk and should succeed cleanly.
    const firstChunk = Array.from({ length: 499 }, (_, i) => makeWriteRequest(`bf-ok-${i}`));
    const requests = [...firstChunk, makeWriteRequest("bf-bad"), makeWriteRequest("bf-in-second-chunk")];

    const result = await upsertOccupancyStatsBatch(client, requests);

    expect(upsertCallSizes[0]).toBe(500); // the failing first chunk's batch attempt
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.blockfaceId).toBe("bf-bad");
    expect(result.writtenCount).toBe(500); // 499 good fallback writes + the second chunk's 1
    expect(db.has("bf-in-second-chunk:1:9")).toBe(true);
  });

  // --- Post-batch verification: the real, live-confirmed silent-failure bug ---

  describe("post-batch verification (silent write-failure detection)", () => {
    it("does an independent follow-up read after every successful-looking batch, before trusting it", async () => {
      const { client, select, independentReadCalls } = makeMockBatchClient();
      const requests = [makeWriteRequest("bf-1"), makeWriteRequest("bf-2")];

      await upsertOccupancyStatsBatch(client, requests);

      expect(select).toHaveBeenCalled();
      expect(independentReadCalls).toHaveLength(1);
      expect(independentReadCalls[0]).toHaveLength(2);
    });

    it("detects a batch that reports success but never actually persists a row, retries it individually, and still logs the mismatch loudly", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { client, db } = makeMockBatchClient({ silentlyFailForBlockfaceIds: new Set(["bf-silent"]) });
      const requests = [makeWriteRequest("bf-good"), makeWriteRequest("bf-silent")];

      const result = await upsertOccupancyStatsBatch(client, requests);

      // The retry (fallbackRowByRow -> plain upsertOccupancyStats) actually
      // succeeds for bf-silent since the mock's single-row upsert path has
      // no silent-failure simulation -- self-healing, not a lost write.
      expect(result.writtenCount).toBe(2);
      expect(result.failures).toEqual([]);
      expect(db.has("bf-silent:1:9")).toBe(true);

      // But the silent failure on the BATCH path itself must still be
      // logged loudly, regardless of the retry's outcome -- that's the
      // whole point: this must never be a silent condition again.
      const errorLines = consoleErrorSpy.mock.calls.map((call) => String(call[0]));
      expect(
        errorLines.some(
          (line) => line.includes("SILENT WRITE FAILURE DETECTED") && line.includes("bf-silent") && line.includes("independent follow-up read"),
        ),
      ).toBe(true);

      consoleErrorSpy.mockRestore();
    });

    it("detects a value mismatch in the upsert's own returned representation, even before the independent read", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { client } = makeMockBatchClient({ misreportValuesForBlockfaceIds: new Set(["bf-lying"]) });
      const requests = [makeWriteRequest("bf-lying", { stats: { mean: 0.5, stdDev: 0.1, sampleCount: 100 } })];

      await upsertOccupancyStatsBatch(client, requests);

      const errorLines = consoleErrorSpy.mock.calls.map((call) => String(call[0]));
      expect(
        errorLines.some(
          (line) => line.includes("SILENT WRITE FAILURE DETECTED") && line.includes("bf-lying") && line.includes("value mismatch in the upsert's own returned representation"),
        ),
      ).toBe(true);

      consoleErrorSpy.mockRestore();
    });

    it("treats a failed independent verification read itself as a mismatch, not as a silent pass", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { client } = makeMockBatchClient({ independentReadError: { message: "read timeout" } });
      const requests = [makeWriteRequest("bf-1")];

      await upsertOccupancyStatsBatch(client, requests);

      const errorLines = consoleErrorSpy.mock.calls.map((call) => String(call[0]));
      expect(errorLines.some((line) => line.includes("SILENT WRITE FAILURE DETECTED") && line.includes("read timeout"))).toBe(true);

      consoleErrorSpy.mockRestore();
    });

    it("logs nothing and needs no retry when every row genuinely persists correctly", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { client, upsert } = makeMockBatchClient();
      const requests = [makeWriteRequest("bf-1"), makeWriteRequest("bf-2"), makeWriteRequest("bf-3")];

      const result = await upsertOccupancyStatsBatch(client, requests);

      expect(result).toEqual({ writtenCount: 3, failures: [] });
      expect(upsert).toHaveBeenCalledTimes(1); // no retry calls
      expect(consoleErrorSpy).not.toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it("records a genuine failure when a silently-failing row ALSO fails its individual retry", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      // The initial batch call succeeds overall (bf-silent just isn't
      // actually stored, per silentlyFailForBlockfaceIds) -- only the
      // SUBSEQUENT single-row retry for bf-silent specifically fails
      // (hardFailOnRetryForBlockfaceIds), simulating a persistent, not
      // just transient, problem for that one bucket.
      const { client, db, upsertCallSizes } = makeMockBatchClient({
        silentlyFailForBlockfaceIds: new Set(["bf-silent"]),
        hardFailOnRetryForBlockfaceIds: new Set(["bf-silent"]),
      });
      const requests = [makeWriteRequest("bf-good"), makeWriteRequest("bf-silent")];

      const result = await upsertOccupancyStatsBatch(client, requests);

      // Initial batch call (2 rows) + one single-row retry call for
      // bf-silent (bf-good wasn't flagged as a mismatch, so it's never
      // retried).
      expect(upsertCallSizes).toEqual([2, 1]);
      expect(db.has("bf-good:1:9")).toBe(true);
      expect(db.has("bf-silent:1:9")).toBe(false);
      expect(result.writtenCount).toBe(1);
      expect(result.failures).toEqual([
        expect.objectContaining({ blockfaceId: "bf-silent", errorMessage: expect.stringContaining("simulated failure for bf-silent") }),
      ]);

      // Still logged loudly at the point the batch-level verification
      // caught it, independent of the retry's own outcome.
      const errorLines = consoleErrorSpy.mock.calls.map((call) => String(call[0]));
      expect(errorLines.some((line) => line.includes("SILENT WRITE FAILURE DETECTED") && line.includes("bf-silent"))).toBe(true);

      consoleErrorSpy.mockRestore();
    });
  });
});

describe("verifyBatchPersisted", () => {
  const BUCKET: OccupancyStatsWriteRequest = makeWriteRequest("bf-verify", { isoDay: 2, hour: 14, stats: { mean: 0.4, stdDev: 0.1, sampleCount: 50 } });
  const ROW: OccupancyStatsRow = {
    id: "row-1",
    blockface_id: "bf-verify",
    day_of_week: 2,
    hour_of_day: 14,
    mean_occupancy: 0.4,
    std_dev: 0.1,
    sample_count: 50,
  };

  it("returns no mismatches when the upsert's representation and the independent read both agree", async () => {
    const client: OccupancyStatsSupabaseClient = {
      from: vi.fn(
        () =>
          ({
            upsert: vi.fn(),
            select: vi.fn(() => ({
              in: vi.fn(() => Promise.resolve({ data: [ROW], error: null })),
            })),
          }) as unknown as ReturnType<OccupancyStatsSupabaseClient["from"]>,
      ),
    };

    const mismatches = await verifyBatchPersisted(client, [BUCKET], [ROW]);
    expect(mismatches).toEqual([]);
  });

  it("tolerates tiny float differences from a real-number (float4) column round trip, not just exact equality", async () => {
    const roundTrippedRow: OccupancyStatsRow = { ...ROW, mean_occupancy: 0.400001, std_dev: 0.099999 };
    const client: OccupancyStatsSupabaseClient = {
      from: vi.fn(
        () =>
          ({
            upsert: vi.fn(),
            select: vi.fn(() => ({
              in: vi.fn(() => Promise.resolve({ data: [roundTrippedRow], error: null })),
            })),
          }) as unknown as ReturnType<OccupancyStatsSupabaseClient["from"]>,
      ),
    };

    const mismatches = await verifyBatchPersisted(client, [BUCKET], [roundTrippedRow]);
    expect(mismatches).toEqual([]);
  });

  it("flags a row entirely missing from the upsert's own returned representation", async () => {
    const client: OccupancyStatsSupabaseClient = {
      from: vi.fn(
        () =>
          ({
            upsert: vi.fn(),
            select: vi.fn(() => ({ in: vi.fn(() => Promise.resolve({ data: [], error: null })) })),
          }) as unknown as ReturnType<OccupancyStatsSupabaseClient["from"]>,
      ),
    };

    const mismatches = await verifyBatchPersisted(client, [BUCKET], []);
    expect(mismatches).toEqual([
      expect.objectContaining({ blockfaceId: "bf-verify", reason: expect.stringContaining("missing from the upsert's own returned representation") }),
    ]);
  });
});
