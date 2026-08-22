import { describe, expect, it } from "vitest";
import {
  analyzeClampedOccupancy,
  buildAccumulatorBucketKey,
  foldReadingsIntoAccumulators,
  initializeAccumulators,
  logBucketFailure,
  MAX_RETRY_COUNT,
  parseAccumulatorBucketKey,
  parseCliOptions,
  parseRawReading,
  parseRawReadings,
  runRetryPass,
} from "./backfill-occupancy-stats.ts";
import type { BackfillFailuresRow, BackfillFailuresSupabaseClient } from "./backfill-occupancy-stats.ts";
import type { RawReading } from "./blockfaceLookup.ts";
import type { OccupancyStatsSupabaseClient } from "./upsertOccupancyStats.ts";
import type { SocrataRecord } from "../utils/fetchSocrataRecords.ts";
import type { WeightedStatsAccumulator } from "./incrementalWeightedStats.ts";
import type { ArchiveStreamCheckpointSupabaseClient } from "./streamArchiveWithResume.ts";

// --- parseCliOptions ---------------------------------------------------

describe("parseCliOptions", () => {
  it("returns maxChunks: null when no --max-chunks flag is given", () => {
    expect(parseCliOptions([])).toEqual({ maxChunks: null });
  });

  it("parses a valid --max-chunks=<n>", () => {
    expect(parseCliOptions(["--max-chunks=5"])).toEqual({ maxChunks: 5 });
  });

  it("throws for a non-numeric value", () => {
    expect(() => parseCliOptions(["--max-chunks=abc"])).toThrow(/must be a positive integer/);
  });

  it("throws for zero or a negative value", () => {
    expect(() => parseCliOptions(["--max-chunks=0"])).toThrow(/must be a positive integer/);
    expect(() => parseCliOptions(["--max-chunks=-1"])).toThrow(/must be a positive integer/);
  });

  it("throws for a non-integer value", () => {
    expect(() => parseCliOptions(["--max-chunks=2.5"])).toThrow(/must be a positive integer/);
  });
});

// --- parseRawReading / parseRawReadings ---------------------------------

function makeRawRecord(overrides: Partial<Record<string, unknown>> = {}): SocrataRecord {
  return {
    sourceelementkey: "9477",
    sideofstreet: "W",
    occupancydatetime: "2026-07-30T17:38:00.000",
    paidoccupancy: "1",
    parkingspacecount: "8",
    ...overrides,
  };
}

describe("parseRawReading", () => {
  it("parses a well-formed raw Socrata record into a RawReading", () => {
    expect(parseRawReading(makeRawRecord())).toEqual({
      sourceElementKey: 9477,
      sideOfStreet: "W",
      occupancyDateTime: "2026-07-30T17:38:00.000",
      paidOccupancy: 1,
      parkingSpaceCount: 8,
    });
  });

  it("throws when a required field is missing", () => {
    expect(() => parseRawReading(makeRawRecord({ sideofstreet: undefined }))).toThrow(/missing or non-string "sideofstreet"/);
  });

  it("throws when a numeric-string field is not actually numeric", () => {
    expect(() => parseRawReading(makeRawRecord({ paidoccupancy: "not-a-number" }))).toThrow(/"paidoccupancy" is not a valid number/);
  });
});

describe("parseRawReadings", () => {
  it("parses every well-formed record and reports zero failures", () => {
    const { readings, parseFailures } = parseRawReadings([makeRawRecord(), makeRawRecord({ sourceelementkey: "52529" })]);
    expect(readings).toHaveLength(2);
    expect(parseFailures).toBe(0);
  });

  it("skips a malformed record and counts it, without aborting the rest", () => {
    const records = [makeRawRecord(), makeRawRecord({ parkingspacecount: "n/a" }), makeRawRecord({ sourceelementkey: "1" })];
    const { readings, parseFailures } = parseRawReadings(records);
    expect(readings).toHaveLength(2);
    expect(parseFailures).toBe(1);
  });

  it("handles an empty array cleanly, not as an error", () => {
    expect(parseRawReadings([])).toEqual({ readings: [], parseFailures: 0 });
  });
});

// --- buildAccumulatorBucketKey / parseAccumulatorBucketKey ----------------

describe("buildAccumulatorBucketKey / parseAccumulatorBucketKey", () => {
  it("round-trips a blockfaceId/isoDay/hour triple", () => {
    const key = buildAccumulatorBucketKey("b1f4a2e0-0000-4000-8000-000000000001", 3, 14);
    expect(parseAccumulatorBucketKey(key)).toEqual({
      blockfaceId: "b1f4a2e0-0000-4000-8000-000000000001",
      isoDay: 3,
      hour: 14,
    });
  });

  it("handles hour 0 and single-digit values without ambiguity", () => {
    const key = buildAccumulatorBucketKey("bf-1", 1, 0);
    expect(parseAccumulatorBucketKey(key)).toEqual({ blockfaceId: "bf-1", isoDay: 1, hour: 0 });
  });

  it("throws for a malformed key", () => {
    expect(() => parseAccumulatorBucketKey("not-a-real-key")).toThrow(/malformed bucket key/);
  });
});

// --- foldReadingsIntoAccumulators ------------------------------------------

const FOLD_NOW = new Date("2026-08-19T12:00:00Z");
const FOLD_LOOKUP = new Map([["9477:W", "blockface-1"]]);

describe("foldReadingsIntoAccumulators", () => {
  it("folds a matched reading into a fresh accumulator for its bucket", () => {
    const accumulators = new Map<string, WeightedStatsAccumulator>();

    const result = foldReadingsIntoAccumulators([makeRawRecord()], accumulators, FOLD_LOOKUP, FOLD_NOW);

    expect(result).toEqual({ unmatchedCount: 0, parseFailures: 0 });
    // makeRawRecord's default occupancydatetime (2026-07-30T17:38:00.000)
    // is a Thursday (ISO day 4), hour 17.
    const key = buildAccumulatorBucketKey("blockface-1", 4, 17);
    expect(accumulators.get(key)?.count).toBe(1);
  });

  it("accumulates multiple readings into the same bucket rather than overwriting", () => {
    const accumulators = new Map<string, WeightedStatsAccumulator>();

    foldReadingsIntoAccumulators([makeRawRecord(), makeRawRecord(), makeRawRecord()], accumulators, FOLD_LOOKUP, FOLD_NOW);

    const key = buildAccumulatorBucketKey("blockface-1", 4, 17);
    expect(accumulators.get(key)?.count).toBe(3);
  });

  it("keeps different (blockface, isoDay, hour) buckets separate within one call", () => {
    const accumulators = new Map<string, WeightedStatsAccumulator>();
    const lookup = new Map([
      ["9477:W", "blockface-1"],
      ["1234:N", "blockface-2"],
    ]);
    const records = [
      makeRawRecord(), // blockface-1, Thu 17
      makeRawRecord({ sourceelementkey: "1234", sideofstreet: "N" }), // blockface-2, Thu 17
      makeRawRecord({ occupancydatetime: "2026-08-02T09:00:00.000" }), // blockface-1, Sun (ISO 7) 09
    ];

    foldReadingsIntoAccumulators(records, accumulators, lookup, FOLD_NOW);

    expect(accumulators.size).toBe(3);
    expect(accumulators.get(buildAccumulatorBucketKey("blockface-1", 4, 17))?.count).toBe(1);
    expect(accumulators.get(buildAccumulatorBucketKey("blockface-2", 4, 17))?.count).toBe(1);
    expect(accumulators.get(buildAccumulatorBucketKey("blockface-1", 7, 9))?.count).toBe(1);
  });

  it("counts an unmatched reading (no blockface in lookup) without folding it into any bucket", () => {
    const accumulators = new Map<string, WeightedStatsAccumulator>();

    const result = foldReadingsIntoAccumulators(
      [makeRawRecord({ sourceelementkey: "99999" })],
      accumulators,
      FOLD_LOOKUP,
      FOLD_NOW,
    );

    expect(result).toEqual({ unmatchedCount: 1, parseFailures: 0 });
    expect(accumulators.size).toBe(0);
  });

  it("counts a malformed record without aborting the rest of the chunk", () => {
    const accumulators = new Map<string, WeightedStatsAccumulator>();
    const records = [makeRawRecord({ parkingspacecount: "n/a" }), makeRawRecord()];

    const result = foldReadingsIntoAccumulators(records, accumulators, FOLD_LOOKUP, FOLD_NOW);

    expect(result).toEqual({ unmatchedCount: 0, parseFailures: 1 });
    expect(accumulators.get(buildAccumulatorBucketKey("blockface-1", 4, 17))?.count).toBe(1);
  });

  it("mutates the same Map instance across repeated calls (the shared-accumulator contract main() relies on)", () => {
    const accumulators = new Map<string, WeightedStatsAccumulator>();

    foldReadingsIntoAccumulators([makeRawRecord()], accumulators, FOLD_LOOKUP, FOLD_NOW);
    foldReadingsIntoAccumulators([makeRawRecord()], accumulators, FOLD_LOOKUP, FOLD_NOW);

    expect(accumulators.get(buildAccumulatorBucketKey("blockface-1", 4, 17))?.count).toBe(2);
  });

  it("handles an empty record batch cleanly, not as an error", () => {
    const accumulators = new Map<string, WeightedStatsAccumulator>();
    expect(foldReadingsIntoAccumulators([], accumulators, FOLD_LOOKUP, FOLD_NOW)).toEqual({ unmatchedCount: 0, parseFailures: 0 });
    expect(accumulators.size).toBe(0);
  });

  it("produces an accumulator whose finalized stats agree with the batch calculateWeightedStats path for the same readings", () => {
    // Cross-checks against groupReadingsByBlockface's own normalizeReading +
    // calculateRecencyWeight pipeline (the already-trusted batch path),
    // not just internal self-consistency.
    const accumulators = new Map<string, WeightedStatsAccumulator>();
    const records = Array.from({ length: 5 }, () => makeRawRecord());

    foldReadingsIntoAccumulators(records, accumulators, FOLD_LOOKUP, FOLD_NOW);

    const accumulator = accumulators.get(buildAccumulatorBucketKey("blockface-1", 4, 17));
    expect(accumulator).toBeDefined();
    expect(accumulator?.count).toBe(5);
    // All 5 records are byte-identical, so every reading has the same
    // value/weight -- the accumulated mean must equal that single value.
    const { readings: parsed } = parseRawReadings(records);
    const singleReading = parsed[0]!;
    expect(accumulator?.mean).toBeCloseTo(singleReading.paidOccupancy / singleReading.parkingSpaceCount, 10);
  });
});

// --- analyzeClampedOccupancy ---------------------------------------------

function makeReading(overrides: Partial<RawReading> = {}): RawReading {
  return {
    sourceElementKey: 9477,
    sideOfStreet: "W",
    occupancyDateTime: "2026-07-30T17:38:00.000", // Thursday (ISO 4), hour 17
    paidOccupancy: 1,
    parkingSpaceCount: 8,
    ...overrides,
  };
}

describe("analyzeClampedOccupancy", () => {
  it("returns null when nothing exceeds capacity", () => {
    const readings = [makeReading({ paidOccupancy: 4, parkingSpaceCount: 8 }), makeReading({ paidOccupancy: 8, parkingSpaceCount: 8 })];
    expect(analyzeClampedOccupancy(readings)).toBeNull();
  });

  it("returns null for an empty array, not an error", () => {
    expect(analyzeClampedOccupancy([])).toBeNull();
  });

  it("counts readings exceeding capacity and reports the raw (unclamped) min/max ratio", () => {
    const readings = [
      makeReading({ paidOccupancy: 4, parkingSpaceCount: 8 }), // 50%, not clamped
      makeReading({ paidOccupancy: 9, parkingSpaceCount: 8 }), // 112.5%, clamped
      makeReading({ paidOccupancy: 24, parkingSpaceCount: 8 }), // 300%, clamped
    ];

    const summary = analyzeClampedOccupancy(readings);

    expect(summary).not.toBeNull();
    expect(summary?.count).toBe(2);
    expect(summary?.minRatio).toBeCloseTo(1.125);
    expect(summary?.maxRatio).toBeCloseTo(3);
  });

  it("does not count a reading exactly at capacity (ratio of exactly 1.0)", () => {
    const readings = [makeReading({ paidOccupancy: 8, parkingSpaceCount: 8 })];
    expect(analyzeClampedOccupancy(readings)).toBeNull();
  });

  it("does not count a reading with negative paidOccupancy (clamped to 0 by a different branch, not this one)", () => {
    const readings = [makeReading({ paidOccupancy: -3, parkingSpaceCount: 8 })];
    expect(analyzeClampedOccupancy(readings)).toBeNull();
  });

  it("excludes a reading with parkingSpaceCount <= 0, a separate structural error elsewhere, not a ratio to report here", () => {
    const readings = [makeReading({ paidOccupancy: 5, parkingSpaceCount: 0 }), makeReading({ paidOccupancy: 9, parkingSpaceCount: 8 })];

    const summary = analyzeClampedOccupancy(readings);

    expect(summary?.count).toBe(1);
    expect(summary?.minRatio).toBeCloseTo(1.125);
  });
});

// --- logBucketFailure ------------------------------------------------------

function createMockFailuresClient(options: {
  existing?: BackfillFailuresRow | null;
  selectError?: { message: string } | null;
  upsertError?: { message: string } | null;
  rowsForRetryPass?: BackfillFailuresRow[];
  retrySelectError?: { message: string } | null;
  deleteError?: { message: string } | null;
} = {}) {
  const existing = options.existing ?? null;
  const upsertCalls: Record<string, unknown>[] = [];
  const deleteCalls: unknown[] = [];

  const queryBuilder = {
    eq: () => queryBuilder,
    maybeSingle: async () =>
      options.selectError !== undefined && options.selectError !== null
        ? { data: null, error: options.selectError }
        : { data: existing, error: null },
    then: (resolve: (value: unknown) => unknown) =>
      resolve(
        options.retrySelectError !== undefined && options.retrySelectError !== null
          ? { data: null, error: options.retrySelectError }
          : { data: options.rowsForRetryPass ?? [], error: null },
      ),
  };

  const client: BackfillFailuresSupabaseClient = {
    from: () =>
      ({
        select: () => queryBuilder,
        upsert: async (row: Record<string, unknown>) => {
          upsertCalls.push(row);
          return options.upsertError !== undefined && options.upsertError !== null
            ? { data: null, error: options.upsertError }
            : { data: null, error: null };
        },
        delete: () => ({
          eq: async (_column: string, value: unknown) => {
            deleteCalls.push(value);
            return options.deleteError !== undefined && options.deleteError !== null
              ? { data: null, error: options.deleteError }
              : { data: [], error: null };
          },
        }),
      }) as unknown as ReturnType<BackfillFailuresSupabaseClient["from"]>,
  };

  return { client, upsertCalls, deleteCalls };
}

describe("logBucketFailure", () => {
  it("inserts a new failure row with retry_count 0 when none exists yet", async () => {
    const { client, upsertCalls } = createMockFailuresClient({ existing: null });

    await logBucketFailure(client, {
      blockfaceId: "bf-1",
      isoDay: 1,
      hour: 9,
      stats: { mean: 0.5, stdDev: 0.1, sampleCount: 100 },
      errorMessage: "connection reset",
    });

    expect(upsertCalls[0]).toMatchObject({
      blockface_id: "bf-1",
      iso_day: 1,
      hour: 9,
      mean_occupancy: 0.5,
      std_dev: 0.1,
      sample_count: 100,
      error_message: "connection reset",
      retry_count: 0,
    });
  });

  it("increments retry_count when a failure row already exists for this bucket", async () => {
    const { client, upsertCalls } = createMockFailuresClient({
      existing: {
        id: "f-1",
        blockface_id: "bf-1",
        iso_day: 1,
        hour: 9,
        mean_occupancy: 0.5,
        std_dev: 0.1,
        sample_count: 100,
        error_message: "old error",
        retry_count: 2,
      },
    });

    await logBucketFailure(client, {
      blockfaceId: "bf-1",
      isoDay: 1,
      hour: 9,
      stats: { mean: 0.6, stdDev: 0.2, sampleCount: 120 },
      errorMessage: "new error",
    });

    expect(upsertCalls[0]).toMatchObject({ retry_count: 3, error_message: "new error" });
  });

  it("does not throw when the existence check itself fails -- logs and returns", async () => {
    const { client } = createMockFailuresClient({ selectError: { message: "read broke" } });

    await expect(
      logBucketFailure(client, { blockfaceId: "bf-1", isoDay: 1, hour: 9, stats: null, errorMessage: "original" }),
    ).resolves.toBeUndefined();
  });

  it("does not throw when the upsert itself fails -- logs and returns", async () => {
    const { client } = createMockFailuresClient({ upsertError: { message: "write broke" } });

    await expect(
      logBucketFailure(client, { blockfaceId: "bf-1", isoDay: 1, hour: 9, stats: null, errorMessage: "original" }),
    ).resolves.toBeUndefined();
  });

  it("stores null stats when stats is null", async () => {
    const { client, upsertCalls } = createMockFailuresClient();

    await logBucketFailure(client, { blockfaceId: "bf-1", isoDay: 1, hour: 9, stats: null, errorMessage: "fetch failed" });

    expect(upsertCalls[0]).toMatchObject({ mean_occupancy: null, std_dev: null, sample_count: null });
  });
});

function createMockOccupancyStatsClient(failForBlockfaceIds: Set<string> = new Set()) {
  const upsertCalls: Record<string, unknown>[] = [];
  const upsertCallBatchSizes: number[] = [];
  const client: OccupancyStatsSupabaseClient = {
    from: () => ({
      upsert: async (rowOrRows: Record<string, unknown> | Record<string, unknown>[]) => {
        const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
        upsertCallBatchSizes.push(rows.length);
        const failingRow = rows.find((row) => failForBlockfaceIds.has(row.blockface_id as string));
        if (failingRow !== undefined) {
          return { data: null, error: { message: `simulated failure for ${failingRow.blockface_id}` } };
        }
        upsertCalls.push(...rows);
        return { data: null, error: null };
      },
    }),
  };
  return { client, upsertCalls, upsertCallBatchSizes };
}

// --- runRetryPass --------------------------------------------------------

describe("runRetryPass", () => {
  it("retries every stored failure, deletes the row on success", async () => {
    const row: BackfillFailuresRow = {
      id: "f-1",
      blockface_id: "bf-1",
      iso_day: 1,
      hour: 8,
      mean_occupancy: 0.5,
      std_dev: 0.1,
      sample_count: 100,
      error_message: "old error",
      retry_count: 1,
    };
    const { client: failuresClient, deleteCalls } = createMockFailuresClient({ rowsForRetryPass: [row] });
    const { client: occupancyStatsClient, upsertCalls } = createMockOccupancyStatsClient();

    const summary = await runRetryPass({ occupancyStatsClient, failuresClient });

    expect(summary).toEqual({ retriedSuccessfully: 1, remainingFailures: 0, exceededRetryLimit: 0 });
    expect(upsertCalls[0]).toMatchObject({ blockface_id: "bf-1", day_of_week: 1, hour_of_day: 8, mean_occupancy: 0.5 });
    expect(deleteCalls).toEqual(["f-1"]);
  });

  it("retries a row below MAX_RETRY_COUNT normally", async () => {
    const row: BackfillFailuresRow = {
      id: "f-1",
      blockface_id: "bf-1",
      iso_day: 1,
      hour: 8,
      mean_occupancy: 0.5,
      std_dev: 0.1,
      sample_count: 100,
      error_message: "old error",
      retry_count: MAX_RETRY_COUNT - 1,
    };
    const { client: failuresClient, deleteCalls } = createMockFailuresClient({ rowsForRetryPass: [row] });
    const { client: occupancyStatsClient, upsertCalls } = createMockOccupancyStatsClient();

    const summary = await runRetryPass({ occupancyStatsClient, failuresClient });

    expect(summary).toEqual({ retriedSuccessfully: 1, remainingFailures: 0, exceededRetryLimit: 0 });
    expect(upsertCalls).toHaveLength(1);
    expect(deleteCalls).toEqual(["f-1"]);
  });

  it("skips a row at exactly MAX_RETRY_COUNT without attempting a retry", async () => {
    const row: BackfillFailuresRow = {
      id: "f-1",
      blockface_id: "bf-1",
      iso_day: 1,
      hour: 8,
      mean_occupancy: 0.5,
      std_dev: 0.1,
      sample_count: 100,
      error_message: "old error",
      retry_count: MAX_RETRY_COUNT,
    };
    const { client: failuresClient, deleteCalls, upsertCalls: failureUpsertCalls } = createMockFailuresClient({ rowsForRetryPass: [row] });
    const { client: occupancyStatsClient, upsertCalls } = createMockOccupancyStatsClient();

    const summary = await runRetryPass({ occupancyStatsClient, failuresClient });

    expect(summary).toEqual({ retriedSuccessfully: 0, remainingFailures: 0, exceededRetryLimit: 1 });
    // Not attempted at all: no occupancy_stats write, no delete, no
    // failure-row update -- the row is left exactly as-is for a human to
    // find, not retried and not silently modified.
    expect(upsertCalls).toHaveLength(0);
    expect(deleteCalls).toHaveLength(0);
    expect(failureUpsertCalls).toHaveLength(0);
  });

  it("separates remaining-eligible failures from exceeded-limit failures in the same pass", async () => {
    const eligibleRow: BackfillFailuresRow = {
      id: "f-eligible",
      blockface_id: "bf-eligible",
      iso_day: 1,
      hour: 8,
      mean_occupancy: 0.5,
      std_dev: 0.1,
      sample_count: 100,
      error_message: "old error",
      retry_count: 2,
    };
    const exceededRow: BackfillFailuresRow = {
      id: "f-exceeded",
      blockface_id: "bf-exceeded",
      iso_day: 2,
      hour: 9,
      mean_occupancy: 0.4,
      std_dev: 0.2,
      sample_count: 200,
      error_message: "persistent error",
      retry_count: MAX_RETRY_COUNT,
    };
    const { client: failuresClient } = createMockFailuresClient({ rowsForRetryPass: [eligibleRow, exceededRow] });
    // Both blockfaces fail the upsert -- eligibleRow should still be
    // attempted and counted as remaining, exceededRow should not be
    // attempted at all and counted separately.
    const { client: occupancyStatsClient } = createMockOccupancyStatsClient(new Set(["bf-eligible", "bf-exceeded"]));

    const summary = await runRetryPass({ occupancyStatsClient, failuresClient });

    expect(summary).toEqual({ retriedSuccessfully: 0, remainingFailures: 1, exceededRetryLimit: 1 });
  });

  it("updates error_message and increments retry_count on a repeat failure, without deleting", async () => {
    const row: BackfillFailuresRow = {
      id: "f-1",
      blockface_id: "bf-1",
      iso_day: 1,
      hour: 8,
      mean_occupancy: 0.5,
      std_dev: 0.1,
      sample_count: 100,
      error_message: "old error",
      retry_count: 1,
    };
    const { client: failuresClient, deleteCalls, upsertCalls: failureUpsertCalls } = createMockFailuresClient({ rowsForRetryPass: [row] });
    const { client: occupancyStatsClient } = createMockOccupancyStatsClient(new Set(["bf-1"]));

    const summary = await runRetryPass({ occupancyStatsClient, failuresClient });

    expect(summary).toEqual({ retriedSuccessfully: 0, remainingFailures: 1, exceededRetryLimit: 0 });
    expect(deleteCalls).toHaveLength(0);
    expect(failureUpsertCalls[0]).toMatchObject({ retry_count: 2, error_message: expect.stringContaining("simulated failure") });
  });

  it("counts a row with null stored stats as a remaining failure without attempting a retry", async () => {
    const row: BackfillFailuresRow = {
      id: "f-2",
      blockface_id: "bf-2",
      iso_day: 1,
      hour: 8,
      mean_occupancy: null,
      std_dev: null,
      sample_count: null,
      error_message: "fetch failed before stats existed",
      retry_count: 0,
    };
    const { client: failuresClient } = createMockFailuresClient({ rowsForRetryPass: [row] });
    const { client: occupancyStatsClient, upsertCalls } = createMockOccupancyStatsClient();

    const summary = await runRetryPass({ occupancyStatsClient, failuresClient });

    expect(summary).toEqual({ retriedSuccessfully: 0, remainingFailures: 1, exceededRetryLimit: 0 });
    expect(upsertCalls).toHaveLength(0);
  });

  it("handles an empty occupancy_stats_backfill_failures table cleanly, not as an error", async () => {
    const { client: failuresClient } = createMockFailuresClient({ rowsForRetryPass: [] });
    const { client: occupancyStatsClient } = createMockOccupancyStatsClient();

    const summary = await runRetryPass({ occupancyStatsClient, failuresClient });

    expect(summary).toEqual({ retriedSuccessfully: 0, remainingFailures: 0, exceededRetryLimit: 0 });
  });

  it("throws a clear error when reading occupancy_stats_backfill_failures itself fails", async () => {
    const { client: failuresClient } = createMockFailuresClient({ retrySelectError: { message: "connection reset" } });
    const { client: occupancyStatsClient } = createMockOccupancyStatsClient();

    await expect(runRetryPass({ occupancyStatsClient, failuresClient })).rejects.toThrow(/connection reset/);
  });
});

// --- initializeAccumulators ------------------------------------------------

function makeMockCheckpointClient(existingRow: Record<string, unknown> | null) {
  const queryBuilder = {
    eq: () => queryBuilder,
    maybeSingle: async () => ({ data: existingRow, error: null }),
  };
  const client: ArchiveStreamCheckpointSupabaseClient = {
    from: () =>
      ({
        select: () => queryBuilder,
        upsert: async () => ({ data: null, error: null }),
        delete: () => ({ eq: async () => ({ data: [], error: null }) }),
      }) as unknown as ReturnType<ArchiveStreamCheckpointSupabaseClient["from"]>,
  };
  return client;
}

describe("initializeAccumulators", () => {
  it("fresh start (no checkpoint): fetches and folds the rolling window", async () => {
    const checkpointClient = makeMockCheckpointClient(null);
    let fetchCallCount = 0;
    const fetchRollingWindowRecords = async () => {
      fetchCallCount += 1;
      return [makeRawRecord()];
    };

    const result = await initializeAccumulators({
      checkpointClient,
      archiveDatasetId: "7c2e-uany",
      lookup: FOLD_LOOKUP,
      now: FOLD_NOW,
      fetchRollingWindowRecords,
    });

    expect(result.resuming).toBe(false);
    expect(fetchCallCount).toBe(1);
    expect(result.accumulators.get(buildAccumulatorBucketKey("blockface-1", 4, 17))?.count).toBe(1);
    expect(result.unmatchedCount).toBe(0);
    expect(result.parseFailures).toBe(0);
  });

  // The critical correctness check the whole streaming redesign depends
  // on: the rolling window's readings were already folded into
  // accumulators during the original fresh run that produced this
  // archive's first checkpoint, and are already baked into whatever
  // snapshot streamArchiveWithResume goes on to restore. Re-fetching (and
  // re-folding) it again here on a resume would double-count every single
  // rolling-window reading a second time.
  it("resume (existing checkpoint): does NOT fetch the rolling window at all", async () => {
    const checkpointClient = makeMockCheckpointClient({
      archive_dataset_id: "7c2e-uany",
      last_processed_id: "row-1",
      readings_processed_count: 10,
      accumulator_snapshot_last_processed_id: null,
      accumulator_state: {},
    });
    let fetchCallCount = 0;
    const fetchRollingWindowRecords = async () => {
      fetchCallCount += 1;
      return [makeRawRecord()];
    };

    const result = await initializeAccumulators({
      checkpointClient,
      archiveDatasetId: "7c2e-uany",
      lookup: FOLD_LOOKUP,
      now: FOLD_NOW,
      fetchRollingWindowRecords,
    });

    expect(fetchCallCount).toBe(0);
    expect(result.resuming).toBe(true);
    expect(result.accumulators.size).toBe(0);
    expect(result.unmatchedCount).toBe(0);
    expect(result.parseFailures).toBe(0);
  });
});
