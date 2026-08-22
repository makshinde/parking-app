import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearArchiveStreamCheckpoint,
  DEFAULT_STREAM_CHUNK_SIZE,
  fetchArchiveStreamCheckpoint,
  saveArchiveStreamCheckpoint,
  streamArchiveWithResume,
  type ArchiveStreamCheckpoint,
  type ArchiveStreamCheckpointSupabaseClient,
} from "./streamArchiveWithResume.ts";
import type { SocrataRecord } from "../utils/fetchSocrataRecords.ts";
import type { AccumulatorSnapshot } from "./incrementalWeightedStats.ts";

const ARCHIVE_DATASET_ID = "7c2e-uany";

const SAMPLE_ACCUMULATOR_SNAPSHOT: AccumulatorSnapshot = {
  "bf-1:1:9": { count: 240, totalWeight: 118.4, mean: 0.62, sumSquaredDiff: 7.68 },
  "bf-2:1:9": { count: 180, totalWeight: 90.1, mean: 0.41, sumSquaredDiff: 5.02 },
};

// --- Checkpoint client mock, same shape as backfill-occupancy-stats.test.ts's
// createMockFailuresClient (eq-chainable select/maybeSingle, upsert, delete/eq).
function makeMockCheckpointClient(options: {
  existingRow?: Record<string, unknown> | null;
  selectError?: { message: string } | null;
  upsertError?: { message: string } | null;
  deleteError?: { message: string } | null;
} = {}) {
  const existingRow = options.existingRow ?? null;
  const upsertCalls: Record<string, unknown>[] = [];
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
          upsertCalls.push(row);
          callOrder.push("upsert");
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

  return { client, upsertCalls, deleteCalls, callOrder };
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

describe("fetchArchiveStreamCheckpoint / saveArchiveStreamCheckpoint / clearArchiveStreamCheckpoint", () => {
  it("returns null when no checkpoint row exists yet", async () => {
    const { client } = makeMockCheckpointClient({ existingRow: null });

    await expect(fetchArchiveStreamCheckpoint(client, ARCHIVE_DATASET_ID)).resolves.toBeNull();
  });

  it("returns the parsed checkpoint, including accumulator_state, when a row exists", async () => {
    const { client } = makeMockCheckpointClient({
      existingRow: {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        last_processed_id: "row-abc",
        readings_processed_count: 1500,
        accumulator_state: SAMPLE_ACCUMULATOR_SNAPSHOT,
      },
    });

    await expect(fetchArchiveStreamCheckpoint(client, ARCHIVE_DATASET_ID)).resolves.toEqual({
      archiveDatasetId: ARCHIVE_DATASET_ID,
      lastProcessedId: "row-abc",
      readingsProcessedCount: 1500,
      accumulatorState: SAMPLE_ACCUMULATOR_SNAPSHOT,
    });
  });

  it("throws a clear error when reading the checkpoint fails", async () => {
    const { client } = makeMockCheckpointClient({ selectError: { message: "connection reset" } });

    await expect(fetchArchiveStreamCheckpoint(client, ARCHIVE_DATASET_ID)).rejects.toThrow(
      new RegExp(`archive_dataset_id=${ARCHIVE_DATASET_ID}.*connection reset`),
    );
  });

  it("upserts on archive_dataset_id with the checkpoint's fields, including accumulator_state", async () => {
    const { client, upsertCalls } = makeMockCheckpointClient();
    const checkpoint: ArchiveStreamCheckpoint = {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      lastProcessedId: "row-xyz",
      readingsProcessedCount: 250,
      accumulatorState: SAMPLE_ACCUMULATOR_SNAPSHOT,
    };

    await saveArchiveStreamCheckpoint(client, checkpoint);

    expect(upsertCalls[0]).toEqual({
      archive_dataset_id: ARCHIVE_DATASET_ID,
      last_processed_id: "row-xyz",
      readings_processed_count: 250,
      accumulator_state: SAMPLE_ACCUMULATOR_SNAPSHOT,
    });
  });

  it("throws a clear error when saving the checkpoint fails", async () => {
    const { client } = makeMockCheckpointClient({ upsertError: { message: "constraint violation" } });

    await expect(
      saveArchiveStreamCheckpoint(client, {
        archiveDatasetId: ARCHIVE_DATASET_ID,
        lastProcessedId: "row-1",
        readingsProcessedCount: 1,
        accumulatorState: {},
      }),
    ).rejects.toThrow(new RegExp(`archive_dataset_id=${ARCHIVE_DATASET_ID}.*constraint violation`));
  });

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

describe("streamArchiveWithResume", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts fresh with no $where clause on :id, and never calls onResume, when no checkpoint exists", async () => {
    const { client, upsertCalls, deleteCalls } = makeMockCheckpointClient({ existingRow: null });
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

    // Short (< chunkSize) page stops the loop and clears the checkpoint,
    // but the checkpoint (including the returned accumulator snapshot) is
    // still saved once for that one processed chunk.
    expect(upsertCalls).toEqual([
      {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        last_processed_id: "row-a-2",
        readings_processed_count: 3,
        accumulator_state: returnedSnapshot,
      },
    ]);
    expect(deleteCalls).toEqual([ARCHIVE_DATASET_ID]);
  });

  it("resumes from just after the existing checkpoint's last_processed_id and restores its accumulator state exactly", async () => {
    const { client } = makeMockCheckpointClient({
      existingRow: {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        last_processed_id: "row-old-99",
        readings_processed_count: 500,
        accumulator_state: SAMPLE_ACCUMULATOR_SNAPSHOT,
      },
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(makeRecords(2, "b")));
    const onResume = vi.fn();

    await streamArchiveWithResume(client, {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      chunkSize: 50,
      onResume,
      onChunk: () => ({}),
    });

    const firstCallUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(firstCallUrl.searchParams.get("$where")).toBe(":id > 'row-old-99'");

    // The critical correctness check: onResume receives the exact same
    // accumulator snapshot object that was persisted, not a copy that
    // dropped or altered any bucket's numbers, and is called before any
    // chunk is (re-)processed.
    expect(onResume).toHaveBeenCalledExactlyOnceWith(SAMPLE_ACCUMULATOR_SNAPSHOT);
  });

  it("calls onResume (with the restored state) even when the first page is already empty, so the caller can finalize it, and never calls onChunk", async () => {
    const { client, upsertCalls, deleteCalls } = makeMockCheckpointClient({
      existingRow: {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        last_processed_id: "row-last",
        readings_processed_count: 999,
        accumulator_state: SAMPLE_ACCUMULATOR_SNAPSHOT,
      },
    });
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const onChunk = vi.fn();
    const onResume = vi.fn();

    await streamArchiveWithResume(client, { archiveDatasetId: ARCHIVE_DATASET_ID, chunkSize: 50, onResume, onChunk });

    expect(onResume).toHaveBeenCalledExactlyOnceWith(SAMPLE_ACCUMULATOR_SNAPSHOT);
    expect(onChunk).not.toHaveBeenCalled();
    expect(upsertCalls).toEqual([]);
    expect(deleteCalls).toEqual([ARCHIVE_DATASET_ID]);
  });

  it("processes multiple full chunks in sequence, saving the checkpoint (with that chunk's returned accumulator snapshot) after each, before fetching the next", async () => {
    const { client, upsertCalls, callOrder } = makeMockCheckpointClient({ existingRow: null });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(makeRecords(2, "c1"))) // full chunk (chunkSize=2)
      .mockResolvedValueOnce(jsonResponse(makeRecords(2, "c2"))) // full chunk
      .mockResolvedValueOnce(jsonResponse(makeRecords(1, "c3"))); // short -> stop
    const snapshotsByChunk: AccumulatorSnapshot[] = [
      { bucket: { count: 2, totalWeight: 2, mean: 1, sumSquaredDiff: 0 } },
      { bucket: { count: 4, totalWeight: 4, mean: 1, sumSquaredDiff: 0 } },
      { bucket: { count: 5, totalWeight: 5, mean: 1, sumSquaredDiff: 0 } },
    ];
    let chunkIndex = 0;

    await streamArchiveWithResume(client, {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      chunkSize: 2,
      onChunk: () => {
        callOrder.push("onChunk");
        const snapshot = snapshotsByChunk[chunkIndex] as AccumulatorSnapshot;
        chunkIndex += 1;
        return snapshot;
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Cursor progression: fresh, then row-c1-1, then row-c2-1.
    expect(new URL(fetchMock.mock.calls[0]?.[0] as string).searchParams.has("$where")).toBe(false);
    expect(new URL(fetchMock.mock.calls[1]?.[0] as string).searchParams.get("$where")).toBe(":id > 'row-c1-1'");
    expect(new URL(fetchMock.mock.calls[2]?.[0] as string).searchParams.get("$where")).toBe(":id > 'row-c2-1'");

    expect(upsertCalls).toEqual([
      {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        last_processed_id: "row-c1-1",
        readings_processed_count: 2,
        accumulator_state: snapshotsByChunk[0],
      },
      {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        last_processed_id: "row-c2-1",
        readings_processed_count: 4,
        accumulator_state: snapshotsByChunk[1],
      },
      {
        archive_dataset_id: ARCHIVE_DATASET_ID,
        last_processed_id: "row-c3-0",
        readings_processed_count: 5,
        accumulator_state: snapshotsByChunk[2],
      },
    ]);

    // Each chunk's onChunk must complete (and hand back its snapshot)
    // before its own checkpoint upsert -- the sequencing the "resume
    // always restores a mutually consistent pair" guarantee depends on.
    expect(callOrder).toEqual(["onChunk", "upsert", "onChunk", "upsert", "onChunk", "upsert", "delete"]);
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
