import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCliOptions, streamArchiveIntoStaging, type StreamIntoStagingClients } from "./stream-into-staging.ts";
import type { SocrataRecord } from "../utils/fetchSocrataRecords.ts";
import type { ArchiveStreamAccumulatorBucketsSupabaseClient, ArchiveStreamCheckpointSupabaseClient } from "./streamArchiveWithResume.ts";

// --- parseCliOptions -------------------------------------------------------

describe("parseCliOptions", () => {
  it("parses both required flags with no --max-chunks", () => {
    expect(parseCliOptions(["--source-dataset=q2e4-e7e5", "--storage-identity=combined-history-staging"])).toEqual({
      sourceDataset: "q2e4-e7e5",
      storageIdentity: "combined-history-staging",
      maxChunks: null,
    });
  });

  it("parses --max-chunks alongside the two required flags", () => {
    expect(
      parseCliOptions(["--source-dataset=q2e4-e7e5", "--storage-identity=combined-history-staging", "--max-chunks=5"]),
    ).toEqual({ sourceDataset: "q2e4-e7e5", storageIdentity: "combined-history-staging", maxChunks: 5 });
  });

  it("throws when --source-dataset is missing", () => {
    expect(() => parseCliOptions(["--storage-identity=combined-history-staging"])).toThrow(/--source-dataset/);
  });

  it("throws when --storage-identity is missing", () => {
    expect(() => parseCliOptions(["--source-dataset=q2e4-e7e5"])).toThrow(/--storage-identity/);
  });

  it("throws when --source-dataset is given but empty", () => {
    expect(() => parseCliOptions(["--source-dataset=", "--storage-identity=x"])).toThrow(/must not be empty/);
  });

  it("throws for a non-positive-integer --max-chunks", () => {
    expect(() =>
      parseCliOptions(["--source-dataset=q2e4-e7e5", "--storage-identity=x", "--max-chunks=0"]),
    ).toThrow(/must be a positive integer/);
  });

  // Neither flag defaults from the other -- unlike streamArchiveWithResume's
  // own storageIdentity, this script exists specifically for cases where
  // the two must be told apart explicitly.
  it("never defaults storage-identity from source-dataset or vice versa", () => {
    expect(() => parseCliOptions(["--source-dataset=q2e4-e7e5"])).toThrow();
    expect(() => parseCliOptions(["--storage-identity=combined-history-staging"])).toThrow();
  });
});

// --- streamArchiveIntoStaging ----------------------------------------------

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number; statusText?: string }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    json: () => Promise.resolve(body),
  } as Response;
}

function makeRawRecord(idSuffix: string, overrides: Partial<Record<string, unknown>> = {}): SocrataRecord {
  return {
    ":id": `row-${idSuffix}`,
    sourceelementkey: "9477",
    sideofstreet: "W",
    occupancydatetime: "2026-01-15T09:00:00.000",
    paidoccupancy: "1",
    parkingspacecount: "8",
    ...overrides,
  };
}

// A minimal, self-contained in-memory mock of both tables
// streamArchiveWithResume reads/writes, scoped to exactly what this test
// file needs (not the full diagnostic surface streamArchiveWithResume.test.ts's
// own mock exposes -- that one is local to that file, by this project's own
// convention of not sharing unexported test helpers across files).
function makeMockClients(options: {
  existingCheckpointRow?: Record<string, unknown> | null;
  existingBucketRows?: Record<string, unknown>[];
} = {}): { clients: StreamIntoStagingClients; checkpointRows: Map<string, Record<string, unknown>> } {
  const checkpointRows = new Map<string, Record<string, unknown>>();
  if (options.existingCheckpointRow) {
    checkpointRows.set(options.existingCheckpointRow.archive_dataset_id as string, options.existingCheckpointRow);
  }
  let bucketRows: Record<string, unknown>[] = options.existingBucketRows !== undefined ? [...options.existingBucketRows] : [];

  const checkpointClient: ArchiveStreamCheckpointSupabaseClient = {
    from: () =>
      ({
        select: () => {
          let filterId: string | undefined;
          const builder = {
            eq: (_c: string, value: string) => {
              filterId = value;
              return builder;
            },
            maybeSingle: async () => ({ data: filterId !== undefined ? (checkpointRows.get(filterId) ?? null) : null, error: null }),
          };
          return builder;
        },
        upsert: async (row: Record<string, unknown>) => {
          const id = row.archive_dataset_id as string;
          checkpointRows.set(id, { ...checkpointRows.get(id), ...row });
          return { data: null, error: null };
        },
        update: (values: Record<string, unknown>) => ({
          eq: (_c: string, id: string) => ({
            select: async () => {
              const existing = checkpointRows.get(id);
              if (existing === undefined) return { data: [], error: null };
              checkpointRows.set(id, { ...existing, ...values });
              return { data: [checkpointRows.get(id)], error: null };
            },
          }),
        }),
        delete: () => ({
          eq: async (_c: string, id: string) => {
            checkpointRows.delete(id);
            return { data: [], error: null };
          },
        }),
      }) as unknown as ReturnType<ArchiveStreamCheckpointSupabaseClient["from"]>,
  };

  const bucketsClient: ArchiveStreamAccumulatorBucketsSupabaseClient = {
    from: () =>
      ({
        select: () => {
          let filterId: string | undefined;
          const builder = {
            eq: (_c: string, value: string) => {
              filterId = value;
              return builder;
            },
            order: () => builder,
            range: async (from: number, to: number) => {
              const filtered = bucketRows.filter((r) => r.archive_dataset_id === filterId);
              return { data: filtered.slice(from, to + 1), error: null };
            },
          };
          return builder;
        },
        upsert: async (rows: Record<string, unknown>[]) => {
          for (const row of rows) {
            const key = `${row.archive_dataset_id}:${row.blockface_id}:${row.iso_day}:${row.hour}`;
            const idx = bucketRows.findIndex(
              (r) => `${r.archive_dataset_id}:${r.blockface_id}:${r.iso_day}:${r.hour}` === key,
            );
            if (idx >= 0) bucketRows[idx] = { ...bucketRows[idx], ...row };
            else bucketRows.push(row);
          }
          return { data: null, error: null };
        },
      }) as unknown as ReturnType<ArchiveStreamAccumulatorBucketsSupabaseClient["from"]>,
  };

  return { clients: { checkpointClient, bucketsClient }, checkpointRows };
}

const LOOKUP = new Map([["9477:W", "blockface-1"]]);
const NOW = new Date("2026-06-01T12:00:00Z");

describe("streamArchiveIntoStaging", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches from the real source dataset and folds real records into a fresh storage identity", async () => {
    const { clients, checkpointRows } = makeMockClients();
    fetchMock.mockResolvedValueOnce(jsonResponse([makeRawRecord("1"), makeRawRecord("2")])); // short page -> stop

    const result = await streamArchiveIntoStaging(
      clients,
      LOOKUP,
      { sourceDataset: "q2e4-e7e5", storageIdentity: "combined-history-staging", maxChunks: null },
      NOW,
    );

    expect(result.bucketsInMemory).toBe(1); // both records match blockface-1, same day/hour bucket
    expect(result.unmatchedCount).toBe(0);
    expect(result.parseFailures).toBe(0);
    expect(result.stoppedEarly).toBe(false);

    // The Socrata request used the real source dataset id.
    const fetchUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(fetchUrl).toContain("/resource/q2e4-e7e5.json");

    // The checkpoint that got created (then cleared, on natural completion)
    // was tagged with the storage identity -- confirmed indirectly: no row
    // remains under either identity after a clean, single-page completion
    // (clearArchiveStreamCheckpoint fires), and no row was ever created
    // under the real source dataset id at all.
    expect(checkpointRows.has("q2e4-e7e5")).toBe(false);
    expect(checkpointRows.has("combined-history-staging")).toBe(false);
  });

  it("resumes from an existing storage-identity checkpoint and MERGES with it, rather than starting from zero", async () => {
    const { clients } = makeMockClients({
      existingCheckpointRow: {
        archive_dataset_id: "combined-history-staging",
        last_processed_id: "row-old",
        readings_processed_count: 500,
        accumulator_snapshot_last_processed_id: "row-old",
      },
      existingBucketRows: [
        {
          archive_dataset_id: "combined-history-staging",
          blockface_id: "blockface-preexisting",
          iso_day: 3,
          hour: 10,
          count: 240,
          total_weight: 118.4,
          mean: 0.62,
          sum_squared_diff: 7.68,
        },
      ],
    });
    fetchMock.mockResolvedValueOnce(jsonResponse([makeRawRecord("new")])); // short -> stop

    const result = await streamArchiveIntoStaging(
      clients,
      LOOKUP,
      { sourceDataset: "q2e4-e7e5", storageIdentity: "combined-history-staging", maxChunks: null },
      NOW,
    );

    // The pre-existing bucket (from before this run) plus the new one
    // folded from this run's fetch -- confirms onResume genuinely merges,
    // not replaces.
    expect(result.bucketsInMemory).toBe(2);

    // The fetch continued from the checkpoint's own position, not from the
    // start of the dataset.
    const fetchUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(new URL(fetchUrl).searchParams.get("$where")).toContain("row-old");
  });

  // The exact bug this fix closes, live-confirmed against the real
  // database before this test was written: a first run against a storage
  // identity that already has real accumulator rows (e.g. a manually
  // duplicated/seeded merge) but NO checkpoint row yet used to fold only
  // its own newly-fetched chunks into a Map that started completely
  // empty -- streamArchiveWithResume's onResume hook only fires when a
  // checkpoint already exists, so the pre-existing accumulator rows were
  // silently ignored. This is the critical test proving the fix: no
  // checkpoint, but real pre-existing accumulator rows, must seed from
  // them rather than starting from zero.
  it("seeds from pre-existing accumulator rows even when NO checkpoint exists yet, rather than starting empty", async () => {
    const { clients, checkpointRows } = makeMockClients({
      existingCheckpointRow: null, // the exact condition that triggered the bug: no checkpoint at all
      existingBucketRows: [
        {
          archive_dataset_id: "combined-history-staging",
          blockface_id: "blockface-preexisting-1",
          iso_day: 1,
          hour: 8,
          count: 2100,
          total_weight: 1040.5,
          mean: 0.5,
          sum_squared_diff: 12.3,
        },
        {
          archive_dataset_id: "combined-history-staging",
          blockface_id: "blockface-preexisting-2",
          iso_day: 5,
          hour: 17,
          count: 1980,
          total_weight: 990.1,
          mean: 0.5,
          sum_squared_diff: 11.1,
        },
      ],
    });
    expect(checkpointRows.has("combined-history-staging")).toBe(false); // confirms the precondition
    fetchMock.mockResolvedValueOnce(jsonResponse([makeRawRecord("new")])); // one new, distinct-bucket record; short page -> stop

    const result = await streamArchiveIntoStaging(
      clients,
      LOOKUP,
      { sourceDataset: "q2e4-e7e5", storageIdentity: "combined-history-staging", maxChunks: null },
      NOW,
    );

    // Both pre-existing buckets PLUS the one newly-folded bucket -- not
    // just the 1 bucket this run's own fetch would produce on its own,
    // which is what the bug looked like (bucketsInMemory === 1).
    expect(result.bucketsInMemory).toBe(3);

    // And the fetch still started from the beginning of the source dataset
    // (no checkpoint existed to resume a position from) -- confirms the
    // seed is purely about the ACCUMULATOR state, not a fabricated stream
    // position.
    const fetchUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(new URL(fetchUrl).searchParams.has("$where")).toBe(false);
  });

  it("never reads or writes a checkpoint/bucket row under a DIFFERENT storage identity (e.g. the real production one)", async () => {
    const { clients, checkpointRows } = makeMockClients({
      existingCheckpointRow: {
        archive_dataset_id: "7c2e-uany",
        last_processed_id: "row-real-production-position",
        readings_processed_count: 999999,
        accumulator_snapshot_last_processed_id: "row-real-production-position",
      },
    });
    fetchMock.mockResolvedValueOnce(jsonResponse([])); // empty -> fresh run, immediately done

    await streamArchiveIntoStaging(
      clients,
      LOOKUP,
      { sourceDataset: "q2e4-e7e5", storageIdentity: "combined-history-staging", maxChunks: null },
      NOW,
    );

    // The real "7c2e-uany" checkpoint is completely untouched.
    expect(checkpointRows.get("7c2e-uany")).toEqual({
      archive_dataset_id: "7c2e-uany",
      last_processed_id: "row-real-production-position",
      readings_processed_count: 999999,
      accumulator_snapshot_last_processed_id: "row-real-production-position",
    });
  });

  it("stops early and reports stoppedEarly when --max-chunks is reached", async () => {
    // createMaxChunksOnChunk throws INSIDE onChunk, before
    // streamArchiveWithResume ever gets to check whether this page was
    // short -- so this genuinely exercises the --max-chunks stop, not just
    // the natural-short-page one, even though this mock only returns a
    // single (short) page: the throw happens first, on the very same
    // chunk, and streamArchiveIntoStaging's own try/catch turns it into
    // stoppedEarly=true rather than letting it propagate.
    const { clients } = makeMockClients();
    fetchMock.mockResolvedValueOnce(jsonResponse([makeRawRecord("1")]));

    const result = await streamArchiveIntoStaging(
      clients,
      LOOKUP,
      { sourceDataset: "q2e4-e7e5", storageIdentity: "combined-history-staging", maxChunks: 1 },
      NOW,
    );

    expect(result.stoppedEarly).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
