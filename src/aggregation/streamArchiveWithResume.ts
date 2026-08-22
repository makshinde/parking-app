import type { SupabaseQueryResult } from "../importers/upsertBlockface.ts";
import { buildRequestHeaders, type SocrataRecord } from "../utils/fetchSocrataRecords.ts";

const SOCRATA_BASE_URL = "https://data.seattle.gov/resource";

// Matches SOCRATA_PAGE_LIMIT (fetchSocrataRecords.ts) -- Socrata's own
// per-request cap, so a chunk maps to exactly one Socrata page.
export const DEFAULT_STREAM_CHUNK_SIZE = 50000;

// --- archive_stream_checkpoint persistence ------------------------------

export interface ArchiveStreamCheckpoint {
  archiveDatasetId: string;
  lastProcessedId: string;
  readingsProcessedCount: number;
}

interface ArchiveStreamCheckpointRow {
  archive_dataset_id: string;
  last_processed_id: string;
  readings_processed_count: number;
}

// Same DI shape as BackfillFailuresSupabaseClient (backfill-occupancy-stats.ts):
// a chainable .eq() query builder resolving via .maybeSingle() (zero rows is
// a valid, expected outcome -- a fresh archive with no checkpoint yet --
// not an error), plus upsert and delete.
export interface ArchiveStreamCheckpointQueryBuilder extends PromiseLike<SupabaseQueryResult<ArchiveStreamCheckpointRow[]>> {
  eq(column: string, value: string): ArchiveStreamCheckpointQueryBuilder;
  maybeSingle(): PromiseLike<SupabaseQueryResult<ArchiveStreamCheckpointRow>>;
}

export interface ArchiveStreamCheckpointSupabaseTableBuilder {
  select(columns: string): ArchiveStreamCheckpointQueryBuilder;
  upsert(values: Record<string, unknown>, options: { onConflict: string }): PromiseLike<SupabaseQueryResult>;
  delete(): { eq(column: string, value: string): PromiseLike<SupabaseQueryResult> };
}

export interface ArchiveStreamCheckpointSupabaseClient {
  from(table: string): ArchiveStreamCheckpointSupabaseTableBuilder;
}

// Reads back the checkpoint for one archive, if any. Returns null (not an
// error) when this archive has never been streamed, or was streamed to
// completion and its checkpoint was cleared -- both cases where a caller
// should start fresh with no cursor.
export async function fetchArchiveStreamCheckpoint(
  client: ArchiveStreamCheckpointSupabaseClient,
  archiveDatasetId: string,
): Promise<ArchiveStreamCheckpoint | null> {
  const { data, error } = await client
    .from("archive_stream_checkpoint")
    .select("archive_dataset_id, last_processed_id, readings_processed_count")
    .eq("archive_dataset_id", archiveDatasetId)
    .maybeSingle();

  if (error !== null) {
    throw new Error(
      `fetchArchiveStreamCheckpoint: reading checkpoint for archive_dataset_id=${archiveDatasetId} failed: ${error.message}`,
    );
  }
  if (data === null) {
    return null;
  }

  return {
    archiveDatasetId: data.archive_dataset_id,
    lastProcessedId: data.last_processed_id,
    readingsProcessedCount: data.readings_processed_count,
  };
}

// Upserted on archive_dataset_id (schema.sql's own UNIQUE constraint), so
// each call for the same archive updates its one row in place instead of
// accumulating duplicates.
export async function saveArchiveStreamCheckpoint(
  client: ArchiveStreamCheckpointSupabaseClient,
  checkpoint: ArchiveStreamCheckpoint,
): Promise<void> {
  const { error } = await client.from("archive_stream_checkpoint").upsert(
    {
      archive_dataset_id: checkpoint.archiveDatasetId,
      last_processed_id: checkpoint.lastProcessedId,
      readings_processed_count: checkpoint.readingsProcessedCount,
    },
    { onConflict: "archive_dataset_id" },
  );

  if (error !== null) {
    throw new Error(
      `saveArchiveStreamCheckpoint: writing checkpoint for archive_dataset_id=${checkpoint.archiveDatasetId} failed: ${error.message}`,
    );
  }
}

// Deletes the checkpoint row once a stream has fully exhausted the dataset.
// archive_stream_checkpoint (migrations/011) has no separate 'complete'
// status column -- adding one would need its own migration -- so a finished
// run is represented the same way a never-started one is: no row at all.
// That's a deliberate, not just convenient, choice: both cases want
// exactly the same next action (start fresh, no $where cursor) on a future
// call for this archive_dataset_id, so collapsing them onto one "no
// checkpoint exists" state doesn't lose any information a caller needs.
export async function clearArchiveStreamCheckpoint(
  client: ArchiveStreamCheckpointSupabaseClient,
  archiveDatasetId: string,
): Promise<void> {
  const { error } = await client.from("archive_stream_checkpoint").delete().eq("archive_dataset_id", archiveDatasetId);

  if (error !== null) {
    throw new Error(
      `clearArchiveStreamCheckpoint: deleting checkpoint for archive_dataset_id=${archiveDatasetId} failed: ${error.message}`,
    );
  }
}

// --- Socrata :id-keyset pagination ---------------------------------------

// No $offset, ever (see CLAUDE.md's Architecture section): $offset-based
// pagination on this dataset degrades badly with depth (the same query
// took 5-10s at offset=0 but 92s at offset=4,000,000, live-verified), which
// is exactly what this streaming path exists to avoid. cursorId === null
// means a fresh start -- deliberately no $where clause on :id at all in
// that case, rather than inventing a fake floor value to compare against.
function buildArchivePageUrl(archiveDatasetId: string, cursorId: string | null, chunkSize: number): string {
  const url = new URL(`${SOCRATA_BASE_URL}/${archiveDatasetId}.json`);
  url.searchParams.set("$select", ":id,*");
  url.searchParams.set("$order", ":id");
  url.searchParams.set("$limit", String(chunkSize));
  if (cursorId !== null) {
    url.searchParams.set("$where", `:id > '${cursorId}'`);
  }
  return url.toString();
}

async function fetchArchivePage(archiveDatasetId: string, cursorId: string | null, chunkSize: number): Promise<SocrataRecord[]> {
  const url = buildArchivePageUrl(archiveDatasetId, cursorId, chunkSize);
  const response = await fetch(url, { headers: buildRequestHeaders() });

  if (!response.ok) {
    throw new Error(`streamArchiveWithResume: request to ${url} failed with status ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as SocrataRecord[];
}

// Socrata's own per-row system identifier (e.g. "row-km8v~rgdh.iue6"),
// requested via $select above. Every row genuinely has one (it's how
// Socrata's SODA API tracks rows internally), so a missing/malformed value
// here signals a real problem with the response, not an expected case to
// handle gracefully -- same reasoning parseRawReading uses for missing
// required fields.
function getRecordId(record: SocrataRecord): string {
  const id = record[":id"];
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error(`streamArchiveWithResume: row missing a valid :id field, got ${JSON.stringify(id)}`);
  }
  return id;
}

// --- Streaming orchestration ---------------------------------------------

export interface StreamArchiveOptions {
  archiveDatasetId: string;
  // Defaults to DEFAULT_STREAM_CHUNK_SIZE (Socrata's own per-request cap).
  chunkSize?: number;
  // Called once per fetched chunk, in order. IMPORTANT: onChunk may be
  // called again with the same chunk of readings after a crash-and-resume
  // -- the checkpoint is only saved *after* onChunk finishes for a given
  // chunk (so a crash mid-chunk loses at most that one chunk's worth of
  // work, per the agreed design), which means a chunk whose processing
  // succeeded but whose checkpoint write never landed will be re-fetched
  // and re-delivered to onChunk on the next run. This module guarantees
  // at-least-once delivery of every reading, not exactly-once. Making
  // onChunk's own effect idempotent (e.g. upserting into a per-bucket
  // accumulator keyed by bucket, not appending to a list) is the caller's
  // responsibility, not this module's.
  onChunk: (readings: SocrataRecord[]) => Promise<void> | void;
}

// Streams an entire archive dataset chunk by chunk, resuming from
// archive_stream_checkpoint if a prior run for this archiveDatasetId was
// interrupted. Uses Socrata's :id system field for keyset pagination
// ($where=:id > cursor, $order=:id, no $offset -- see CLAUDE.md's
// Architecture section for why), which stays fast at depth and, since :id
// is guaranteed unique per row, can never skip or duplicate a row at a
// resume boundary the way a timestamp cursor could.
export async function streamArchiveWithResume(
  checkpointClient: ArchiveStreamCheckpointSupabaseClient,
  options: StreamArchiveOptions,
): Promise<void> {
  const chunkSize = options.chunkSize ?? DEFAULT_STREAM_CHUNK_SIZE;

  const existingCheckpoint = await fetchArchiveStreamCheckpoint(checkpointClient, options.archiveDatasetId);
  let cursorId: string | null = existingCheckpoint?.lastProcessedId ?? null;
  let readingsProcessedCount = existingCheckpoint?.readingsProcessedCount ?? 0;

  while (true) {
    const page = await fetchArchivePage(options.archiveDatasetId, cursorId, chunkSize);
    if (page.length === 0) {
      break;
    }

    await options.onChunk(page);

    const lastRecord = page[page.length - 1] as SocrataRecord;
    cursorId = getRecordId(lastRecord);
    readingsProcessedCount += page.length;

    // Checkpoint is written only after onChunk has fully completed for this
    // page -- see StreamArchiveOptions.onChunk's own comment for exactly
    // what that guarantees (at-least-once, not exactly-once) and why.
    await saveArchiveStreamCheckpoint(checkpointClient, {
      archiveDatasetId: options.archiveDatasetId,
      lastProcessedId: cursorId,
      readingsProcessedCount,
    });

    // Fewer rows than requested necessarily means this was the last page
    // (per the agreed stopping rule for this streaming path) -- unlike
    // fetchSocrataRecords.ts's extra-round-trip-to-confirm approach, a
    // short-of-chunkSize page here is treated as terminal immediately. An
    // exact-chunkSize final page still gets one harmless extra request next
    // iteration, which returns zero rows and stops there instead.
    if (page.length < chunkSize) {
      break;
    }
  }

  await clearArchiveStreamCheckpoint(checkpointClient, options.archiveDatasetId);
}
