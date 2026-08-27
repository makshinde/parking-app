import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARCHIVE_STREAM_PROGRESS_LOG_INTERVAL_CHUNKS,
  clearArchiveStreamCheckpoint,
  DEFAULT_ACCUMULATOR_SNAPSHOT_INTERVAL_CHUNKS,
  DEFAULT_STREAM_CHUNK_SIZE,
  fetchAccumulatorBuckets,
  fetchArchiveStreamCheckpoint,
  MAX_SNAPSHOT_WRITE_ATTEMPTS,
  saveArchiveStreamAccumulatorSnapshot,
  saveArchiveStreamPosition,
  streamArchiveWithResume,
  type ArchiveStreamAccumulatorBucketsSupabaseClient,
  type ArchiveStreamCheckpointSupabaseClient,
} from "./streamArchiveWithResume.ts";
import {
  addReading,
  createEmptyAccumulator,
} from "./incrementalWeightedStats.ts";
import { createMaxChunksOnChunk, MaxChunksReachedError } from "./backfill-occupancy-stats.ts";
import type { SocrataRecord } from "../utils/fetchSocrataRecords.ts";
import type {
  AccumulatorSnapshot,
  WeightedStatsAccumulator,
} from "./incrementalWeightedStats.ts";

const ARCHIVE_DATASET_ID = "7c2e-uany";

const SAMPLE_ACCUMULATOR_SNAPSHOT: AccumulatorSnapshot = {
  "bf-1:1:9": {
    count: 240,
    totalWeight: 118.4,
    mean: 0.62,
    sumSquaredDiff: 7.68,
  },
  "bf-2:1:9": {
    count: 180,
    totalWeight: 90.1,
    mean: 0.41,
    sumSquaredDiff: 5.02,
  },
};

// Mirrors buildAccumulatorBucketRow (streamArchiveWithResume.ts) -- written
// independently here rather than importing it, since that function isn't
// exported (an internal implementation detail), so this test constructs the
// same row shape a real write would produce to seed the mock bucket store.
function accumulatorSnapshotToBucketRows(
  archiveDatasetId: string,
  snapshot: AccumulatorSnapshot,
): Record<string, unknown>[] {
  return Object.entries(snapshot).map(([bucketKey, acc]) => {
    const [blockfaceId, isoDay, hour] = bucketKey.split(":");
    return {
      archive_dataset_id: archiveDatasetId,
      blockface_id: blockfaceId,
      iso_day: Number(isoDay),
      hour: Number(hour),
      count: acc.count,
      total_weight: acc.totalWeight,
      mean: acc.mean,
      sum_squared_diff: acc.sumSquaredDiff,
    };
  });
}

// --- Combined mock clients ---------------------------------------------
//
// checkpointClient and bucketsClient share ONE callOrder array (and one
// underlying "database") -- real usage always passes the same underlying
// supabase-js client cast to both narrow interfaces, and several tests
// below need to assert the real cross-table interleaving (e.g. bucket rows
// land before the checkpoint cursor advances).
//
// checkpointClient: eq-chainable select/maybeSingle, upsert (used by
// saveArchiveStreamPosition), update/eq/select (used by
// saveArchiveStreamAccumulatorSnapshot's cursor advance -- a genuine UPDATE,
// not an upsert, so .select() after .eq() is what makes the affected row
// count visible), and delete/eq.
//
// bucketsClient: eq/order/range-chainable select (paginated read-back, see
// fetchAccumulatorBuckets) and a batched upsert (see upsertAccumulatorBuckets),
// backed by an in-memory array keyed the same way the real table's UNIQUE
// constraint is (archive_dataset_id, blockface_id, iso_day, hour).
function makeMockClients(
  options: {
    existingCheckpointRow?: Record<string, unknown> | null;
    existingBucketRows?: Record<string, unknown>[];
    selectError?: { message: string } | null;
    positionUpsertError?: { message: string } | null;
    cursorUpdateError?: { message: string } | null;
    // Per-call override for the cursor update, consumed in call order --
    // undefined for a given index falls back to cursorUpdateError (or
    // success). Lets tests simulate "fails once, then succeeds" without a
    // single static error applying to every retry attempt.
    cursorUpdateErrorSequence?: ({ message: string } | null)[];
    bucketUpsertError?: { message: string } | null;
    bucketUpsertErrorSequence?: ({ message: string } | null)[];
    deleteError?: { message: string } | null;
  } = {},
) {
  let currentCheckpointRow: Record<string, unknown> | null =
    options.existingCheckpointRow ?? null;
  let bucketRows: Record<string, unknown>[] =
    options.existingBucketRows !== undefined
      ? [...options.existingBucketRows]
      : [];

  const positionUpsertCalls: Record<string, unknown>[] = [];
  const cursorUpdateCalls: {
    archiveDatasetId: string;
    values: Record<string, unknown>;
  }[] = [];
  const bucketUpsertCalls: Record<string, unknown>[][] = [];
  const bucketRangeCalls: { from: number; to: number }[] = [];
  const deleteCalls: unknown[] = [];
  const callOrder: string[] = [];
  let cursorUpdateCallIndex = 0;
  let bucketUpsertCallIndex = 0;

  const selectQueryBuilder = {
    eq: () => selectQueryBuilder,
    maybeSingle: async () =>
      options.selectError !== undefined && options.selectError !== null
        ? { data: null, error: options.selectError }
        : { data: currentCheckpointRow, error: null },
  };

  const checkpointClient = {
    from: () =>
      ({
        select: () => selectQueryBuilder,
        upsert: async (row: Record<string, unknown>) => {
          positionUpsertCalls.push(row);
          callOrder.push("position-upsert");
          if (
            options.positionUpsertError !== undefined &&
            options.positionUpsertError !== null
          ) {
            return { data: null, error: options.positionUpsertError };
          }
          currentCheckpointRow = { ...currentCheckpointRow, ...row };
          return { data: null, error: null };
        },
        update: (values: Record<string, unknown>) => ({
          eq: (_column: string, archiveDatasetId: string) => ({
            select: async () => {
              cursorUpdateCalls.push({ archiveDatasetId, values });
              callOrder.push("cursor-update");

              const sequenceError =
                options.cursorUpdateErrorSequence?.[cursorUpdateCallIndex];
              cursorUpdateCallIndex += 1;
              const errorForThisCall =
                sequenceError !== undefined
                  ? sequenceError
                  : options.cursorUpdateError;
              if (errorForThisCall !== undefined && errorForThisCall !== null) {
                return { data: null, error: errorForThisCall };
              }
              if (
                currentCheckpointRow === null ||
                currentCheckpointRow.archive_dataset_id !== archiveDatasetId
              ) {
                return { data: [], error: null };
              }
              currentCheckpointRow = { ...currentCheckpointRow, ...values };
              return { data: [currentCheckpointRow], error: null };
            },
          }),
        }),
        delete: () => ({
          eq: async (_column: string, value: unknown) => {
            deleteCalls.push(value);
            callOrder.push("delete");
            currentCheckpointRow = null;
            return options.deleteError !== undefined &&
              options.deleteError !== null
              ? { data: null, error: options.deleteError }
              : { data: [], error: null };
          },
        }),
      }) as unknown as ReturnType<
        ArchiveStreamCheckpointSupabaseClient["from"]
      >,
  } as unknown as ArchiveStreamCheckpointSupabaseClient;

  function bucketRowKey(row: Record<string, unknown>): string {
    return `${row.archive_dataset_id}:${row.blockface_id}:${row.iso_day}:${row.hour}`;
  }

  const bucketsClient = {
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
              bucketRangeCalls.push({ from, to });
              const filtered = bucketRows.filter(
                (row) => row.archive_dataset_id === filterArchiveDatasetId,
              );
              return { data: filtered.slice(from, to + 1), error: null };
            },
          };
          return builder;
        },
        upsert: async (batch: Record<string, unknown>[]) => {
          bucketUpsertCalls.push(batch);
          callOrder.push("bucket-upsert");

          const sequenceError =
            options.bucketUpsertErrorSequence?.[bucketUpsertCallIndex];
          bucketUpsertCallIndex += 1;
          const errorForThisCall =
            sequenceError !== undefined
              ? sequenceError
              : options.bucketUpsertError;
          if (errorForThisCall !== undefined && errorForThisCall !== null) {
            return { data: null, error: errorForThisCall };
          }

          for (const row of batch) {
            const key = bucketRowKey(row);
            const idx = bucketRows.findIndex(
              (existing) => bucketRowKey(existing) === key,
            );
            if (idx >= 0) {
              bucketRows[idx] = { ...bucketRows[idx], ...row };
            } else {
              bucketRows.push(row);
            }
          }
          return { data: null, error: null };
        },
      }) as unknown as ReturnType<
        ArchiveStreamAccumulatorBucketsSupabaseClient["from"]
      >,
  } as unknown as ArchiveStreamAccumulatorBucketsSupabaseClient;

  return {
    clients: { checkpointClient, bucketsClient },
    positionUpsertCalls,
    cursorUpdateCalls,
    bucketUpsertCalls,
    bucketRangeCalls,
    deleteCalls,
    callOrder,
    bucketRows: () => bucketRows,
  };
}

function jsonResponse(
  body: unknown,
  init?: { ok?: boolean; status?: number; statusText?: string },
) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    json: () => Promise.resolve(body),
  } as Response;
}

function makeRecords(count: number, idPrefix: string): SocrataRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    ":id": `row-${idPrefix}-${i}`,
    occupancydatetime: "2025-06-10T09:00:00",
  }));
}

describe("fetchArchiveStreamCheckpoint", () => {
  it("returns null when no checkpoint row exists yet", async () => {
    const { clients } = makeMockClients({ existingCheckpointRow: null });

    await expect(
      fetchArchiveStreamCheckpoint(
        clients.checkpointClient,
        ARCHIVE_DATASET_ID,
      ),
    ).resolves.toBeNull();
  });

  it("returns the parsed checkpoint, including both cursors, when a row exists", async () => {
    const { clients } = makeMockClients({
      existingCheckpointRow: {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        last_processed_id: "row-abc",
        readings_processed_count: 1500,
        accumulator_snapshot_last_processed_id: "row-xyz",
      },
    });

    await expect(
      fetchArchiveStreamCheckpoint(
        clients.checkpointClient,
        ARCHIVE_DATASET_ID,
      ),
    ).resolves.toEqual({
      archiveDatasetId: ARCHIVE_DATASET_ID,
      lastProcessedId: "row-abc",
      readingsProcessedCount: 1500,
      accumulatorSnapshotLastProcessedId: "row-xyz",
    });
  });

  it("returns null accumulatorSnapshotLastProcessedId when no snapshot has been taken yet", async () => {
    const { clients } = makeMockClients({
      existingCheckpointRow: {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        last_processed_id: "row-abc",
        readings_processed_count: 3,
        accumulator_snapshot_last_processed_id: null,
      },
    });

    const result = await fetchArchiveStreamCheckpoint(
      clients.checkpointClient,
      ARCHIVE_DATASET_ID,
    );
    expect(result?.accumulatorSnapshotLastProcessedId).toBeNull();
  });

  it("throws a clear error when reading the checkpoint fails", async () => {
    const { clients } = makeMockClients({
      selectError: { message: "connection reset" },
    });

    await expect(
      fetchArchiveStreamCheckpoint(
        clients.checkpointClient,
        ARCHIVE_DATASET_ID,
      ),
    ).rejects.toThrow(
      new RegExp(`archive_dataset_id=${ARCHIVE_DATASET_ID}.*connection reset`),
    );
  });
});

describe("saveArchiveStreamPosition", () => {
  it("upserts ONLY the position fields, never the accumulator snapshot cursor", async () => {
    const { clients, positionUpsertCalls } = makeMockClients();

    await saveArchiveStreamPosition(clients.checkpointClient, {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      lastProcessedId: "row-xyz",
      readingsProcessedCount: 250,
    });

    expect(positionUpsertCalls).toEqual([
      {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        last_processed_id: "row-xyz",
        readings_processed_count: 250,
      },
    ]);
  });

  it("throws a clear error when saving the position fails", async () => {
    const { clients } = makeMockClients({
      positionUpsertError: { message: "constraint violation" },
    });

    await expect(
      saveArchiveStreamPosition(clients.checkpointClient, {
        archiveDatasetId: ARCHIVE_DATASET_ID,
        lastProcessedId: "row-1",
        readingsProcessedCount: 1,
      }),
    ).rejects.toThrow(
      new RegExp(
        `archive_dataset_id=${ARCHIVE_DATASET_ID}.*constraint violation`,
      ),
    );
  });
});

describe("fetchAccumulatorBuckets", () => {
  it("returns an empty snapshot when no bucket rows exist for this archive", async () => {
    const { clients } = makeMockClients();

    await expect(
      fetchAccumulatorBuckets(clients.bucketsClient, ARCHIVE_DATASET_ID),
    ).resolves.toEqual({});
  });

  it("reconstructs an AccumulatorSnapshot from stored rows", async () => {
    const { clients } = makeMockClients({
      existingBucketRows: accumulatorSnapshotToBucketRows(
        ARCHIVE_DATASET_ID,
        SAMPLE_ACCUMULATOR_SNAPSHOT,
      ),
    });

    await expect(
      fetchAccumulatorBuckets(clients.bucketsClient, ARCHIVE_DATASET_ID),
    ).resolves.toEqual(SAMPLE_ACCUMULATOR_SNAPSHOT);
  });

  it("only reads rows for the requested archive_dataset_id, not other archives", async () => {
    const { clients } = makeMockClients({
      existingBucketRows: [
        ...accumulatorSnapshotToBucketRows(
          ARCHIVE_DATASET_ID,
          SAMPLE_ACCUMULATOR_SNAPSHOT,
        ),
        ...accumulatorSnapshotToBucketRows("wtpb-jp8d", {
          "bf-other:2:10": {
            count: 5,
            totalWeight: 5,
            mean: 0.9,
            sumSquaredDiff: 0.1,
          },
        }),
      ],
    });

    await expect(
      fetchAccumulatorBuckets(clients.bucketsClient, ARCHIVE_DATASET_ID),
    ).resolves.toEqual(SAMPLE_ACCUMULATOR_SNAPSHOT);
  });

  // Confirms the "page until a short page" pagination idiom actually walks
  // multiple pages rather than silently truncating at the first one --
  // real per-archive bucket counts can run into the tens or hundreds of
  // thousands (~1,500 blockfaces x 7 days x 24 hours max), far beyond one
  // page's worth of rows.
  it("paginates across multiple pages when there are more rows than one page holds", async () => {
    const snapshot: AccumulatorSnapshot = {};
    for (let i = 0; i < 1500; i++) {
      snapshot[`bf-${i}:1:9`] = {
        count: 1,
        totalWeight: 1,
        mean: 0.5,
        sumSquaredDiff: 0,
      };
    }
    const { clients, bucketRangeCalls } = makeMockClients({
      existingBucketRows: accumulatorSnapshotToBucketRows(
        ARCHIVE_DATASET_ID,
        snapshot,
      ),
    });

    const result = await fetchAccumulatorBuckets(
      clients.bucketsClient,
      ARCHIVE_DATASET_ID,
    );

    expect(Object.keys(result)).toHaveLength(1500);
    expect(result).toEqual(snapshot);
    // A 1000-row page size means 1500 rows needs exactly 2 .range() calls:
    // one full page (proving pagination continues), one short page (proving
    // it correctly stops there).
    expect(bucketRangeCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("throws a clear error when reading accumulator buckets fails", async () => {
    const failingBucketsClient = {
      from: () => ({
        select: () => {
          const builder = {
            eq: () => builder,
            order: () => builder,
            range: async () => ({
              data: null,
              error: { message: "connection reset" },
            }),
          };
          return builder;
        },
      }),
    } as unknown as ArchiveStreamAccumulatorBucketsSupabaseClient;

    await expect(
      fetchAccumulatorBuckets(failingBucketsClient, ARCHIVE_DATASET_ID),
    ).rejects.toThrow(
      new RegExp(`archive_dataset_id=${ARCHIVE_DATASET_ID}.*connection reset`),
    );
  });
});

describe("saveArchiveStreamAccumulatorSnapshot", () => {
  // The real precondition this function depends on: it's only ever called
  // after saveArchiveStreamPosition has already created the row for this
  // chunk (or against a checkpoint fetchArchiveStreamCheckpoint has already
  // confirmed exists), so a matching row is always present in real usage.
  const EXISTING_ROW = {
    archive_dataset_id: ARCHIVE_DATASET_ID,
    last_processed_id: "row-xyz",
    readings_processed_count: 500,
    accumulator_snapshot_last_processed_id: null,
  };

  it("batch-upserts every bucket in the accumulator state, then advances ONLY the snapshot cursor -- never last_processed_id or readings_processed_count", async () => {
    const { clients, bucketUpsertCalls, cursorUpdateCalls } = makeMockClients({
      existingCheckpointRow: EXISTING_ROW,
    });

    await saveArchiveStreamAccumulatorSnapshot(clients, {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      accumulatorSnapshotLastProcessedId: "row-xyz",
      accumulatorState: SAMPLE_ACCUMULATOR_SNAPSHOT,
    });

    expect(bucketUpsertCalls).toEqual([
      accumulatorSnapshotToBucketRows(
        ARCHIVE_DATASET_ID,
        SAMPLE_ACCUMULATOR_SNAPSHOT,
      ),
    ]);
    expect(cursorUpdateCalls).toEqual([
      {
        archiveDatasetId: ARCHIVE_DATASET_ID,
        values: { accumulator_snapshot_last_processed_id: "row-xyz" },
      },
    ]);
  });

  it("chunks a large accumulator state into multiple batched upserts of 500 rows each", async () => {
    const { clients, bucketUpsertCalls } = makeMockClients({
      existingCheckpointRow: EXISTING_ROW,
    });
    const largeState: AccumulatorSnapshot = {};
    for (let i = 0; i < 750; i++) {
      largeState[`bf-${i}:1:9`] = {
        count: 1,
        totalWeight: 1,
        mean: 0.5,
        sumSquaredDiff: 0,
      };
    }

    await saveArchiveStreamAccumulatorSnapshot(clients, {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      accumulatorSnapshotLastProcessedId: "row-xyz",
      accumulatorState: largeState,
    });

    expect(bucketUpsertCalls).toHaveLength(2);
    expect(bucketUpsertCalls[0]).toHaveLength(500);
    expect(bucketUpsertCalls[1]).toHaveLength(250);
  });

  it("writes nothing and advances the cursor cleanly when the accumulator state is empty", async () => {
    const { clients, bucketUpsertCalls, cursorUpdateCalls } = makeMockClients({
      existingCheckpointRow: EXISTING_ROW,
    });

    await saveArchiveStreamAccumulatorSnapshot(clients, {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      accumulatorSnapshotLastProcessedId: "row-xyz",
      accumulatorState: {},
    });

    expect(bucketUpsertCalls).toEqual([]);
    expect(cursorUpdateCalls).toHaveLength(1);
  });

  // Regression coverage for the atomicity guarantee this design depends on:
  // the cursor must NEVER advance if even one bucket row failed to land,
  // otherwise a resume would believe a snapshot exists that doesn't fully
  // exist.
  it("does not advance the snapshot cursor at all when the bucket upsert fails", async () => {
    vi.useFakeTimers();
    try {
      const { clients, bucketUpsertCalls, cursorUpdateCalls } = makeMockClients(
        {
          existingCheckpointRow: EXISTING_ROW,
          bucketUpsertError: { message: "connection reset" },
        },
      );

      const assertion = expect(
        saveArchiveStreamAccumulatorSnapshot(clients, {
          archiveDatasetId: ARCHIVE_DATASET_ID,
          accumulatorSnapshotLastProcessedId: "row-xyz",
          accumulatorState: SAMPLE_ACCUMULATOR_SNAPSHOT,
        }),
      ).rejects.toThrow(/connection reset/);
      await vi.runAllTimersAsync();
      await assertion;

      expect(bucketUpsertCalls.length).toBeGreaterThan(0);
      expect(cursorUpdateCalls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression test for a real, live-confirmed bug: an .upsert() with a
  // payload omitting last_processed_id reproducibly failed with a NOT NULL
  // violation even against an already-existing row, because Postgres/
  // PostgREST wasn't recognizing the conflict and attempted a fresh INSERT
  // instead. A genuine UPDATE sidesteps that -- but a plain UPDATE has its
  // own silent-failure mode (matching zero rows is not itself a PostgREST
  // error), which is exactly what this defensive row-count check exists to
  // catch instead of succeeding silently or failing with a confusing,
  // unrelated error later.
  //
  // This is the one kind of failure that must NOT retry: a missing row is
  // structural, not transient -- confirmed here by asserting only a single
  // call happened, not up to MAX_SNAPSHOT_WRITE_ATTEMPTS of them.
  it("throws a clear, specific error when no existing checkpoint row matches this archive dataset, WITHOUT retrying", async () => {
    const { clients, cursorUpdateCalls } = makeMockClients({
      existingCheckpointRow: null,
    });

    await expect(
      saveArchiveStreamAccumulatorSnapshot(clients, {
        archiveDatasetId: ARCHIVE_DATASET_ID,
        accumulatorSnapshotLastProcessedId: "row-1",
        accumulatorState: {},
      }),
    ).rejects.toThrow(
      new RegExp(
        `expected exactly one existing archive_stream_checkpoint row for archive_dataset_id=${ARCHIVE_DATASET_ID}.*affected 0 row`,
      ),
    );

    expect(cursorUpdateCalls).toHaveLength(1);
  });

  describe("retry-with-backoff on transient write failures", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("retries a cursor-update statement timeout once and succeeds on the next attempt, logging the retry attempt", async () => {
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      const { clients, cursorUpdateCalls } = makeMockClients({
        existingCheckpointRow: EXISTING_ROW,
        cursorUpdateErrorSequence: [
          { message: "canceling statement due to statement timeout" },
        ],
      });

      const resultPromise = saveArchiveStreamAccumulatorSnapshot(clients, {
        archiveDatasetId: ARCHIVE_DATASET_ID,
        accumulatorSnapshotLastProcessedId: "row-xyz",
        accumulatorState: SAMPLE_ACCUMULATOR_SNAPSHOT,
      });
      await vi.runAllTimersAsync();
      await resultPromise;

      expect(cursorUpdateCalls).toHaveLength(2);
      const warnLines = consoleWarnSpy.mock.calls.map((call) =>
        String(call[0]),
      );
      expect(
        warnLines.some(
          (line) =>
            line.includes("attempt 1") &&
            line.includes("statement timeout") &&
            line.includes("retrying in 1000ms"),
        ),
      ).toBe(true);
    });

    // A meaningfully different code path from the cursor-update timeout
    // above: the bucket batch upsert itself can also fail transiently, and
    // the same whole-sequence retry wrapper must cover it too.
    it("retries a transient bucket upsert failure and succeeds on the next attempt", async () => {
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      const { clients, bucketUpsertCalls, cursorUpdateCalls } = makeMockClients(
        {
          existingCheckpointRow: EXISTING_ROW,
          bucketUpsertErrorSequence: [{ message: "connection reset" }],
        },
      );

      const resultPromise = saveArchiveStreamAccumulatorSnapshot(clients, {
        archiveDatasetId: ARCHIVE_DATASET_ID,
        accumulatorSnapshotLastProcessedId: "row-xyz",
        accumulatorState: SAMPLE_ACCUMULATOR_SNAPSHOT,
      });
      await vi.runAllTimersAsync();
      await resultPromise;

      expect(bucketUpsertCalls).toHaveLength(2);
      expect(cursorUpdateCalls).toHaveLength(1); // only the (successful) second attempt reaches the cursor update
      const warnLines = consoleWarnSpy.mock.calls.map((call) =>
        String(call[0]),
      );
      expect(
        warnLines.some(
          (line) =>
            line.includes("attempt 1") && line.includes("connection reset"),
        ),
      ).toBe(true);
    });

    it("surfaces a clear final error after exhausting all retries on a sustained statement timeout", async () => {
      const { clients, cursorUpdateCalls } = makeMockClients({
        existingCheckpointRow: EXISTING_ROW,
        cursorUpdateError: {
          message: "canceling statement due to statement timeout",
        },
      });

      const assertion = expect(
        saveArchiveStreamAccumulatorSnapshot(clients, {
          archiveDatasetId: ARCHIVE_DATASET_ID,
          accumulatorSnapshotLastProcessedId: "row-1",
          accumulatorState: {},
        }),
      ).rejects.toThrow(
        new RegExp(
          `archive_dataset_id=${ARCHIVE_DATASET_ID}.*statement timeout`,
        ),
      );
      await vi.runAllTimersAsync();
      await assertion;

      // Initial attempt plus every retry, no more -- confirms the backoff
      // loop actually stops instead of retrying forever.
      expect(cursorUpdateCalls).toHaveLength(MAX_SNAPSHOT_WRITE_ATTEMPTS);
    });

    it("waits with increasing delay between retries rather than a fixed interval", async () => {
      const { clients, cursorUpdateCalls } = makeMockClients({
        existingCheckpointRow: EXISTING_ROW,
        cursorUpdateError: {
          message: "canceling statement due to statement timeout",
        },
      });

      const assertion = expect(
        saveArchiveStreamAccumulatorSnapshot(clients, {
          archiveDatasetId: ARCHIVE_DATASET_ID,
          accumulatorSnapshotLastProcessedId: "row-1",
          accumulatorState: {},
        }),
      ).rejects.toThrow(/statement timeout/);

      await vi.advanceTimersByTimeAsync(0);
      expect(cursorUpdateCalls).toHaveLength(1);

      // First backoff (1s) elapses -> second attempt fires.
      await vi.advanceTimersByTimeAsync(1000);
      expect(cursorUpdateCalls).toHaveLength(2);

      // A second 1s wait alone should NOT be enough to trigger the third
      // attempt -- the delay after attempt 2 is 2s, not 1s.
      await vi.advanceTimersByTimeAsync(1000);
      expect(cursorUpdateCalls).toHaveLength(2);

      // The remaining 1s of the 2s backoff elapses -> third attempt fires.
      await vi.advanceTimersByTimeAsync(1000);
      expect(cursorUpdateCalls).toHaveLength(3);

      await vi.runAllTimersAsync();
      await assertion;
      expect(cursorUpdateCalls).toHaveLength(MAX_SNAPSHOT_WRITE_ATTEMPTS);
    });

    // Confirms the structural "row not found" case still fails immediately
    // even inside this describe block's fake-timer setup -- no behavior
    // change from the previous fix, retry-with-backoff included.
    it("still does not retry the structural row-not-found error", async () => {
      const { clients, cursorUpdateCalls } = makeMockClients({
        existingCheckpointRow: null,
      });

      await expect(
        saveArchiveStreamAccumulatorSnapshot(clients, {
          archiveDatasetId: ARCHIVE_DATASET_ID,
          accumulatorSnapshotLastProcessedId: "row-1",
          accumulatorState: {},
        }),
      ).rejects.toThrow(
        /expected exactly one existing archive_stream_checkpoint row/,
      );

      expect(cursorUpdateCalls).toHaveLength(1);
    });
  });
});

describe("clearArchiveStreamCheckpoint", () => {
  it("deletes the checkpoint row keyed on archive_dataset_id", async () => {
    const { clients, deleteCalls } = makeMockClients();

    await clearArchiveStreamCheckpoint(
      clients.checkpointClient,
      ARCHIVE_DATASET_ID,
    );

    expect(deleteCalls).toEqual([ARCHIVE_DATASET_ID]);
  });

  it("throws a clear error when clearing the checkpoint fails", async () => {
    const { clients } = makeMockClients({
      deleteError: { message: "network error" },
    });

    await expect(
      clearArchiveStreamCheckpoint(
        clients.checkpointClient,
        ARCHIVE_DATASET_ID,
      ),
    ).rejects.toThrow(
      new RegExp(`archive_dataset_id=${ARCHIVE_DATASET_ID}.*network error`),
    );
  });
});

describe("DEFAULT_ACCUMULATOR_SNAPSHOT_INTERVAL_CHUNKS", () => {
  it("is 120, the value carried over from the old single-blob write's cost measurement", () => {
    // This constant predates the per-bucket-row rewrite (see this module's
    // own comment on it) -- 120 is kept unchanged pending a fresh cost
    // measurement against the new batched-upsert write path, not
    // re-derived here. This test pins the constant so a future change to
    // it is a deliberate, reviewed edit, not an accidental drift.
    expect(DEFAULT_ACCUMULATOR_SNAPSHOT_INTERVAL_CHUNKS).toBe(120);
  });
});

describe("streamArchiveWithResume", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts fresh with no $where clause, and never calls onResume, when no checkpoint exists", async () => {
    const {
      clients,
      positionUpsertCalls,
      bucketUpsertCalls,
      cursorUpdateCalls,
      deleteCalls,
    } = makeMockClients({ existingCheckpointRow: null });
    fetchMock.mockResolvedValueOnce(jsonResponse(makeRecords(3, "a")));
    const chunks: SocrataRecord[][] = [];
    const onResume = vi.fn();
    const returnedSnapshot: AccumulatorSnapshot = {
      "bf-1:1:9": { count: 3, totalWeight: 3, mean: 0.5, sumSquaredDiff: 0.1 },
    };

    await streamArchiveWithResume(clients, {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      chunkSize: 50,
      onResume,
      onChunk: (readings) => {
        chunks.push(readings);
        return returnedSnapshot;
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCallUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(firstCallUrl.searchParams.has("$where")).toBe(false);
    expect(firstCallUrl.searchParams.get("$order")).toBe(":id");
    expect(firstCallUrl.searchParams.get("$limit")).toBe("50");
    // SoQL requires a star selection to come first in the select-list --
    // "*,:id" is valid, ":id,*" fails with query.compiler.malformed
    // (live-verified against the real API: this exact ordering bug shipped
    // once already and only surfaced in a real --max-chunks run, since a
    // mocked fetch response doesn't validate SoQL syntax).
    expect(firstCallUrl.searchParams.get("$select")).toBe("*,:id");

    expect(onResume).not.toHaveBeenCalled();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(3);

    // Position is saved for the one processed chunk; with the default
    // snapshot interval (120) and only 1 chunk processed, no snapshot write
    // happens at all before the short page ends the run and clears the row.
    expect(positionUpsertCalls).toEqual([
      {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        last_processed_id: "row-a-2",
        readings_processed_count: 3,
      },
    ]);
    expect(bucketUpsertCalls).toEqual([]);
    expect(cursorUpdateCalls).toEqual([]);
    expect(deleteCalls).toEqual([ARCHIVE_DATASET_ID]);
  });

  it("snapshots the accumulator only every snapshotIntervalChunks chunks, saving position every chunk regardless", async () => {
    const {
      clients,
      positionUpsertCalls,
      bucketUpsertCalls,
      cursorUpdateCalls,
      callOrder,
    } = makeMockClients({ existingCheckpointRow: null });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(makeRecords(2, "c1")))
      .mockResolvedValueOnce(jsonResponse(makeRecords(2, "c2")))
      .mockResolvedValueOnce(jsonResponse(makeRecords(2, "c3")))
      .mockResolvedValueOnce(jsonResponse(makeRecords(1, "c4"))); // short -> stop

    await streamArchiveWithResume(clients, {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      chunkSize: 2,
      snapshotIntervalChunks: 3,
      onChunk: () => ({
        "bf-1:1:9": { count: 1, totalWeight: 1, mean: 1, sumSquaredDiff: 0 },
      }),
    });

    // 4 chunks processed -> 4 position writes, but only 1 snapshot event
    // (after the 3rd chunk, at snapshotIntervalChunks=3) before the run
    // ends -- one bucket batch-upsert plus one cursor update.
    expect(positionUpsertCalls).toHaveLength(4);
    expect(bucketUpsertCalls).toHaveLength(1);
    expect(bucketUpsertCalls[0]).toEqual([
      {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        blockface_id: "bf-1",
        iso_day: 1,
        hour: 9,
        count: 1,
        total_weight: 1,
        mean: 1,
        sum_squared_diff: 0,
      },
    ]);
    expect(cursorUpdateCalls).toHaveLength(1);
    expect(cursorUpdateCalls[0]?.values).toEqual({
      accumulator_snapshot_last_processed_id: "row-c3-1",
    });

    // On the snapshotting chunk (the 3rd), position is saved BEFORE the
    // snapshot's bucket upsert and cursor update -- this ordering is what
    // guarantees the snapshot cursor can never get ahead of the stream
    // position, and the bucket upsert lands before the cursor advances
    // (the atomicity guarantee this design depends on).
    expect(callOrder).toEqual([
      "position-upsert", // chunk 1
      "position-upsert", // chunk 2
      "position-upsert", // chunk 3
      "bucket-upsert", // chunk 3's snapshot: bucket rows land first
      "cursor-update", // ...then the cursor advances
      "position-upsert", // chunk 4
      "delete",
    ]);
  });

  it("resumes with no gap-replay fetch when the snapshot cursor already equals the stream position", async () => {
    const { clients, bucketUpsertCalls, cursorUpdateCalls } = makeMockClients({
      existingCheckpointRow: {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        last_processed_id: "row-old-1",
        readings_processed_count: 2,
        accumulator_snapshot_last_processed_id: "row-old-1",
      },
      existingBucketRows: accumulatorSnapshotToBucketRows(
        ARCHIVE_DATASET_ID,
        SAMPLE_ACCUMULATOR_SNAPSHOT,
      ),
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(makeRecords(2, "b")));
    const onResume = vi.fn();

    await streamArchiveWithResume(clients, {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      chunkSize: 50,
      onResume,
      onChunk: () => ({}),
    });

    // Only the main loop's one fetch -- no gap-replay fetch, and no
    // redundant re-snapshot write, since there was nothing to catch up.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      new URL(fetchMock.mock.calls[0]?.[0] as string).searchParams.get(
        "$where",
      ),
    ).toBe(":id > 'row-old-1'");
    expect(bucketUpsertCalls).toEqual([]);
    expect(cursorUpdateCalls).toEqual([]);
    expect(onResume).toHaveBeenCalledExactlyOnceWith(
      SAMPLE_ACCUMULATOR_SNAPSHOT,
    );
  });

  it("replays exactly the bounded gap between the snapshot cursor and the stream position on resume, then re-snapshots and continues", async () => {
    const { clients, bucketUpsertCalls, cursorUpdateCalls, callOrder } =
      makeMockClients({
        existingCheckpointRow: {
          archive_dataset_id: ARCHIVE_DATASET_ID,
          last_processed_id: "row-g-3", // stream got 2 chunks ahead of the snapshot before crashing
          readings_processed_count: 4,
          accumulator_snapshot_last_processed_id: "row-g-1",
        },
        existingBucketRows: accumulatorSnapshotToBucketRows(
          ARCHIVE_DATASET_ID,
          {
            "bf-seed:1:9": {
              count: 2,
              totalWeight: 2,
              mean: 1,
              sumSquaredDiff: 0,
            },
          },
        ),
      });
    // Gap replay should fetch exactly (row-g-1, row-g-3], i.e. rows g-2 and g-3.
    fetchMock
      .mockResolvedValueOnce(jsonResponse(makeRecords(4, "g").slice(2, 4))) // row-g-2, row-g-3
      .mockResolvedValueOnce(jsonResponse(makeRecords(2, "h"))); // main loop's next chunk after resuming, short -> stop
    const onResumeStates: AccumulatorSnapshot[] = [];
    const onChunkPages: SocrataRecord[][] = [];

    await streamArchiveWithResume(clients, {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      chunkSize: 50,
      onResume: (state) => {
        onResumeStates.push(state);
      },
      onChunk: (readings) => {
        onChunkPages.push(readings);
        return {
          "bf-seed:1:9": {
            count: 2 + readings.length,
            totalWeight: 2 + readings.length,
            mean: 1,
            sumSquaredDiff: 0,
          },
        };
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const gapCallUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(gapCallUrl.searchParams.get("$where")).toBe(
      ":id > 'row-g-1' AND :id <= 'row-g-3'",
    );

    // onResume fires FIRST, with the raw (not-yet-caught-up) snapshot --
    // it's what seeds the caller's own state before gap-replay's onChunk
    // call can correctly build on it. The gap chunk then genuinely goes
    // through onChunk (real re-fold, not skipped), producing the caught-up
    // state reflected in the bucket upsert below.
    expect(onResumeStates).toEqual([
      {
        "bf-seed:1:9": { count: 2, totalWeight: 2, mean: 1, sumSquaredDiff: 0 },
      },
    ]);
    expect(onChunkPages[0]?.map((r) => r[":id"])).toEqual([
      "row-g-2",
      "row-g-3",
    ]);

    // The caught-up snapshot is persisted immediately, at the stream's
    // cursor (row-g-3), before the main loop's own next chunk runs.
    expect(bucketUpsertCalls[0]).toEqual([
      {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        blockface_id: "bf-seed",
        iso_day: 1,
        hour: 9,
        count: 4,
        total_weight: 4,
        mean: 1,
        sum_squared_diff: 0,
      },
    ]);
    expect(cursorUpdateCalls[0]?.values).toEqual({
      accumulator_snapshot_last_processed_id: "row-g-3",
    });
    // the catch-up snapshot (bucket upsert, then cursor update), before any
    // main-loop write
    expect(callOrder[0]).toBe("bucket-upsert");
    expect(callOrder[1]).toBe("cursor-update");

    // Main loop then continues forward from row-g-3, not from row-g-1.
    const mainLoopCallUrl = new URL(fetchMock.mock.calls[1]?.[0] as string);
    expect(mainLoopCallUrl.searchParams.get("$where")).toBe(":id > 'row-g-3'");
  });

  it("replays from the very start of the dataset when no snapshot has ever been taken (null cursor)", async () => {
    const { clients } = makeMockClients({
      existingCheckpointRow: {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        last_processed_id: "row-i-1",
        readings_processed_count: 2,
        accumulator_snapshot_last_processed_id: null,
      },
      existingBucketRows: [],
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(makeRecords(2, "i"))) // gap replay: full dataset start through row-i-1
      .mockResolvedValueOnce(jsonResponse([])); // main loop: nothing new yet

    await streamArchiveWithResume(clients, {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      chunkSize: 50,
      onChunk: () => ({ "bf-i:1:9": createEmptyAccumulator() }),
    });

    const gapCallUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(gapCallUrl.searchParams.get("$where")).toBe(":id <= 'row-i-1'");
  });

  it("produces mathematically identical accumulator state whether processed continuously or interrupted mid-stream and resumed via gap replay", async () => {
    // Six readings, deliberately varied weights (same spirit as
    // weightedStats.test.ts's own hand-calculated examples), split into 3
    // chunks of 2. "Continuous" folds all 6 in one uninterrupted pass;
    // "resumed" simulates a crash after chunk 1 was snapshotted but chunk 2
    // only reached the (cheap) position checkpoint before crashing, so a
    // gap-replay re-folds chunk 2 before chunk 3 is fetched fresh.
    const BUCKET_KEY = "bf-shared:1:9";
    const readings: { id: string; value: number; weight: number }[] = [
      { id: "row-r-0", value: 1, weight: 1 },
      { id: "row-r-1", value: 2, weight: 2 },
      { id: "row-r-2", value: 3, weight: 3 },
      { id: "row-r-3", value: 4, weight: 1 },
      { id: "row-r-4", value: 5, weight: 2 },
      { id: "row-r-5", value: 6, weight: 3 },
    ];

    function foldPage(
      acc: WeightedStatsAccumulator,
      page: SocrataRecord[],
    ): WeightedStatsAccumulator {
      let result = acc;
      for (const record of page) {
        const match = readings.find((r) => r.id === record[":id"]);
        if (match === undefined) {
          throw new Error(
            `test setup error: unknown reading id ${String(record[":id"])}`,
          );
        }
        result = addReading(result, match.value, match.weight);
      }
      return result;
    }

    // Reference: continuous, uninterrupted processing.
    let continuousAcc = createEmptyAccumulator();
    for (const r of readings) {
      continuousAcc = addReading(continuousAcc, r.value, r.weight);
    }

    // Resumed run: existing checkpoint reflects chunk 1 (rows 0-1) already
    // snapshotted, and the stream position already 2 chunks ahead (rows
    // 0-3) from a cheap position-only checkpoint before the crash --
    // exactly the gap a real snapshotIntervalChunks=2 cadence would leave.
    const chunk1Records = [{ ":id": "row-r-0" }, { ":id": "row-r-1" }];
    let snapshotAcc = createEmptyAccumulator();
    snapshotAcc = foldPage(snapshotAcc, chunk1Records);

    const { clients } = makeMockClients({
      existingCheckpointRow: {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        last_processed_id: "row-r-3",
        readings_processed_count: 4,
        accumulator_snapshot_last_processed_id: "row-r-1",
      },
      existingBucketRows: accumulatorSnapshotToBucketRows(ARCHIVE_DATASET_ID, {
        [BUCKET_KEY]: snapshotAcc,
      }),
    });

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse([{ ":id": "row-r-2" }, { ":id": "row-r-3" }]),
      ) // gap replay: chunk 2
      .mockResolvedValueOnce(
        jsonResponse([{ ":id": "row-r-4" }, { ":id": "row-r-5" }]),
      ); // main loop: chunk 3, short -> stop

    let resumedAcc = createEmptyAccumulator();
    await streamArchiveWithResume(clients, {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      chunkSize: 50,
      onResume: (state) => {
        resumedAcc =
          (state[BUCKET_KEY] as WeightedStatsAccumulator | undefined) ??
          resumedAcc;
      },
      onChunk: (page) => {
        resumedAcc = foldPage(resumedAcc, page);
        return { [BUCKET_KEY]: resumedAcc };
      },
    });

    // The critical check: exact numeric agreement, not just "plausible" --
    // the resumed, gap-replayed path must land on precisely the same
    // count/totalWeight/mean/sumSquaredDiff as continuous processing.
    expect(resumedAcc).toEqual(continuousAcc);
  });

  it("stops as soon as a chunk shorter than chunkSize arrives, without an extra fetch", async () => {
    const { clients } = makeMockClients({ existingCheckpointRow: null });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(makeRecords(5, "d1"))) // exactly chunkSize
      .mockResolvedValueOnce(jsonResponse(makeRecords(3, "d2"))); // short -> stop, no 3rd fetch
    const chunks: SocrataRecord[][] = [];

    await streamArchiveWithResume(clients, {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      chunkSize: 5,
      onChunk: (readings) => {
        chunks.push(readings);
        return {};
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(chunks.map((c) => c.length)).toEqual([5, 3]);
  });

  it("calls onResume (with the caught-up state) even when the first main-loop page is already empty, and never calls onChunk from the main loop", async () => {
    const { clients, positionUpsertCalls, deleteCalls } = makeMockClients({
      existingCheckpointRow: {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        last_processed_id: "row-last",
        readings_processed_count: 999,
        accumulator_snapshot_last_processed_id: "row-last",
      },
      existingBucketRows: accumulatorSnapshotToBucketRows(
        ARCHIVE_DATASET_ID,
        SAMPLE_ACCUMULATOR_SNAPSHOT,
      ),
    });
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const onChunk = vi.fn();
    const onResume = vi.fn();

    await streamArchiveWithResume(clients, {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      chunkSize: 50,
      onResume,
      onChunk,
    });

    expect(onResume).toHaveBeenCalledExactlyOnceWith(
      SAMPLE_ACCUMULATOR_SNAPSHOT,
    );
    expect(onChunk).not.toHaveBeenCalled();
    expect(positionUpsertCalls).toEqual([]);
    expect(deleteCalls).toEqual([ARCHIVE_DATASET_ID]);
  });

  it("uses DEFAULT_STREAM_CHUNK_SIZE when chunkSize is not specified", async () => {
    const { clients } = makeMockClients({ existingCheckpointRow: null });
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    await streamArchiveWithResume(clients, {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      onChunk: () => ({}),
    });

    const firstCallUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(firstCallUrl.searchParams.get("$limit")).toBe(
      String(DEFAULT_STREAM_CHUNK_SIZE),
    );
  });

  it("throws when a fetched row is missing a valid :id field", async () => {
    const { clients } = makeMockClients({ existingCheckpointRow: null });
    fetchMock.mockResolvedValueOnce(
      jsonResponse([{ occupancydatetime: "2025-06-10T09:00:00" }]),
    );

    await expect(
      streamArchiveWithResume(clients, {
        archiveDatasetId: ARCHIVE_DATASET_ID,
        chunkSize: 50,
        onChunk: () => ({}),
      }),
    ).rejects.toThrow(/missing a valid :id field/);
  });

  it("throws rather than continuing on a non-200 Socrata response", async () => {
    const { clients } = makeMockClients({ existingCheckpointRow: null });
    fetchMock.mockResolvedValueOnce(
      jsonResponse([], {
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      }),
    );

    await expect(
      streamArchiveWithResume(clients, {
        archiveDatasetId: ARCHIVE_DATASET_ID,
        chunkSize: 50,
        onChunk: () => ({}),
      }),
    ).rejects.toThrow(/503/);
  });

  // Real end-to-end proof of backfill-occupancy-stats.ts's --max-chunks
  // semantics, wired together exactly as main() wires them (real
  // streamArchiveWithResume + real createMaxChunksOnChunk, sharing the same
  // persisted checkpoint across two SEPARATE invocations, the same way two
  // separate `node`/npm process runs would share the same real database
  // row). snapshotIntervalChunks: 1 keeps every completed chunk's snapshot
  // cursor caught up with its position cursor, so a resume never triggers
  // gap-replay here -- gap-replay chunks legitimately also count toward
  // --max-chunks (onChunk fires for them too, per this module's own
  // contract), which is real and correct but a separate concern from the
  // one this test isolates: does --max-chunks count fresh per invocation
  // (correct, intended) or toward a total accumulated across runs (would be
  // a bug)?
  it("--max-chunks counts chunks processed by THIS invocation only: a run resuming from an existing checkpoint gets its own full --max-chunks budget of MORE chunks, not a budget reduced by chunks a prior run already committed", async () => {
    const { clients } = makeMockClients({ existingCheckpointRow: null });

    // A synthetic, effectively endless archive: each request's cursor
    // determines exactly the single next row id, so two separate
    // streamArchiveWithResume calls sharing `clients` naturally continue
    // from wherever the checkpoint left off, just like a real resume would.
    fetchMock.mockImplementation(async (url: string) => {
      const where = new URL(url).searchParams.get("$where") ?? "";
      const match = /:id > '(\d+)'/.exec(where);
      const cursorNum = match?.[1] !== undefined ? Number(match[1]) : 0;
      return jsonResponse([
        { ":id": String(cursorNum + 1).padStart(10, "0") },
      ]);
    });

    async function runOneInvocation(maxChunks: number): Promise<number> {
      const { onChunk, getChunksProcessed } = createMaxChunksOnChunk(
        maxChunks,
        () => ({}),
      );
      try {
        await streamArchiveWithResume(clients, {
          archiveDatasetId: ARCHIVE_DATASET_ID,
          chunkSize: 1,
          snapshotIntervalChunks: 1,
          onChunk,
        });
      } catch (err) {
        if (!(err instanceof MaxChunksReachedError)) {
          throw err;
        }
      }
      return getChunksProcessed();
    }

    // First invocation: a fresh run, --max-chunks=150.
    const firstRunChunks = await runOneInvocation(150);
    expect(firstRunChunks).toBe(150);
    const checkpointAfterFirstRun = await fetchArchiveStreamCheckpoint(
      clients.checkpointClient,
      ARCHIVE_DATASET_ID,
    );
    // The chunk that triggers MaxChunksReachedError throws before its own
    // position is saved (thrown from inside onChunk, before
    // saveArchiveStreamPosition runs) -- an accepted, documented gap for
    // this testing-only flag (see MaxChunksReachedError's own comment in
    // backfill-occupancy-stats.ts), so the durably checkpointed position
    // after "150 chunks processed" is chunk 149's, not chunk 150's.
    expect(checkpointAfterFirstRun?.lastProcessedId).toBe("0000000149");

    // Second invocation: a separate call (a fresh createMaxChunksOnChunk,
    // simulating a fresh process resuming from the checkpoint above) with
    // --max-chunks=300. If this budget were instead measured toward an
    // absolute total across both runs, this run would stop after only 150
    // more chunks (150 already done + 150 more = 300) -- it must not.
    const secondRunChunks = await runOneInvocation(300);
    expect(secondRunChunks).toBe(300);
    const checkpointAfterSecondRun = await fetchArchiveStreamCheckpoint(
      clients.checkpointClient,
      ARCHIVE_DATASET_ID,
    );
    // 149 (first run's committed position) + 299 (second run's 299
    // successfully committed chunks, its 300th throwing before its own
    // commit, same accepted gap as above) = 448.
    expect(checkpointAfterSecondRun?.lastProcessedId).toBe("0000000448");
  });

  describe("archive-streaming progress logging", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("does not log progress before ARCHIVE_STREAM_PROGRESS_LOG_INTERVAL_CHUNKS chunks have been processed", async () => {
      const consoleLogSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => {});
      const { clients } = makeMockClients({ existingCheckpointRow: null });
      for (
        let i = 0;
        i < ARCHIVE_STREAM_PROGRESS_LOG_INTERVAL_CHUNKS - 1;
        i++
      ) {
        fetchMock.mockResolvedValueOnce(jsonResponse(makeRecords(2, `q${i}`))); // full chunkSize-2 pages, never short
      }
      fetchMock.mockResolvedValueOnce(jsonResponse([])); // empty page -> stop BEFORE processing a 20th chunk

      await streamArchiveWithResume(clients, {
        archiveDatasetId: ARCHIVE_DATASET_ID,
        chunkSize: 2,
        onChunk: () => ({}),
      });

      const progressLines = consoleLogSpy.mock.calls.filter((call) =>
        String(call[0]).includes("Archive streaming progress"),
      );
      expect(progressLines).toHaveLength(0);
    });

    it("logs cumulative chunks processed and total readings once the interval is reached", async () => {
      const consoleLogSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => {});
      const { clients } = makeMockClients({ existingCheckpointRow: null });
      for (let i = 0; i < ARCHIVE_STREAM_PROGRESS_LOG_INTERVAL_CHUNKS; i++) {
        fetchMock.mockResolvedValueOnce(jsonResponse(makeRecords(2, `p${i}`))); // 2 readings/chunk
      }
      fetchMock.mockResolvedValueOnce(jsonResponse(makeRecords(1, "last"))); // short -> stop

      await streamArchiveWithResume(clients, {
        archiveDatasetId: ARCHIVE_DATASET_ID,
        chunkSize: 2,
        onChunk: () => ({}),
      });

      const progressLines = consoleLogSpy.mock.calls.filter((call) =>
        String(call[0]).includes("Archive streaming progress"),
      );
      expect(progressLines).toHaveLength(1);
      expect(progressLines[0]?.[0]).toContain(
        `${ARCHIVE_STREAM_PROGRESS_LOG_INTERVAL_CHUNKS} chunks processed`,
      );
      expect(progressLines[0]?.[0]).toContain(
        `${ARCHIVE_STREAM_PROGRESS_LOG_INTERVAL_CHUNKS * 2} total readings processed`,
      );
    });

    // Also proves the logged reading count reflects the TRUE cumulative
    // total across a resume (seeded from the checkpoint's own
    // readings_processed_count), not just readings processed by this
    // process's own main loop -- the same distinction that matters for
    // readings_processed_count itself (see saveArchiveStreamPosition).
    it("logs again after a second interval, with cumulative totals that include readings resumed from a prior run", async () => {
      const consoleLogSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => {});
      const { clients } = makeMockClients({
        existingCheckpointRow: {
          archive_dataset_id: ARCHIVE_DATASET_ID,
          last_processed_id: "row-old-1",
          readings_processed_count: 1000,
          accumulator_snapshot_last_processed_id: "row-old-1",
        },
        existingBucketRows: accumulatorSnapshotToBucketRows(
          ARCHIVE_DATASET_ID,
          SAMPLE_ACCUMULATOR_SNAPSHOT,
        ),
      });
      const totalChunks = ARCHIVE_STREAM_PROGRESS_LOG_INTERVAL_CHUNKS * 2;
      for (let i = 0; i < totalChunks; i++) {
        fetchMock.mockResolvedValueOnce(jsonResponse(makeRecords(2, `r${i}`)));
      }
      fetchMock.mockResolvedValueOnce(jsonResponse(makeRecords(1, "last"))); // short -> stop

      await streamArchiveWithResume(clients, {
        archiveDatasetId: ARCHIVE_DATASET_ID,
        chunkSize: 2,
        onChunk: () => ({}),
      });

      const progressLines = consoleLogSpy.mock.calls.filter((call) =>
        String(call[0]).includes("Archive streaming progress"),
      );
      expect(progressLines).toHaveLength(2);
      expect(progressLines[0]?.[0]).toContain(
        `${ARCHIVE_STREAM_PROGRESS_LOG_INTERVAL_CHUNKS} chunks processed`,
      );
      expect(progressLines[0]?.[0]).toContain(
        `${1000 + ARCHIVE_STREAM_PROGRESS_LOG_INTERVAL_CHUNKS * 2} total readings processed`,
      );
      expect(progressLines[1]?.[0]).toContain(
        `${totalChunks} chunks processed`,
      );
      expect(progressLines[1]?.[0]).toContain(
        `${1000 + totalChunks * 2} total readings processed`,
      );
    });
  });
});
