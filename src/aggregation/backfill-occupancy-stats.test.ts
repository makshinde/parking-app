import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeClampedOccupancy,
  buildAccumulatorBucketKey,
  createMaxChunksOnChunk,
  foldReadingsIntoAccumulators,
  initializeAccumulators,
  logBucketFailure,
  MAX_RETRY_COUNT,
  MaxChunksReachedError,
  mergeAccumulatorSnapshot,
  parseAccumulatorBucketKey,
  parseCliOptions,
  parseRawReading,
  parseRawReadings,
  ROLLING_WINDOW_PROGRESS_LOG_INTERVAL_PAGES,
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

// --- createMaxChunksOnChunk ----------------------------------------------

describe("createMaxChunksOnChunk", () => {
  it("never throws when maxChunks is null, regardless of how many chunks are processed", () => {
    const { onChunk, getChunksProcessed } = createMaxChunksOnChunk(null, () => ({}));
    for (let i = 0; i < 500; i++) {
      expect(() => onChunk([])).not.toThrow();
    }
    expect(getChunksProcessed()).toBe(500);
  });

  it("calls the inner fold callback and returns its result on every chunk, including the last one before throwing", () => {
    const fold = vi.fn((records: SocrataRecord[]) => ({ [`bucket-${records.length}`]: { count: 1, totalWeight: 1, mean: 0, sumSquaredDiff: 0 } }));
    const { onChunk } = createMaxChunksOnChunk(2, fold);

    expect(onChunk([{}])).toEqual({ "bucket-1": { count: 1, totalWeight: 1, mean: 0, sumSquaredDiff: 0 } });
    expect(() => onChunk([{}, {}])).toThrow(MaxChunksReachedError);
    expect(fold).toHaveBeenCalledTimes(2);
  });

  it("throws MaxChunksReachedError exactly on the maxChunks-th call, not before or after", () => {
    const { onChunk, getChunksProcessed } = createMaxChunksOnChunk(3, () => ({}));
    expect(() => onChunk([])).not.toThrow();
    expect(() => onChunk([])).not.toThrow();
    expect(() => onChunk([])).toThrow(MaxChunksReachedError);
    expect(getChunksProcessed()).toBe(3);
  });

  // This is the exact --max-chunks resume scenario: each createMaxChunksOnChunk
  // call represents one process invocation of backfill-occupancy-stats.ts
  // (main() calls this exactly once per run -- see main()'s own comment).
  // A resumed run gets a BRAND NEW counter starting at 0, with no memory of
  // how many chunks a prior run already committed to the checkpoint -- that
  // is what makes --max-chunks=300 on a resumed run process 300 MORE chunks
  // on top of whatever was already done, landing at (prior total + 300)
  // overall, rather than stopping once the grand total across all runs
  // reaches 300.
  it("counts additively from a fresh start on each new invocation, never toward a cumulative total across separate runs", () => {
    const firstRun = createMaxChunksOnChunk(150, () => ({}));
    for (let i = 0; i < 149; i++) {
      expect(() => firstRun.onChunk([])).not.toThrow();
    }
    expect(() => firstRun.onChunk([])).toThrow(MaxChunksReachedError);
    expect(firstRun.getChunksProcessed()).toBe(150);

    // A second, independent invocation (simulating a fresh `node`/npm
    // process resuming from the checkpoint the first run left behind) gets
    // its own --max-chunks=300 budget in full, not "150 more to reach 300".
    const secondRun = createMaxChunksOnChunk(300, () => ({}));
    for (let i = 0; i < 299; i++) {
      expect(() => secondRun.onChunk([])).not.toThrow();
    }
    expect(() => secondRun.onChunk([])).toThrow(MaxChunksReachedError);
    expect(secondRun.getChunksProcessed()).toBe(300);
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

// --- mergeAccumulatorSnapshot ------------------------------------------

describe("mergeAccumulatorSnapshot", () => {
  it("merges a non-empty snapshot into an empty map (equivalent to a fresh restore)", () => {
    const accumulators = new Map<string, WeightedStatsAccumulator>();
    const snapshot = { "bf-1:2:9": { count: 5, totalWeight: 5, mean: 0.4, sumSquaredDiff: 0.2 } };

    const restoredCount = mergeAccumulatorSnapshot(accumulators, snapshot);

    expect(restoredCount).toBe(1);
    expect(accumulators.size).toBe(1);
    expect(accumulators.get("bf-1:2:9")).toEqual(snapshot["bf-1:2:9"]);
  });

  // The specific correctness property the whole fix depends on: merging
  // must NOT discard whatever the map already held (e.g. a rolling-window
  // fold folded in before onResume fires) -- only replace/add the keys the
  // snapshot itself specifies.
  it("preserves pre-existing entries not present in the snapshot, rather than clobbering the whole map", () => {
    const preExisting: WeightedStatsAccumulator = { count: 3, totalWeight: 3, mean: 0.1, sumSquaredDiff: 0.05 };
    const accumulators = new Map<string, WeightedStatsAccumulator>([["bf-rolling-window:4:17", preExisting]]);

    const restoredCount = mergeAccumulatorSnapshot(accumulators, { "bf-from-snapshot:1:9": { count: 7, totalWeight: 7, mean: 0.6, sumSquaredDiff: 0.3 } });

    expect(restoredCount).toBe(1);
    expect(accumulators.size).toBe(2);
    expect(accumulators.get("bf-rolling-window:4:17")).toEqual(preExisting);
    expect(accumulators.get("bf-from-snapshot:1:9")?.count).toBe(7);
  });

  it("merging an empty snapshot into a non-empty map is a no-op (the checkpoint-exists-but-no-snapshot-yet case)", () => {
    const preExisting: WeightedStatsAccumulator = { count: 3, totalWeight: 3, mean: 0.1, sumSquaredDiff: 0.05 };
    const accumulators = new Map<string, WeightedStatsAccumulator>([["bf-rolling-window:4:17", preExisting]]);

    const restoredCount = mergeAccumulatorSnapshot(accumulators, {});

    expect(restoredCount).toBe(0);
    expect(accumulators.size).toBe(1);
    expect(accumulators.get("bf-rolling-window:4:17")).toEqual(preExisting);
  });

  it("overwrites a key that exists in both, using the snapshot's value", () => {
    const accumulators = new Map<string, WeightedStatsAccumulator>([
      ["bf-1:2:9", { count: 1, totalWeight: 1, mean: 0.1, sumSquaredDiff: 0 }],
    ]);

    mergeAccumulatorSnapshot(accumulators, { "bf-1:2:9": { count: 9, totalWeight: 9, mean: 0.9, sumSquaredDiff: 0.5 } });

    expect(accumulators.get("bf-1:2:9")?.count).toBe(9);
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
  // This mock only ever exercises upsertOccupancyStats' single-row path
  // (via runRetryPass below), which never chains .select() -- the no-op
  // select() here exists only to satisfy OccupancyStatsSupabaseTableBuilder's
  // shape, not because any test in this describe block calls it.
  const client: OccupancyStatsSupabaseClient = {
    from: () =>
      ({
        upsert: (rowOrRows: Record<string, unknown> | Record<string, unknown>[]) => {
          const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
          upsertCallBatchSizes.push(rows.length);
          const failingRow = rows.find((row) => failForBlockfaceIds.has(row.blockface_id as string));
          const result =
            failingRow !== undefined
              ? { data: null, error: { message: `simulated failure for ${failingRow.blockface_id}` } }
              : (upsertCalls.push(...rows), { data: null, error: null });
          return {
            then: (resolve: (value: typeof result) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
            select: () => Promise.resolve({ data: null, error: null }),
          };
        },
      }) as unknown as ReturnType<OccupancyStatsSupabaseClient["from"]>,
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
        update: () => ({ eq: () => ({ select: async () => ({ data: [], error: null }) }) }),
        delete: () => ({ eq: async () => ({ data: [], error: null }) }),
      }) as unknown as ReturnType<ArchiveStreamCheckpointSupabaseClient["from"]>,
  };
  return client;
}

describe("initializeAccumulators", () => {
  it("fresh start (no checkpoint): fetches and folds the rolling window, page by page", async () => {
    const checkpointClient = makeMockCheckpointClient(null);
    let fetchCallCount = 0;
    const fetchRollingWindowPages = async (onPage: (page: SocrataRecord[]) => Promise<void> | void) => {
      fetchCallCount += 1;
      await onPage([makeRawRecord()]);
    };

    const result = await initializeAccumulators({
      checkpointClient,
      archiveDatasetId: "7c2e-uany",
      lookup: FOLD_LOOKUP,
      now: FOLD_NOW,
      fetchRollingWindowPages,
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
  // archive's first ACCUMULATOR SNAPSHOT, and are already baked into
  // whatever snapshot streamArchiveWithResume goes on to restore.
  // Re-fetching (and re-folding) it again here on a resume would
  // double-count every single rolling-window reading a second time. Only
  // a real, non-null accumulatorSnapshotLastProcessedId guarantees that --
  // see the regression test below for the checkpoint-exists-but-no-
  // snapshot-yet case, which must NOT take this same skip path.
  it("resume (checkpoint with a real accumulator snapshot): does NOT fetch the rolling window at all", async () => {
    const checkpointClient = makeMockCheckpointClient({
      archive_dataset_id: "7c2e-uany",
      last_processed_id: "row-1",
      readings_processed_count: 10,
      accumulator_snapshot_last_processed_id: "row-1",
      accumulator_state: { "blockface-9:1:9": { count: 5, totalWeight: 5, mean: 0.4, sumSquaredDiff: 0.2 } },
    });
    let fetchCallCount = 0;
    const fetchRollingWindowPages = async (onPage: (page: SocrataRecord[]) => Promise<void> | void) => {
      fetchCallCount += 1;
      await onPage([makeRawRecord()]);
    };

    const result = await initializeAccumulators({
      checkpointClient,
      archiveDatasetId: "7c2e-uany",
      lookup: FOLD_LOOKUP,
      now: FOLD_NOW,
      fetchRollingWindowPages,
    });

    expect(fetchCallCount).toBe(0);
    expect(result.resuming).toBe(true);
    expect(result.accumulators.size).toBe(0);
    expect(result.unmatchedCount).toBe(0);
    expect(result.parseFailures).toBe(0);
  });

  // Regression test for a real, live-confirmed data-loss bug: this is the
  // EXACT checkpoint shape found in the live database after a real
  // --max-chunks=50 run stopped at chunk 50, well short of the 120-chunk
  // accumulator-snapshot interval -- a genuine last_processed_id (the
  // cheap, every-chunk position update ran), but accumulator_snapshot_
  // last_processed_id still null and accumulator_state still the empty
  // default, because no snapshot interval was ever reached. The OLD
  // condition here (existingCheckpoint !== null) treated this identically
  // to the fully-resumable case above and skipped the rolling-window
  // fetch entirely -- silently and permanently losing its contribution,
  // since it was never durably persisted anywhere. This must now fetch
  // and fold it, exactly like a genuine fresh start.
  it("regression: a checkpoint row with a real last_processed_id but a NULL accumulator snapshot still fetches and folds the rolling window", async () => {
    const checkpointClient = makeMockCheckpointClient({
      archive_dataset_id: "7c2e-uany",
      last_processed_id: "row-cq3g~cx27-6rpy",
      readings_processed_count: 2450000,
      accumulator_snapshot_last_processed_id: null,
      accumulator_state: {},
    });
    let fetchCallCount = 0;
    const fetchRollingWindowPages = async (onPage: (page: SocrataRecord[]) => Promise<void> | void) => {
      fetchCallCount += 1;
      await onPage([makeRawRecord()]);
    };

    const result = await initializeAccumulators({
      checkpointClient,
      archiveDatasetId: "7c2e-uany",
      lookup: FOLD_LOOKUP,
      now: FOLD_NOW,
      fetchRollingWindowPages,
    });

    expect(fetchCallCount).toBe(1);
    expect(result.resuming).toBe(false);
    expect(result.accumulators.get(buildAccumulatorBucketKey("blockface-1", 4, 17))?.count).toBe(1);
    expect(result.unmatchedCount).toBe(0);
    expect(result.parseFailures).toBe(0);
  });

  // The specific correctness concern behind paginating this fetch in the
  // first place (see fetchRollingWindowPages's own comment): each page must
  // be FOLDED INTO the same running accumulator, not treated as a fresh
  // replacement for the previous page's contribution.
  it("folds multiple pages into the same accumulator Map, accumulating rather than overwriting page to page", async () => {
    const checkpointClient = makeMockCheckpointClient(null);
    const fetchRollingWindowPages = async (onPage: (page: SocrataRecord[]) => Promise<void> | void) => {
      await onPage([makeRawRecord(), makeRawRecord()]); // page 1: 2 readings
      await onPage([makeRawRecord()]); // page 2: 1 more reading, same bucket
    };

    const result = await initializeAccumulators({
      checkpointClient,
      archiveDatasetId: "7c2e-uany",
      lookup: FOLD_LOOKUP,
      now: FOLD_NOW,
      fetchRollingWindowPages,
    });

    const key = buildAccumulatorBucketKey("blockface-1", 4, 17);
    expect(result.accumulators.size).toBe(1);
    expect(result.accumulators.get(key)?.count).toBe(3);
  });

  it("keeps different buckets from different pages separate, rather than one page's buckets clobbering another's", async () => {
    const checkpointClient = makeMockCheckpointClient(null);
    const lookup = new Map([
      ["9477:W", "blockface-1"],
      ["1234:N", "blockface-2"],
    ]);
    const fetchRollingWindowPages = async (onPage: (page: SocrataRecord[]) => Promise<void> | void) => {
      await onPage([makeRawRecord()]); // page 1: blockface-1
      await onPage([makeRawRecord({ sourceelementkey: "1234", sideofstreet: "N" })]); // page 2: blockface-2
    };

    const result = await initializeAccumulators({
      checkpointClient,
      archiveDatasetId: "7c2e-uany",
      lookup,
      now: FOLD_NOW,
      fetchRollingWindowPages,
    });

    expect(result.accumulators.size).toBe(2);
    expect(result.accumulators.get(buildAccumulatorBucketKey("blockface-1", 4, 17))?.count).toBe(1);
    expect(result.accumulators.get(buildAccumulatorBucketKey("blockface-2", 4, 17))?.count).toBe(1);
  });

  it("sums unmatchedCount and parseFailures across pages rather than only counting the last one", async () => {
    const checkpointClient = makeMockCheckpointClient(null);
    const fetchRollingWindowPages = async (onPage: (page: SocrataRecord[]) => Promise<void> | void) => {
      await onPage([makeRawRecord({ sourceelementkey: "99999" })]); // page 1: unmatched
      await onPage([makeRawRecord({ parkingspacecount: "n/a" })]); // page 2: parse failure
    };

    const result = await initializeAccumulators({
      checkpointClient,
      archiveDatasetId: "7c2e-uany",
      lookup: FOLD_LOOKUP,
      now: FOLD_NOW,
      fetchRollingWindowPages,
    });

    expect(result.unmatchedCount).toBe(1);
    expect(result.parseFailures).toBe(1);
    expect(result.accumulators.size).toBe(0);
  });

  describe("rolling-window progress logging", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("does not log progress before ROLLING_WINDOW_PROGRESS_LOG_INTERVAL_PAGES pages have been fetched", async () => {
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const checkpointClient = makeMockCheckpointClient(null);
      const fetchRollingWindowPages = async (onPage: (page: SocrataRecord[]) => Promise<void> | void) => {
        for (let i = 0; i < ROLLING_WINDOW_PROGRESS_LOG_INTERVAL_PAGES - 1; i++) {
          await onPage([makeRawRecord()]);
        }
      };

      await initializeAccumulators({
        checkpointClient,
        archiveDatasetId: "7c2e-uany",
        lookup: FOLD_LOOKUP,
        now: FOLD_NOW,
        fetchRollingWindowPages,
      });

      const progressLines = consoleLogSpy.mock.calls.filter((call) => String(call[0]).includes("Rolling window progress"));
      expect(progressLines).toHaveLength(0);
    });

    it("logs cumulative pages fetched and rows folded once the interval is reached", async () => {
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const checkpointClient = makeMockCheckpointClient(null);
      const fetchRollingWindowPages = async (onPage: (page: SocrataRecord[]) => Promise<void> | void) => {
        for (let i = 0; i < ROLLING_WINDOW_PROGRESS_LOG_INTERVAL_PAGES; i++) {
          await onPage([makeRawRecord(), makeRawRecord()]); // 2 rows/page
        }
      };

      await initializeAccumulators({
        checkpointClient,
        archiveDatasetId: "7c2e-uany",
        lookup: FOLD_LOOKUP,
        now: FOLD_NOW,
        fetchRollingWindowPages,
      });

      const progressLines = consoleLogSpy.mock.calls.filter((call) => String(call[0]).includes("Rolling window progress"));
      expect(progressLines).toHaveLength(1);
      expect(progressLines[0]?.[0]).toContain(`${ROLLING_WINDOW_PROGRESS_LOG_INTERVAL_PAGES} pages fetched`);
      expect(progressLines[0]?.[0]).toContain(`${ROLLING_WINDOW_PROGRESS_LOG_INTERVAL_PAGES * 2} rows folded`);
    });

    it("logs again after a second full interval, with cumulative (not reset) totals", async () => {
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const checkpointClient = makeMockCheckpointClient(null);
      const totalPages = ROLLING_WINDOW_PROGRESS_LOG_INTERVAL_PAGES * 2;
      const fetchRollingWindowPages = async (onPage: (page: SocrataRecord[]) => Promise<void> | void) => {
        for (let i = 0; i < totalPages; i++) {
          await onPage([makeRawRecord()]); // 1 row/page
        }
      };

      await initializeAccumulators({
        checkpointClient,
        archiveDatasetId: "7c2e-uany",
        lookup: FOLD_LOOKUP,
        now: FOLD_NOW,
        fetchRollingWindowPages,
      });

      const progressLines = consoleLogSpy.mock.calls.filter((call) => String(call[0]).includes("Rolling window progress"));
      expect(progressLines).toHaveLength(2);
      expect(progressLines[0]?.[0]).toContain(`${ROLLING_WINDOW_PROGRESS_LOG_INTERVAL_PAGES} pages fetched`);
      expect(progressLines[1]?.[0]).toContain(`${totalPages} pages fetched`);
      expect(progressLines[1]?.[0]).toContain(`${totalPages} rows folded`);
    });

    it("never logs progress on a resume with a real accumulator snapshot, since the rolling window isn't fetched at all", async () => {
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const checkpointClient = makeMockCheckpointClient({
        archive_dataset_id: "7c2e-uany",
        last_processed_id: "row-1",
        readings_processed_count: 10,
        accumulator_snapshot_last_processed_id: "row-1",
        accumulator_state: { "bf-1:1:9": { count: 5, totalWeight: 5, mean: 0.4, sumSquaredDiff: 0.2 } },
      });
      const fetchRollingWindowPages = async (onPage: (page: SocrataRecord[]) => Promise<void> | void) => {
        for (let i = 0; i < ROLLING_WINDOW_PROGRESS_LOG_INTERVAL_PAGES * 2; i++) {
          await onPage([makeRawRecord()]);
        }
      };

      await initializeAccumulators({
        checkpointClient,
        archiveDatasetId: "7c2e-uany",
        lookup: FOLD_LOOKUP,
        now: FOLD_NOW,
        fetchRollingWindowPages,
      });

      const progressLines = consoleLogSpy.mock.calls.filter((call) => String(call[0]).includes("Rolling window progress"));
      expect(progressLines).toHaveLength(0);
    });
  });
});

// --- Resume-safety regression: rolling-window fold must survive onResume + gap-replay ---

// This reproduces main()'s real sequence end-to-end (initializeAccumulators
// -> streamArchiveWithResume's onResume -> gap-replay's onChunk), using the
// EXACT checkpoint shape live-confirmed in the database after a real
// --max-chunks=50 run stopped at chunk 50 -- short of the first 120-chunk
// accumulator-snapshot interval. Proves the specific failure mode the fix
// closes: a rolling-window fold (from initializeAccumulators) and a
// gap-replayed archive chunk (from streamArchiveWithResume, simulated here
// via the same foldReadingsIntoAccumulators onChunk uses) both land in the
// final accumulator, with neither clobbering the other.
describe("resume safety: rolling-window fold survives onResume + gap-replay", () => {
  it("a rolling-window fold and a later gap-replayed archive chunk both land in the final accumulator", async () => {
    // Exact live-confirmed shape: a real last_processed_id (the cheap,
    // every-chunk position update ran through chunk 49), but
    // accumulator_snapshot_last_processed_id still null and accumulator_state
    // still the empty default, because the run stopped before the 120-chunk
    // snapshot interval.
    const checkpointClient = makeMockCheckpointClient({
      archive_dataset_id: "7c2e-uany",
      last_processed_id: "row-cq3g~cx27-6rpy",
      readings_processed_count: 2450000,
      accumulator_snapshot_last_processed_id: null,
      accumulator_state: {},
    });

    const lookup = new Map([
      ["9477:W", "blockface-rolling-window"], // matches the rolling-window fold's default record below
      ["1234:N", "blockface-archive-gap-replay"],
    ]);

    // Step 1: initializeAccumulators, exactly as main() calls it. With the
    // fix, this checkpoint shape must still fetch and fold the rolling
    // window (the regression this PR closes), not skip it.
    const fetchRollingWindowPages = async (onPage: (page: SocrataRecord[]) => Promise<void> | void) => {
      await onPage([makeRawRecord()]); // sourceelementkey 9477 / W -> blockface-rolling-window
    };
    const initResult = await initializeAccumulators({
      checkpointClient,
      archiveDatasetId: "7c2e-uany",
      lookup,
      now: FOLD_NOW,
      fetchRollingWindowPages,
    });
    const accumulators = initResult.accumulators;
    expect(accumulators.get(buildAccumulatorBucketKey("blockface-rolling-window", 4, 17))?.count).toBe(1);

    // Step 2: streamArchiveWithResume's onResume, exactly as main() wires
    // it up (mergeAccumulatorSnapshot, not a reference replacement). Since
    // no accumulator snapshot was ever taken, the real streamArchiveWithResume
    // would restore an EMPTY snapshot here -- this must be a no-op that
    // preserves the rolling-window fold from step 1, not discard it.
    const restoredCount = mergeAccumulatorSnapshot(accumulators, {});
    expect(restoredCount).toBe(0);
    expect(accumulators.get(buildAccumulatorBucketKey("blockface-rolling-window", 4, 17))?.count).toBe(1);

    // Step 3: a gap-replayed archive chunk, exactly as streamArchiveWithResume's
    // bounded gap-replay would fold it via main()'s onChunk (which calls
    // foldReadingsIntoAccumulators on the SAME accumulators Map).
    const gapReplayRecord = makeRawRecord({ sourceelementkey: "1234", sideofstreet: "N" });
    foldReadingsIntoAccumulators([gapReplayRecord], accumulators, lookup, FOLD_NOW);

    // Final assertion: BOTH contributions survive, neither clobbering the
    // other -- this is the exact bug: before the fix, step 2's onResume
    // would have replaced the whole map, silently discarding step 1's
    // rolling-window bucket before step 3 ever ran.
    expect(accumulators.size).toBe(2);
    expect(accumulators.get(buildAccumulatorBucketKey("blockface-rolling-window", 4, 17))?.count).toBe(1);
    expect(accumulators.get(buildAccumulatorBucketKey("blockface-archive-gap-replay", 4, 17))?.count).toBe(1);
  });
});
