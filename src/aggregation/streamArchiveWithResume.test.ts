import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearArchiveStreamCheckpoint,
  DEFAULT_ACCUMULATOR_SNAPSHOT_INTERVAL_CHUNKS,
  DEFAULT_STREAM_CHUNK_SIZE,
  fetchArchiveStreamCheckpoint,
  saveArchiveStreamAccumulatorSnapshot,
  saveArchiveStreamPosition,
  streamArchiveWithResume,
  type ArchiveStreamCheckpointSupabaseClient,
} from "./streamArchiveWithResume.ts";
import { addReading, createEmptyAccumulator } from "./incrementalWeightedStats.ts";
import type { SocrataRecord } from "../utils/fetchSocrataRecords.ts";
import type { AccumulatorSnapshot, WeightedStatsAccumulator } from "./incrementalWeightedStats.ts";

const ARCHIVE_DATASET_ID = "7c2e-uany";

const SAMPLE_ACCUMULATOR_SNAPSHOT: AccumulatorSnapshot = {
  "bf-1:1:9": { count: 240, totalWeight: 118.4, mean: 0.62, sumSquaredDiff: 7.68 },
  "bf-2:1:9": { count: 180, totalWeight: 90.1, mean: 0.41, sumSquaredDiff: 5.02 },
};

// --- Checkpoint client mock, same shape as backfill-occupancy-stats.test.ts's
// createMockFailuresClient (eq-chainable select/maybeSingle, upsert, delete/eq).
// Labels each upsert call as "position" or "snapshot" by which keys are
// present, so tests can assert the two cheap/expensive write paths never
// get conflated.
function makeMockCheckpointClient(options: {
  existingRow?: Record<string, unknown> | null;
  selectError?: { message: string } | null;
  upsertError?: { message: string } | null;
  deleteError?: { message: string } | null;
} = {}) {
  const existingRow = options.existingRow ?? null;
  const positionUpsertCalls: Record<string, unknown>[] = [];
  const snapshotUpsertCalls: Record<string, unknown>[] = [];
  const deleteCalls: unknown[] = [];
  const callOrder: string[] = [];

  const queryBuilder = {
    eq: () => queryBuilder,
    maybeSingle: async () =>
      options.selectError !== undefined && options.selectError !== null
        ? { data: null, error: options.selectError }
        : { data: existingRow, error: null },
  };

  const client: ArchiveStreamCheckpointSupabaseClient = {
    from: () =>
      ({
        select: () => queryBuilder,
        upsert: async (row: Record<string, unknown>) => {
          if ("accumulator_state" in row) {
            snapshotUpsertCalls.push(row);
            callOrder.push("snapshot-upsert");
          } else {
            positionUpsertCalls.push(row);
            callOrder.push("position-upsert");
          }
          return options.upsertError !== undefined && options.upsertError !== null
            ? { data: null, error: options.upsertError }
            : { data: null, error: null };
        },
        delete: () => ({
          eq: async (_column: string, value: unknown) => {
            deleteCalls.push(value);
            callOrder.push("delete");
            return options.deleteError !== undefined && options.deleteError !== null
              ? { data: null, error: options.deleteError }
              : { data: [], error: null };
          },
        }),
      }) as unknown as ReturnType<ArchiveStreamCheckpointSupabaseClient["from"]>,
  };

  return { client, positionUpsertCalls, snapshotUpsertCalls, deleteCalls, callOrder };
}

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number; statusText?: string }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    json: () => Promise.resolve(body),
  } as Response;
}

function makeRecords(count: number, idPrefix: string): SocrataRecord[] {
  return Array.from({ length: count }, (_, i) => ({ ":id": `row-${idPrefix}-${i}`, occupancydatetime: "2025-06-10T09:00:00" }));
}

describe("fetchArchiveStreamCheckpoint", () => {
  it("returns null when no checkpoint row exists yet", async () => {
    const { client } = makeMockCheckpointClient({ existingRow: null });

    await expect(fetchArchiveStreamCheckpoint(client, ARCHIVE_DATASET_ID)).resolves.toBeNull();
  });

  it("returns the parsed checkpoint, including both cursors and accumulator_state, when a row exists", async () => {
    const { client } = makeMockCheckpointClient({
      existingRow: {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        last_processed_id: "row-abc",
        readings_processed_count: 1500,
        accumulator_snapshot_last_processed_id: "row-xyz",
        accumulator_state: SAMPLE_ACCUMULATOR_SNAPSHOT,
      },
    });

    await expect(fetchArchiveStreamCheckpoint(client, ARCHIVE_DATASET_ID)).resolves.toEqual({
      archiveDatasetId: ARCHIVE_DATASET_ID,
      lastProcessedId: "row-abc",
      readingsProcessedCount: 1500,
      accumulatorSnapshotLastProcessedId: "row-xyz",
      accumulatorState: SAMPLE_ACCUMULATOR_SNAPSHOT,
    });
  });

  it("returns null accumulatorSnapshotLastProcessedId when no snapshot has been taken yet", async () => {
    const { client } = makeMockCheckpointClient({
      existingRow: {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        last_processed_id: "row-abc",
        readings_processed_count: 3,
        accumulator_snapshot_last_processed_id: null,
        accumulator_state: {},
      },
    });

    const result = await fetchArchiveStreamCheckpoint(client, ARCHIVE_DATASET_ID);
    expect(result?.accumulatorSnapshotLastProcessedId).toBeNull();
  });

  it("throws a clear error when reading the checkpoint fails", async () => {
    const { client } = makeMockCheckpointClient({ selectError: { message: "connection reset" } });

    await expect(fetchArchiveStreamCheckpoint(client, ARCHIVE_DATASET_ID)).rejects.toThrow(
      new RegExp(`archive_dataset_id=${ARCHIVE_DATASET_ID}.*connection reset`),
    );
  });
});

describe("saveArchiveStreamPosition", () => {
  it("upserts ONLY the position fields, never accumulator_state or its cursor", async () => {
    const { client, positionUpsertCalls } = makeMockCheckpointClient();

    await saveArchiveStreamPosition(client, { archiveDatasetId: ARCHIVE_DATASET_ID, lastProcessedId: "row-xyz", readingsProcessedCount: 250 });

    expect(positionUpsertCalls).toEqual([
      { archive_dataset_id: ARCHIVE_DATASET_ID, last_processed_id: "row-xyz", readings_processed_count: 250 },
    ]);
  });

  it("throws a clear error when saving the position fails", async () => {
    const { client } = makeMockCheckpointClient({ upsertError: { message: "constraint violation" } });

    await expect(
      saveArchiveStreamPosition(client, { archiveDatasetId: ARCHIVE_DATASET_ID, lastProcessedId: "row-1", readingsProcessedCount: 1 }),
    ).rejects.toThrow(new RegExp(`archive_dataset_id=${ARCHIVE_DATASET_ID}.*constraint violation`));
  });
});

describe("saveArchiveStreamAccumulatorSnapshot", () => {
  it("upserts ONLY the snapshot fields, never last_processed_id or readings_processed_count", async () => {
    const { client, snapshotUpsertCalls } = makeMockCheckpointClient();

    await saveArchiveStreamAccumulatorSnapshot(client, {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      accumulatorSnapshotLastProcessedId: "row-xyz",
      accumulatorState: SAMPLE_ACCUMULATOR_SNAPSHOT,
    });

    expect(snapshotUpsertCalls).toEqual([
      {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        accumulator_snapshot_last_processed_id: "row-xyz",
        accumulator_state: SAMPLE_ACCUMULATOR_SNAPSHOT,
      },
    ]);
  });

  it("throws a clear error when saving the snapshot fails", async () => {
    const { client } = makeMockCheckpointClient({ upsertError: { message: "statement timeout" } });

    await expect(
      saveArchiveStreamAccumulatorSnapshot(client, {
        archiveDatasetId: ARCHIVE_DATASET_ID,
        accumulatorSnapshotLastProcessedId: "row-1",
        accumulatorState: {},
      }),
    ).rejects.toThrow(new RegExp(`archive_dataset_id=${ARCHIVE_DATASET_ID}.*statement timeout`));
  });
});

describe("clearArchiveStreamCheckpoint", () => {
  it("deletes the checkpoint row keyed on archive_dataset_id", async () => {
    const { client, deleteCalls } = makeMockCheckpointClient();

    await clearArchiveStreamCheckpoint(client, ARCHIVE_DATASET_ID);

    expect(deleteCalls).toEqual([ARCHIVE_DATASET_ID]);
  });

  it("throws a clear error when clearing the checkpoint fails", async () => {
    const { client } = makeMockCheckpointClient({ deleteError: { message: "network error" } });

    await expect(clearArchiveStreamCheckpoint(client, ARCHIVE_DATASET_ID)).rejects.toThrow(
      new RegExp(`archive_dataset_id=${ARCHIVE_DATASET_ID}.*network error`),
    );
  });
});

describe("DEFAULT_ACCUMULATOR_SNAPSHOT_INTERVAL_CHUNKS", () => {
  it("is 120, derived from the real measured 17,890ms/write snapshot cost against a ~6,002-chunk full archive targeting ~5% overhead", () => {
    // N >= totalChunks * measuredSnapshotWriteMs / budgetMs
    //    = 6002 * 17890 / (0.05 * 5 * 3600 * 1000) ~= 119.37 -> rounded up to 120.
    // This test pins the constant so a future change to it is a deliberate,
    // reviewed edit, not an accidental drift.
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
    const { client, positionUpsertCalls, snapshotUpsertCalls, deleteCalls } = makeMockCheckpointClient({ existingRow: null });
    fetchMock.mockResolvedValueOnce(jsonResponse(makeRecords(3, "a")));
    const chunks: SocrataRecord[][] = [];
    const onResume = vi.fn();
    const returnedSnapshot: AccumulatorSnapshot = { "bf-1:1:9": { count: 3, totalWeight: 3, mean: 0.5, sumSquaredDiff: 0.1 } };

    await streamArchiveWithResume(client, {
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

    expect(onResume).not.toHaveBeenCalled();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(3);

    // Position is saved for the one processed chunk; with the default
    // snapshot interval (120) and only 1 chunk processed, no snapshot write
    // happens at all before the short page ends the run and clears the row.
    expect(positionUpsertCalls).toEqual([
      { archive_dataset_id: ARCHIVE_DATASET_ID, last_processed_id: "row-a-2", readings_processed_count: 3 },
    ]);
    expect(snapshotUpsertCalls).toEqual([]);
    expect(deleteCalls).toEqual([ARCHIVE_DATASET_ID]);
  });

  it("snapshots the accumulator only every snapshotIntervalChunks chunks, saving position every chunk regardless", async () => {
    const { client, positionUpsertCalls, snapshotUpsertCalls, callOrder } = makeMockCheckpointClient({ existingRow: null });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(makeRecords(2, "c1")))
      .mockResolvedValueOnce(jsonResponse(makeRecords(2, "c2")))
      .mockResolvedValueOnce(jsonResponse(makeRecords(2, "c3")))
      .mockResolvedValueOnce(jsonResponse(makeRecords(1, "c4"))); // short -> stop

    await streamArchiveWithResume(client, {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      chunkSize: 2,
      snapshotIntervalChunks: 3,
      onChunk: () => ({ bucket: { count: 1, totalWeight: 1, mean: 1, sumSquaredDiff: 0 } }),
    });

    // 4 chunks processed -> 4 position writes, but only 1 snapshot write
    // (after the 3rd chunk, at snapshotIntervalChunks=3) before the run ends.
    expect(positionUpsertCalls).toHaveLength(4);
    expect(snapshotUpsertCalls).toHaveLength(1);
    expect(snapshotUpsertCalls[0]).toMatchObject({ accumulator_snapshot_last_processed_id: "row-c3-1" });

    // On the snapshotting chunk (the 3rd), position is saved BEFORE the
    // snapshot -- this ordering is what guarantees the snapshot cursor can
    // never get ahead of the stream position.
    expect(callOrder).toEqual([
      "position-upsert", // chunk 1
      "position-upsert", // chunk 2
      "position-upsert", // chunk 3
      "snapshot-upsert", // chunk 3's snapshot, after its position write
      "position-upsert", // chunk 4
      "delete",
    ]);
  });

  it("resumes with no gap-replay fetch when the snapshot cursor already equals the stream position", async () => {
    const { client, snapshotUpsertCalls } = makeMockCheckpointClient({
      existingRow: {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        last_processed_id: "row-old-1",
        readings_processed_count: 2,
        accumulator_snapshot_last_processed_id: "row-old-1",
        accumulator_state: SAMPLE_ACCUMULATOR_SNAPSHOT,
      },
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(makeRecords(2, "b")));
    const onResume = vi.fn();

    await streamArchiveWithResume(client, { archiveDatasetId: ARCHIVE_DATASET_ID, chunkSize: 50, onResume, onChunk: () => ({}) });

    // Only the main loop's one fetch -- no gap-replay fetch, and no
    // redundant re-snapshot write, since there was nothing to catch up.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(fetchMock.mock.calls[0]?.[0] as string).searchParams.get("$where")).toBe(":id > 'row-old-1'");
    expect(snapshotUpsertCalls).toEqual([]);
    expect(onResume).toHaveBeenCalledExactlyOnceWith(SAMPLE_ACCUMULATOR_SNAPSHOT);
  });

  it("replays exactly the bounded gap between the snapshot cursor and the stream position on resume, then re-snapshots and continues", async () => {
    const { client, snapshotUpsertCalls, callOrder } = makeMockCheckpointClient({
      existingRow: {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        last_processed_id: "row-g-3", // stream got 2 chunks ahead of the snapshot before crashing
        readings_processed_count: 4,
        accumulator_snapshot_last_processed_id: "row-g-1",
        accumulator_state: { seed: { count: 2, totalWeight: 2, mean: 1, sumSquaredDiff: 0 } },
      },
    });
    // Gap replay should fetch exactly (row-g-1, row-g-3], i.e. rows g-2 and g-3.
    fetchMock
      .mockResolvedValueOnce(jsonResponse(makeRecords(4, "g").slice(2, 4))) // row-g-2, row-g-3
      .mockResolvedValueOnce(jsonResponse(makeRecords(2, "h"))); // main loop's next chunk after resuming, short -> stop
    const onResumeStates: AccumulatorSnapshot[] = [];
    const onChunkPages: SocrataRecord[][] = [];

    await streamArchiveWithResume(client, {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      chunkSize: 50,
      onResume: (state) => {
        onResumeStates.push(state);
      },
      onChunk: (readings) => {
        onChunkPages.push(readings);
        return { seed: { count: 2 + readings.length, totalWeight: 2 + readings.length, mean: 1, sumSquaredDiff: 0 } };
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const gapCallUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(gapCallUrl.searchParams.get("$where")).toBe(":id > 'row-g-1' AND :id <= 'row-g-3'");

    // onResume fires FIRST, with the raw (not-yet-caught-up) snapshot --
    // it's what seeds the caller's own state before gap-replay's onChunk
    // call can correctly build on it. The gap chunk then genuinely goes
    // through onChunk (real re-fold, not skipped), producing the caught-up
    // state reflected in the snapshot upsert below.
    expect(onResumeStates).toEqual([{ seed: { count: 2, totalWeight: 2, mean: 1, sumSquaredDiff: 0 } }]);
    expect(onChunkPages[0]?.map((r) => r[":id"])).toEqual(["row-g-2", "row-g-3"]);

    // The caught-up snapshot is persisted immediately, at the stream's
    // cursor (row-g-3), before the main loop's own next chunk runs.
    expect(snapshotUpsertCalls[0]).toMatchObject({
      accumulator_snapshot_last_processed_id: "row-g-3",
      accumulator_state: { seed: { count: 4, totalWeight: 4, mean: 1, sumSquaredDiff: 0 } },
    });
    expect(callOrder[0]).toBe("snapshot-upsert"); // the catch-up snapshot, before any main-loop write

    // Main loop then continues forward from row-g-3, not from row-g-1.
    const mainLoopCallUrl = new URL(fetchMock.mock.calls[1]?.[0] as string);
    expect(mainLoopCallUrl.searchParams.get("$where")).toBe(":id > 'row-g-3'");
  });

  it("replays from the very start of the dataset when no snapshot has ever been taken (null cursor)", async () => {
    const { client } = makeMockCheckpointClient({
      existingRow: {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        last_processed_id: "row-i-1",
        readings_processed_count: 2,
        accumulator_snapshot_last_processed_id: null,
        accumulator_state: {},
      },
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(makeRecords(2, "i"))) // gap replay: full dataset start through row-i-1
      .mockResolvedValueOnce(jsonResponse([])); // main loop: nothing new yet

    await streamArchiveWithResume(client, { archiveDatasetId: ARCHIVE_DATASET_ID, chunkSize: 50, onChunk: () => ({ x: createEmptyAccumulator() }) });

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
    const readings: { id: string; value: number; weight: number }[] = [
      { id: "row-r-0", value: 1, weight: 1 },
      { id: "row-r-1", value: 2, weight: 2 },
      { id: "row-r-2", value: 3, weight: 3 },
      { id: "row-r-3", value: 4, weight: 1 },
      { id: "row-r-4", value: 5, weight: 2 },
      { id: "row-r-5", value: 6, weight: 3 },
    ];

    function foldPage(acc: WeightedStatsAccumulator, page: SocrataRecord[]): WeightedStatsAccumulator {
      let result = acc;
      for (const record of page) {
        const match = readings.find((r) => r.id === record[":id"]);
        if (match === undefined) {
          throw new Error(`test setup error: unknown reading id ${String(record[":id"])}`);
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

    const { client } = makeMockCheckpointClient({
      existingRow: {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        last_processed_id: "row-r-3",
        readings_processed_count: 4,
        accumulator_snapshot_last_processed_id: "row-r-1",
        accumulator_state: { bucket: snapshotAcc },
      },
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ ":id": "row-r-2" }, { ":id": "row-r-3" }])) // gap replay: chunk 2
      .mockResolvedValueOnce(jsonResponse([{ ":id": "row-r-4" }, { ":id": "row-r-5" }])); // main loop: chunk 3, short -> stop

    let resumedAcc = createEmptyAccumulator();
    await streamArchiveWithResume(client, {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      chunkSize: 50,
      onResume: (state) => {
        resumedAcc = (state.bucket as WeightedStatsAccumulator | undefined) ?? resumedAcc;
      },
      onChunk: (page) => {
        resumedAcc = foldPage(resumedAcc, page);
        return { bucket: resumedAcc };
      },
    });

    // The critical check: exact numeric agreement, not just "plausible" --
    // the resumed, gap-replayed path must land on precisely the same
    // count/totalWeight/mean/sumSquaredDiff as continuous processing.
    expect(resumedAcc).toEqual(continuousAcc);
  });

  it("stops as soon as a chunk shorter than chunkSize arrives, without an extra fetch", async () => {
    const { client } = makeMockCheckpointClient({ existingRow: null });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(makeRecords(5, "d1"))) // exactly chunkSize
      .mockResolvedValueOnce(jsonResponse(makeRecords(3, "d2"))); // short -> stop, no 3rd fetch
    const chunks: SocrataRecord[][] = [];

    await streamArchiveWithResume(client, {
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
    const { client, positionUpsertCalls, deleteCalls } = makeMockCheckpointClient({
      existingRow: {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        last_processed_id: "row-last",
        readings_processed_count: 999,
        accumulator_snapshot_last_processed_id: "row-last",
        accumulator_state: SAMPLE_ACCUMULATOR_SNAPSHOT,
      },
    });
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const onChunk = vi.fn();
    const onResume = vi.fn();

    await streamArchiveWithResume(client, { archiveDatasetId: ARCHIVE_DATASET_ID, chunkSize: 50, onResume, onChunk });

    expect(onResume).toHaveBeenCalledExactlyOnceWith(SAMPLE_ACCUMULATOR_SNAPSHOT);
    expect(onChunk).not.toHaveBeenCalled();
    expect(positionUpsertCalls).toEqual([]);
    expect(deleteCalls).toEqual([ARCHIVE_DATASET_ID]);
  });

  it("uses DEFAULT_STREAM_CHUNK_SIZE when chunkSize is not specified", async () => {
    const { client } = makeMockCheckpointClient({ existingRow: null });
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    await streamArchiveWithResume(client, { archiveDatasetId: ARCHIVE_DATASET_ID, onChunk: () => ({}) });

    const firstCallUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(firstCallUrl.searchParams.get("$limit")).toBe(String(DEFAULT_STREAM_CHUNK_SIZE));
  });

  it("throws when a fetched row is missing a valid :id field", async () => {
    const { client } = makeMockCheckpointClient({ existingRow: null });
    fetchMock.mockResolvedValueOnce(jsonResponse([{ occupancydatetime: "2025-06-10T09:00:00" }]));

    await expect(
      streamArchiveWithResume(client, { archiveDatasetId: ARCHIVE_DATASET_ID, chunkSize: 50, onChunk: () => ({}) }),
    ).rejects.toThrow(/missing a valid :id field/);
  });

  it("throws rather than continuing on a non-200 Socrata response", async () => {
    const { client } = makeMockCheckpointClient({ existingRow: null });
    fetchMock.mockResolvedValueOnce(jsonResponse([], { ok: false, status: 503, statusText: "Service Unavailable" }));

    await expect(
      streamArchiveWithResume(client, { archiveDatasetId: ARCHIVE_DATASET_ID, chunkSize: 50, onChunk: () => ({}) }),
    ).rejects.toThrow(/503/);
  });
});
