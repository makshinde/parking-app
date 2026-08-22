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

const ARCHIVE_DATASET_ID = "7c2e-uany";

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

  it("returns the parsed checkpoint when a row exists", async () => {
    const { client } = makeMockCheckpointClient({
      existingRow: { archive_dataset_id: ARCHIVE_DATASET_ID, last_processed_id: "row-abc", readings_processed_count: 1500 },
    });

    await expect(fetchArchiveStreamCheckpoint(client, ARCHIVE_DATASET_ID)).resolves.toEqual({
      archiveDatasetId: ARCHIVE_DATASET_ID,
      lastProcessedId: "row-abc",
      readingsProcessedCount: 1500,
    });
  });

  it("throws a clear error when reading the checkpoint fails", async () => {
    const { client } = makeMockCheckpointClient({ selectError: { message: "connection reset" } });

    await expect(fetchArchiveStreamCheckpoint(client, ARCHIVE_DATASET_ID)).rejects.toThrow(
      new RegExp(`archive_dataset_id=${ARCHIVE_DATASET_ID}.*connection reset`),
    );
  });

  it("upserts on archive_dataset_id with the checkpoint's fields", async () => {
    const { client, upsertCalls } = makeMockCheckpointClient();
    const checkpoint: ArchiveStreamCheckpoint = {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      lastProcessedId: "row-xyz",
      readingsProcessedCount: 250,
    };

    await saveArchiveStreamCheckpoint(client, checkpoint);

    expect(upsertCalls[0]).toEqual({
      archive_dataset_id: ARCHIVE_DATASET_ID,
      last_processed_id: "row-xyz",
      readings_processed_count: 250,
    });
  });

  it("throws a clear error when saving the checkpoint fails", async () => {
    const { client } = makeMockCheckpointClient({ upsertError: { message: "constraint violation" } });

    await expect(
      saveArchiveStreamCheckpoint(client, { archiveDatasetId: ARCHIVE_DATASET_ID, lastProcessedId: "row-1", readingsProcessedCount: 1 }),
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

  it("starts fresh with no $where clause on :id when no checkpoint exists", async () => {
    const { client, upsertCalls, deleteCalls } = makeMockCheckpointClient({ existingRow: null });
    fetchMock.mockResolvedValueOnce(jsonResponse(makeRecords(3, "a")));
    const chunks: SocrataRecord[][] = [];

    await streamArchiveWithResume(client, {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      chunkSize: 50,
      onChunk: (readings) => {
        chunks.push(readings);
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCallUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(firstCallUrl.searchParams.has("$where")).toBe(false);
    expect(firstCallUrl.searchParams.get("$order")).toBe(":id");
    expect(firstCallUrl.searchParams.get("$limit")).toBe("50");

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(3);

    // Short (< chunkSize) page stops the loop and clears the checkpoint,
    // but the checkpoint is still saved once for that one processed chunk.
    expect(upsertCalls).toEqual([
      { archive_dataset_id: ARCHIVE_DATASET_ID, last_processed_id: "row-a-2", readings_processed_count: 3 },
    ]);
    expect(deleteCalls).toEqual([ARCHIVE_DATASET_ID]);
  });

  it("resumes from just after the existing checkpoint's last_processed_id", async () => {
    const { client } = makeMockCheckpointClient({
      existingRow: { archive_dataset_id: ARCHIVE_DATASET_ID, last_processed_id: "row-old-99", readings_processed_count: 500 },
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(makeRecords(2, "b")));

    await streamArchiveWithResume(client, {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      chunkSize: 50,
      onChunk: () => {},
    });

    const firstCallUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(firstCallUrl.searchParams.get("$where")).toBe(":id > 'row-old-99'");
  });

  it("processes multiple full chunks in sequence, saving the checkpoint after each before fetching the next", async () => {
    const { client, upsertCalls, callOrder } = makeMockCheckpointClient({ existingRow: null });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(makeRecords(2, "c1"))) // full chunk (chunkSize=2)
      .mockResolvedValueOnce(jsonResponse(makeRecords(2, "c2"))) // full chunk
      .mockResolvedValueOnce(jsonResponse(makeRecords(1, "c3"))); // short -> stop
    const onChunkOrder: string[] = [];

    await streamArchiveWithResume(client, {
      archiveDatasetId: ARCHIVE_DATASET_ID,
      chunkSize: 2,
      onChunk: () => {
        onChunkOrder.push("onChunk");
        callOrder.push("onChunk");
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Cursor progression: fresh, then row-c1-1, then row-c2-1.
    expect(new URL(fetchMock.mock.calls[0]?.[0] as string).searchParams.has("$where")).toBe(false);
    expect(new URL(fetchMock.mock.calls[1]?.[0] as string).searchParams.get("$where")).toBe(":id > 'row-c1-1'");
    expect(new URL(fetchMock.mock.calls[2]?.[0] as string).searchParams.get("$where")).toBe(":id > 'row-c2-1'");

    expect(upsertCalls).toEqual([
      { archive_dataset_id: ARCHIVE_DATASET_ID, last_processed_id: "row-c1-1", readings_processed_count: 2 },
      { archive_dataset_id: ARCHIVE_DATASET_ID, last_processed_id: "row-c2-1", readings_processed_count: 4 },
      { archive_dataset_id: ARCHIVE_DATASET_ID, last_processed_id: "row-c3-0", readings_processed_count: 5 },
    ]);

    // Each chunk's onChunk must complete before its own checkpoint upsert
    // (the sequencing the "at most one chunk lost on crash" guarantee
    // depends on), not merely before some later chunk's upsert.
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
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(chunks.map((c) => c.length)).toEqual([5, 3]);
  });

  it("stops immediately and clears the checkpoint without calling onChunk when the first page is already empty", async () => {
    const { client, upsertCalls, deleteCalls } = makeMockCheckpointClient({
      existingRow: { archive_dataset_id: ARCHIVE_DATASET_ID, last_processed_id: "row-last", readings_processed_count: 999 },
    });
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const onChunk = vi.fn();

    await streamArchiveWithResume(client, { archiveDatasetId: ARCHIVE_DATASET_ID, chunkSize: 50, onChunk });

    expect(onChunk).not.toHaveBeenCalled();
    expect(upsertCalls).toEqual([]);
    expect(deleteCalls).toEqual([ARCHIVE_DATASET_ID]);
  });

  it("uses DEFAULT_STREAM_CHUNK_SIZE when chunkSize is not specified", async () => {
    const { client } = makeMockCheckpointClient({ existingRow: null });
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    await streamArchiveWithResume(client, { archiveDatasetId: ARCHIVE_DATASET_ID, onChunk: () => {} });

    const firstCallUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(firstCallUrl.searchParams.get("$limit")).toBe(String(DEFAULT_STREAM_CHUNK_SIZE));
  });

  it("throws when a fetched row is missing a valid :id field", async () => {
    const { client } = makeMockCheckpointClient({ existingRow: null });
    fetchMock.mockResolvedValueOnce(jsonResponse([{ occupancydatetime: "2025-06-10T09:00:00" }]));

    await expect(
      streamArchiveWithResume(client, { archiveDatasetId: ARCHIVE_DATASET_ID, chunkSize: 50, onChunk: () => {} }),
    ).rejects.toThrow(/missing a valid :id field/);
  });

  it("throws rather than continuing on a non-200 Socrata response", async () => {
    const { client } = makeMockCheckpointClient({ existingRow: null });
    fetchMock.mockResolvedValueOnce(jsonResponse([], { ok: false, status: 503, statusText: "Service Unavailable" }));

    await expect(
      streamArchiveWithResume(client, { archiveDatasetId: ARCHIVE_DATASET_ID, chunkSize: 50, onChunk: () => {} }),
    ).rejects.toThrow(/503/);
  });
});
