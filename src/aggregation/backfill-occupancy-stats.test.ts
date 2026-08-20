import { describe, expect, it, vi } from "vitest";
import {
  accumulateComboSummary,
  buildAllBucketCombos,
  buildBucketWhereClause,
  buildRollingBucketsForCombo,
  bucketComboKey,
  createEmptyComboSummary,
  fetchOperatingHourRange,
  fetchProgressStatuses,
  logBucketFailure,
  markComboStatus,
  parseCliOptions,
  parseRawReading,
  parseRawReadings,
  partitionByBucket,
  processCombo,
  runMainPass,
  runRetryPass,
  selectCombosToRun,
} from "./backfill-occupancy-stats.ts";
import type {
  BackfillFailuresRow,
  BackfillFailuresSupabaseClient,
  BackfillProgressSupabaseClient,
  BackfillProgressStatusRow,
  ComboSummary,
  OperatingHoursSupabaseClient,
} from "./backfill-occupancy-stats.ts";
import type { RawReading } from "./blockfaceLookup.ts";
import type { OccupancyStatsSupabaseClient } from "./upsertOccupancyStats.ts";
import type { SocrataRecord } from "../utils/fetchSocrataRecords.ts";

// --- parseCliOptions ---------------------------------------------------

describe("parseCliOptions", () => {
  it("returns combo: null when no --combo flag is given", () => {
    expect(parseCliOptions([])).toEqual({ combo: null });
  });

  it("parses a valid --combo=<isoDay>:<hour>", () => {
    expect(parseCliOptions(["--combo=3:14"])).toEqual({ combo: { isoDay: 3, hour: 14 } });
  });

  it("throws for a malformed --combo value (no colon)", () => {
    expect(() => parseCliOptions(["--combo=abc"])).toThrow(/must be in the form/);
  });

  it("throws for an out-of-range day", () => {
    expect(() => parseCliOptions(["--combo=8:9"])).toThrow(/day must be an integer 1-7/);
    expect(() => parseCliOptions(["--combo=0:9"])).toThrow(/day must be an integer 1-7/);
  });

  it("throws for an out-of-range hour", () => {
    expect(() => parseCliOptions(["--combo=3:24"])).toThrow(/hour must be an integer 0-23/);
    expect(() => parseCliOptions(["--combo=3:-1"])).toThrow(/hour must be an integer 0-23/);
  });
});

// --- buildAllBucketCombos / bucketComboKey ------------------------------

describe("buildAllBucketCombos", () => {
  it("builds 7 days * N hours for the given hour range, inclusive", () => {
    const combos = buildAllBucketCombos({ startHour: 8, endHour: 21 });
    expect(combos).toHaveLength(7 * 14); // 8..21 inclusive = 14 hours
  });

  it("spans ISO days 1-7 and the given hour range, with no duplicates", () => {
    const combos = buildAllBucketCombos({ startHour: 8, endHour: 21 });
    const keys = new Set(combos.map(bucketComboKey));
    expect(keys.size).toBe(7 * 14);

    const days = new Set(combos.map((c) => c.isoDay));
    expect(days).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]));

    const hours = new Set(combos.map((c) => c.hour));
    expect(Math.min(...hours)).toBe(8);
    expect(Math.max(...hours)).toBe(21);
  });

  it("handles a single-hour range", () => {
    const combos = buildAllBucketCombos({ startHour: 9, endHour: 9 });
    expect(combos).toHaveLength(7);
    expect(new Set(combos.map((c) => c.hour))).toEqual(new Set([9]));
  });
});

describe("bucketComboKey", () => {
  it("joins isoDay and hour with a colon", () => {
    expect(bucketComboKey({ isoDay: 3, hour: 14 })).toBe("3:14");
  });
});

// --- fetchOperatingHourRange -----------------------------------------------

function createMockOperatingHoursClient(options: {
  minStartRows?: Record<string, string>[];
  minStartError?: { message: string } | null;
  maxEndRows?: Record<string, string>[];
  maxEndError?: { message: string } | null;
}) {
  const orCalls: string[] = [];
  const orderCalls: { column: string; ascending: boolean }[] = [];

  const client: OperatingHoursSupabaseClient = {
    from: () => ({
      select: (columns: string) => ({
        or: (filter: string) => {
          orCalls.push(filter);
          return {
            order: (column: string, opts: { ascending: boolean }) => {
              orderCalls.push({ column, ascending: opts.ascending });
              return {
                limit: async () => {
                  const isStartQuery = columns === "operating_hours_start";
                  if (isStartQuery) {
                    return options.minStartError !== undefined && options.minStartError !== null
                      ? { data: null, error: options.minStartError }
                      : { data: options.minStartRows ?? [], error: null };
                  }
                  return options.maxEndError !== undefined && options.maxEndError !== null
                    ? { data: null, error: options.maxEndError }
                    : { data: options.maxEndRows ?? [], error: null };
                },
              };
            },
          };
        },
      }),
    }),
  };

  return { client, orCalls, orderCalls };
}

describe("fetchOperatingHourRange", () => {
  it("returns the hour components of the min start and max end, excluding placeholder rows", async () => {
    const { client, orCalls, orderCalls } = createMockOperatingHoursClient({
      minStartRows: [{ operating_hours_start: "08:00:00" }],
      maxEndRows: [{ operating_hours_end: "21:59:00" }],
    });

    const range = await fetchOperatingHourRange(client);

    expect(range).toEqual({ startHour: 8, endHour: 21 });
    // Both queries exclude the exact 00:00/23:59 placeholder pair via
    // De Morgan's law (start<>00:00 OR end<>23:59), since aggregate
    // functions are disabled on this Supabase project.
    expect(orCalls).toEqual([
      "operating_hours_start.neq.00:00,operating_hours_end.neq.23:59",
      "operating_hours_start.neq.00:00,operating_hours_end.neq.23:59",
    ]);
    expect(orderCalls).toEqual([
      { column: "operating_hours_start", ascending: true },
      { column: "operating_hours_end", ascending: false },
    ]);
  });

  it("throws a clear error when the min-start query fails", async () => {
    const { client } = createMockOperatingHoursClient({ minStartError: { message: "connection reset" } });
    await expect(fetchOperatingHourRange(client)).rejects.toThrow(/minimum operating_hours_start.*connection reset/s);
  });

  it("throws a clear error when the max-end query fails", async () => {
    const { client } = createMockOperatingHoursClient({
      minStartRows: [{ operating_hours_start: "08:00:00" }],
      maxEndError: { message: "connection reset" },
    });
    await expect(fetchOperatingHourRange(client)).rejects.toThrow(/maximum operating_hours_end.*connection reset/s);
  });

  it("throws when no rows have a genuine (non-placeholder) schedule", async () => {
    const { client } = createMockOperatingHoursClient({ minStartRows: [], maxEndRows: [] });
    await expect(fetchOperatingHourRange(client)).rejects.toThrow(/no blockfaces rows have a genuine/);
  });
});

// --- buildBucketWhereClause ---------------------------------------------

describe("buildBucketWhereClause", () => {
  it("builds a $where clause using Socrata's dow convention for a weekday", () => {
    // ISO Monday (1) -> Socrata dow 1 (no remapping needed).
    expect(buildBucketWhereClause({ isoDay: 1, hour: 9 })).toBe(
      "date_extract_dow(occupancydatetime)=1 AND date_extract_hh(occupancydatetime)=9",
    );
  });

  it("converts ISO Sunday (7) to Socrata's dow 0 -- the one remapping case", () => {
    expect(buildBucketWhereClause({ isoDay: 7, hour: 20 })).toBe(
      "date_extract_dow(occupancydatetime)=0 AND date_extract_hh(occupancydatetime)=20",
    );
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

// --- partitionByBucket ---------------------------------------------------

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

describe("partitionByBucket", () => {
  it("groups readings into their isoDay:hour bucket", () => {
    const readings = [makeReading(), makeReading({ paidOccupancy: 2 })];
    const { buckets, parseFailures } = partitionByBucket(readings);

    expect(buckets.get(bucketComboKey({ isoDay: 4, hour: 17 }))).toHaveLength(2);
    expect(parseFailures).toBe(0);
  });

  it("keeps different buckets separate", () => {
    const readings = [
      makeReading({ occupancyDateTime: "2026-07-30T17:38:00.000" }), // Thu 17
      makeReading({ occupancyDateTime: "2026-08-02T09:00:00.000" }), // Sun 09 (ISO 7)
    ];
    const { buckets } = partitionByBucket(readings);

    expect(buckets.size).toBe(2);
    expect(buckets.get(bucketComboKey({ isoDay: 4, hour: 17 }))).toHaveLength(1);
    expect(buckets.get(bucketComboKey({ isoDay: 7, hour: 9 }))).toHaveLength(1);
  });

  it("skips a reading with an unparseable occupancyDateTime and counts it, without aborting", () => {
    const readings = [makeReading(), makeReading({ occupancyDateTime: "not-a-date" })];
    const { buckets, parseFailures } = partitionByBucket(readings);

    expect(parseFailures).toBe(1);
    expect(buckets.get(bucketComboKey({ isoDay: 4, hour: 17 }))).toHaveLength(1);
  });

  it("handles an empty array cleanly, not as an error", () => {
    const { buckets, parseFailures } = partitionByBucket([]);
    expect(buckets.size).toBe(0);
    expect(parseFailures).toBe(0);
  });
});

describe("buildRollingBucketsForCombo", () => {
  it("fetches only the given combo's slice, using the same server-side where clause as the archive", async () => {
    const combo = { isoDay: 4, hour: 17 };
    const whereClauses: string[] = [];
    const fetchRollingRecords = async (whereClause: string) => {
      whereClauses.push(whereClause);
      return [makeRawRecord(), makeRawRecord()];
    };

    const { buckets, parseFailures } = await buildRollingBucketsForCombo(combo, fetchRollingRecords);

    expect(whereClauses).toEqual([buildBucketWhereClause(combo)]);
    expect(buckets.size).toBe(1);
    expect(buckets.get(bucketComboKey(combo))).toHaveLength(2);
    expect(parseFailures).toBe(0);
  });

  it("counts unparseable records without throwing", async () => {
    const combo = { isoDay: 4, hour: 17 };
    const fetchRollingRecords = async () => [makeRawRecord(), makeRawRecord({ paidoccupancy: "not-a-number" })];

    const { buckets, parseFailures } = await buildRollingBucketsForCombo(combo, fetchRollingRecords);

    expect(buckets.get(bucketComboKey(combo))).toHaveLength(1);
    expect(parseFailures).toBe(1);
  });

  it("propagates a failure in the fetch itself", async () => {
    const combo = { isoDay: 4, hour: 17 };
    const fetchRollingRecords = async () => {
      throw new Error("socrata request failed");
    };

    await expect(buildRollingBucketsForCombo(combo, fetchRollingRecords)).rejects.toThrow("socrata request failed");
  });
});

// --- selectCombosToRun ---------------------------------------------------

describe("selectCombosToRun", () => {
  const combos = [
    { isoDay: 1, hour: 8 },
    { isoDay: 1, hour: 9 },
    { isoDay: 1, hour: 10 },
    { isoDay: 1, hour: 11 },
  ];

  it("skips 'complete' combos and retries pending/in_progress/failed ones", () => {
    const statuses = new Map([
      [bucketComboKey(combos[0]!), "complete"],
      [bucketComboKey(combos[1]!), "pending"],
      [bucketComboKey(combos[2]!), "in_progress"],
      [bucketComboKey(combos[3]!), "failed"],
    ]);

    expect(selectCombosToRun(combos, statuses)).toEqual([combos[1], combos[2], combos[3]]);
  });

  it("treats a combo with no progress row at all the same as pending (runs it)", () => {
    expect(selectCombosToRun(combos, new Map())).toEqual(combos);
  });
});

// --- fetchProgressStatuses / markComboStatus ------------------------------

function createMockProgressClient(rows: BackfillProgressStatusRow[], selectError: { message: string } | null = null) {
  const upsertCalls: Record<string, unknown>[] = [];
  const upsert = vi.fn(async (row: Record<string, unknown>) => {
    upsertCalls.push(row);
    return { data: null, error: null };
  });
  const client: BackfillProgressSupabaseClient = {
    from: () => ({
      select: async () => (selectError === null ? { data: rows, error: null } : { data: null, error: selectError }),
      upsert,
    }),
  };
  return { client, upsertCalls };
}

describe("fetchProgressStatuses", () => {
  it("builds a Map keyed by isoDay:hour to status", async () => {
    const { client } = createMockProgressClient([
      { iso_day: 1, hour: 8, status: "complete" },
      { iso_day: 2, hour: 9, status: "failed" },
    ]);

    const statuses = await fetchProgressStatuses(client);

    expect(statuses.get("1:8")).toBe("complete");
    expect(statuses.get("2:9")).toBe("failed");
    expect(statuses.size).toBe(2);
  });

  it("throws a clear error when the read fails", async () => {
    const { client } = createMockProgressClient([], { message: "connection reset" });
    await expect(fetchProgressStatuses(client)).rejects.toThrow(/connection reset/);
  });
});

describe("markComboStatus", () => {
  it("sets started_at and clears completed_at when marking in_progress", async () => {
    const { client, upsertCalls } = createMockProgressClient([]);

    await markComboStatus(client, { isoDay: 1, hour: 8 }, "in_progress", null);

    const call = upsertCalls[0];
    expect(call).toMatchObject({ iso_day: 1, hour: 8, status: "in_progress", error_message: null, completed_at: null });
    expect(typeof call?.started_at).toBe("string");
  });

  it("sets completed_at and a real error_message when marking failed", async () => {
    const { client, upsertCalls } = createMockProgressClient([]);

    await markComboStatus(client, { isoDay: 1, hour: 8 }, "failed", "socrata timed out");

    const call = upsertCalls[0];
    expect(call).toMatchObject({ iso_day: 1, hour: 8, status: "failed", error_message: "socrata timed out" });
    expect(typeof call?.completed_at).toBe("string");
  });

  it("does not throw when the upsert itself fails -- logs and continues", async () => {
    const client: BackfillProgressSupabaseClient = {
      from: () => ({
        select: async () => ({ data: [], error: null }),
        upsert: async () => ({ data: null, error: { message: "write failed" } }),
      }),
    };

    await expect(markComboStatus(client, { isoDay: 1, hour: 8 }, "complete", null)).resolves.toBeUndefined();
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

// --- processCombo ----------------------------------------------------------

function createMockOccupancyStatsClient(failForBlockfaceIds: Set<string> = new Set()) {
  const upsertCalls: Record<string, unknown>[] = [];
  const client: OccupancyStatsSupabaseClient = {
    from: () => ({
      upsert: async (row: Record<string, unknown>) => {
        upsertCalls.push(row);
        const blockfaceId = row.blockface_id as string;
        if (failForBlockfaceIds.has(blockfaceId)) {
          return { data: null, error: { message: `simulated failure for ${blockfaceId}` } };
        }
        return { data: null, error: null };
      },
    }),
  };
  return { client, upsertCalls };
}

const NOW = new Date("2026-08-19T12:00:00Z");
const LOOKUP = new Map([["9477:W", "blockface-1"]]);

function makeManyReadings(count: number, overrides: Partial<RawReading> = {}): RawReading[] {
  return Array.from({ length: count }, (_, i) => makeReading({ paidOccupancy: i % 8, ...overrides }));
}

describe("processCombo", () => {
  it("combines archive and rolling readings, writing stats only once enough of both together clear the threshold", async () => {
    const { client: occupancyStatsClient, upsertCalls } = createMockOccupancyStatsClient();
    const { client: failuresClient } = createMockFailuresClient();
    // 16 archive + 16 rolling = 32, over MIN_READINGS_PER_BUCKET (30) only
    // when combined -- neither source alone (16 < 30) would be enough on
    // its own, proving the two are genuinely combined into one group, not
    // processed (or thresholded) independently.
    const archiveRecords: SocrataRecord[] = Array.from({ length: 16 }, () => makeRawRecord());
    const rollingReadings = makeManyReadings(16);

    const summary = await processCombo(
      { isoDay: 4, hour: 17 },
      {
        occupancyStatsClient,
        failuresClient,
        fetchArchiveRecords: async () => archiveRecords,
        lookup: LOOKUP,
        rollingReadings,
        now: NOW,
      },
    );

    expect(summary.written).toBe(1);
    expect(upsertCalls[0]).toMatchObject({ blockface_id: "blockface-1", sample_count: 32 });
  });

  it("parses real string-typed Socrata archive records and writes a block with enough combined data", async () => {
    const { client: occupancyStatsClient, upsertCalls } = createMockOccupancyStatsClient();
    const { client: failuresClient } = createMockFailuresClient();
    const archiveRecords: SocrataRecord[] = Array.from({ length: 20 }, () => makeRawRecord());
    const rollingReadings = makeManyReadings(15);

    const summary = await processCombo(
      { isoDay: 4, hour: 17 },
      {
        occupancyStatsClient,
        failuresClient,
        fetchArchiveRecords: async () => archiveRecords,
        lookup: LOOKUP,
        rollingReadings,
        now: NOW,
      },
    );

    expect(summary.written).toBe(1);
    expect(summary.parseFailures).toBe(0);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({ blockface_id: "blockface-1", day_of_week: 4, hour_of_day: 17 });
  });

  it("skips (does not write) a block with fewer than MIN_READINGS_PER_BUCKET combined readings", async () => {
    const { client: occupancyStatsClient, upsertCalls } = createMockOccupancyStatsClient();
    const { client: failuresClient } = createMockFailuresClient();

    const summary = await processCombo(
      { isoDay: 4, hour: 17 },
      {
        occupancyStatsClient,
        failuresClient,
        fetchArchiveRecords: async () => [],
        lookup: LOOKUP,
        rollingReadings: makeManyReadings(5),
        now: NOW,
      },
    );

    expect(summary.written).toBe(0);
    expect(summary.skippedInsufficientData).toBe(1);
    expect(upsertCalls).toHaveLength(0);
  });

  it("counts unmatched readings without failing the combo", async () => {
    const { client: occupancyStatsClient } = createMockOccupancyStatsClient();
    const { client: failuresClient } = createMockFailuresClient();
    const unmatchedReadings = makeManyReadings(10, { sourceElementKey: 99999 });

    const summary = await processCombo(
      { isoDay: 4, hour: 17 },
      {
        occupancyStatsClient,
        failuresClient,
        fetchArchiveRecords: async () => [],
        lookup: LOOKUP,
        rollingReadings: unmatchedReadings,
        now: NOW,
      },
    );

    expect(summary.unmatched).toBe(10);
    expect(summary.written).toBe(0);
  });

  it("logs an occupancy_stats write failure and continues, without throwing", async () => {
    const { client: occupancyStatsClient } = createMockOccupancyStatsClient(new Set(["blockface-1"]));
    const { client: failuresClient, upsertCalls: failureUpsertCalls } = createMockFailuresClient();

    const summary = await processCombo(
      { isoDay: 4, hour: 17 },
      {
        occupancyStatsClient,
        failuresClient,
        fetchArchiveRecords: async () => [],
        lookup: LOOKUP,
        rollingReadings: makeManyReadings(35),
        now: NOW,
      },
    );

    expect(summary.written).toBe(0);
    expect(summary.blockfaceFailures).toBe(1);
    expect(failureUpsertCalls[0]).toMatchObject({ blockface_id: "blockface-1", error_message: expect.stringContaining("simulated failure") });
  });

  it("propagates a failure in the archive fetch itself (does not catch it)", async () => {
    const { client: occupancyStatsClient } = createMockOccupancyStatsClient();
    const { client: failuresClient } = createMockFailuresClient();

    await expect(
      processCombo(
        { isoDay: 4, hour: 17 },
        {
          occupancyStatsClient,
          failuresClient,
          fetchArchiveRecords: async () => {
            throw new Error("socrata request failed");
          },
          lookup: LOOKUP,
          rollingReadings: [],
          now: NOW,
        },
      ),
    ).rejects.toThrow("socrata request failed");
  });
});

// --- runMainPass -------------------------------------------------------

describe("runMainPass", () => {
  it("marks a combo in_progress then complete on success, and accumulates the summary", async () => {
    const { client: progressClient, upsertCalls } = createMockProgressClient([]);
    const fakeComboSummary: ComboSummary = { written: 2, skippedInsufficientData: 1, unmatched: 3, blockfaceFailures: 0, parseFailures: 0 };
    const processComboFn = vi.fn().mockResolvedValue(fakeComboSummary);

    const summary = await runMainPass([{ isoDay: 1, hour: 8 }], {
      occupancyStatsClient: createMockOccupancyStatsClient().client,
      progressClient,
      failuresClient: createMockFailuresClient().client,
      archiveDatasetId: "7c2e-uany",
      rollingBuckets: new Map(),
      lookup: new Map(),
      now: NOW,
      processComboFn,
    });

    expect(summary).toEqual(fakeComboSummary);
    expect(upsertCalls.map((c) => c.status)).toEqual(["in_progress", "complete"]);
  });

  it("marks a combo failed with a real error message when processComboFn throws", async () => {
    const { client: progressClient, upsertCalls } = createMockProgressClient([]);
    const processComboFn = vi.fn().mockRejectedValue(new Error("socrata timed out"));

    const summary = await runMainPass([{ isoDay: 1, hour: 8 }], {
      occupancyStatsClient: createMockOccupancyStatsClient().client,
      progressClient,
      failuresClient: createMockFailuresClient().client,
      archiveDatasetId: "7c2e-uany",
      rollingBuckets: new Map(),
      lookup: new Map(),
      now: NOW,
      processComboFn,
    });

    expect(summary).toEqual(createEmptyComboSummary());
    expect(upsertCalls.map((c) => c.status)).toEqual(["in_progress", "failed"]);
    expect(upsertCalls[1]).toMatchObject({ error_message: "socrata timed out" });
  });

  it("processes multiple combos independently, one failure not stopping the rest", async () => {
    const { client: progressClient, upsertCalls } = createMockProgressClient([]);
    const processComboFn = vi
      .fn()
      .mockResolvedValueOnce({ written: 1, skippedInsufficientData: 0, unmatched: 0, blockfaceFailures: 0, parseFailures: 0 })
      .mockRejectedValueOnce(new Error("broke"))
      .mockResolvedValueOnce({ written: 4, skippedInsufficientData: 0, unmatched: 0, blockfaceFailures: 0, parseFailures: 0 });

    const summary = await runMainPass(
      [
        { isoDay: 1, hour: 8 },
        { isoDay: 1, hour: 9 },
        { isoDay: 1, hour: 10 },
      ],
      {
        occupancyStatsClient: createMockOccupancyStatsClient().client,
        progressClient,
        failuresClient: createMockFailuresClient().client,
        archiveDatasetId: "7c2e-uany",
        rollingBuckets: new Map(),
        lookup: new Map(),
        now: NOW,
        processComboFn,
      },
    );

    expect(summary.written).toBe(5);
    expect(upsertCalls.filter((c) => c.status === "failed")).toHaveLength(1);
    expect(upsertCalls.filter((c) => c.status === "complete")).toHaveLength(2);
  });
});

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

    expect(summary).toEqual({ retriedSuccessfully: 1, remainingFailures: 0 });
    expect(upsertCalls[0]).toMatchObject({ blockface_id: "bf-1", day_of_week: 1, hour_of_day: 8, mean_occupancy: 0.5 });
    expect(deleteCalls).toEqual(["f-1"]);
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

    expect(summary).toEqual({ retriedSuccessfully: 0, remainingFailures: 1 });
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

    expect(summary).toEqual({ retriedSuccessfully: 0, remainingFailures: 1 });
    expect(upsertCalls).toHaveLength(0);
  });

  it("handles an empty occupancy_stats_backfill_failures table cleanly, not as an error", async () => {
    const { client: failuresClient } = createMockFailuresClient({ rowsForRetryPass: [] });
    const { client: occupancyStatsClient } = createMockOccupancyStatsClient();

    const summary = await runRetryPass({ occupancyStatsClient, failuresClient });

    expect(summary).toEqual({ retriedSuccessfully: 0, remainingFailures: 0 });
  });

  it("throws a clear error when reading occupancy_stats_backfill_failures itself fails", async () => {
    const { client: failuresClient } = createMockFailuresClient({ retrySelectError: { message: "connection reset" } });
    const { client: occupancyStatsClient } = createMockOccupancyStatsClient();

    await expect(runRetryPass({ occupancyStatsClient, failuresClient })).rejects.toThrow(/connection reset/);
  });
});

// --- accumulateComboSummary / createEmptyComboSummary ---------------------

describe("createEmptyComboSummary", () => {
  it("returns all-zero counts", () => {
    expect(createEmptyComboSummary()).toEqual({ written: 0, skippedInsufficientData: 0, unmatched: 0, blockfaceFailures: 0, parseFailures: 0 });
  });
});

describe("accumulateComboSummary", () => {
  it("adds one combo's counts into a running total", () => {
    const total = createEmptyComboSummary();
    accumulateComboSummary(total, { written: 2, skippedInsufficientData: 1, unmatched: 3, blockfaceFailures: 1, parseFailures: 0 });
    accumulateComboSummary(total, { written: 5, skippedInsufficientData: 0, unmatched: 1, blockfaceFailures: 0, parseFailures: 2 });

    expect(total).toEqual({ written: 7, skippedInsufficientData: 1, unmatched: 4, blockfaceFailures: 1, parseFailures: 2 });
  });
});
