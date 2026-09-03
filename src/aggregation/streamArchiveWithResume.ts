import type { SupabaseQueryResult } from "../importers/upsertBlockface.ts";
import { buildRequestHeaders, type SocrataRecord } from "../utils/fetchSocrataRecords.ts";
import { buildAccumulatorBucketKey, parseAccumulatorBucketKey, type AccumulatorSnapshot, type WeightedStatsAccumulator } from "./incrementalWeightedStats.ts";

const SOCRATA_BASE_URL = "https://data.seattle.gov/resource";

// Matches SOCRATA_PAGE_LIMIT (fetchSocrataRecords.ts) -- Socrata's own
// per-request cap, so a chunk maps to exactly one Socrata page.
export const DEFAULT_STREAM_CHUNK_SIZE = 50000;

// How often (in chunks) to persist the accumulator snapshot (now a batch of
// per-bucket upserts into archive_stream_accumulator_buckets -- see
// saveArchiveStreamAccumulatorSnapshot), versus the cheap
// last_processed_id/readings_processed_count position update that happens
// every chunk regardless. This number predates the per-bucket-row rewrite
// (it was derived from the old single-JSONB-blob write's cost, back when a
// realistic ~94,064-bucket snapshot averaged ~17,890ms/write and outright
// failed a real, load-independent ~20s external timeout on the larger,
// completely realistic end of this job's actual bucket counts -- see this
// module's git history for the full investigation). The batched-upsert
// rewrite removes that specific failure mode (no single request ever again
// carries the full accumulator state at once), but doesn't change the
// reasoning for why snapshotting every single chunk would still be
// wasteful -- every snapshot event still serializes and writes the ENTIRE
// current accumulator state, not a delta, so a smaller interval still just
// repeats the same total work more often. 120 is kept as the existing,
// still-reasonable value pending a fresh cost measurement against the new
// write path; see DEFAULT_ACCUMULATOR_SNAPSHOT_INTERVAL_CHUNKS's own test
// for the original derivation this constant is pinned to.
export const DEFAULT_ACCUMULATOR_SNAPSHOT_INTERVAL_CHUNKS = 120;

// How often (in chunks) to print archive-streaming progress. Matches
// ROLLING_WINDOW_PROGRESS_LOG_INTERVAL_PAGES's cadence (backfill-occupancy-
// stats.ts) -- the archive-streaming main loop has the exact same "no
// visible progress for a very long time" problem the rolling-window fetch
// had (live-verified there: a real run sat silent for 45+ minutes between
// log lines, indistinguishable from a stalled process). Unconditional, not
// gated behind --max-chunks or any other testing flag -- a real,
// uninterrupted production run spending hours in this loop needs this
// visibility at least as much as a bounded test run does.
export const ARCHIVE_STREAM_PROGRESS_LOG_INTERVAL_CHUNKS = 20;

// --- archive_stream_checkpoint persistence ------------------------------

export interface ArchiveStreamCheckpoint {
  archiveDatasetId: string;
  // Cheap pair: updated every chunk via saveArchiveStreamPosition.
  lastProcessedId: string;
  readingsProcessedCount: number;
  // The :id cursor the accumulator was last snapshotted at (see
  // saveArchiveStreamAccumulatorSnapshot) -- updated only every
  // snapshotIntervalChunks chunks, unlike lastProcessedId above. null means
  // no snapshot has been taken yet (a fresh run, or one still short of its
  // first snapshot boundary). The accumulator's actual per-bucket values
  // live in archive_stream_accumulator_buckets, not on this row -- see
  // fetchAccumulatorBuckets -- this cursor is only the pointer saying how
  // far that table's contents reflect.
  //
  // This pair is deliberately allowed to lag BEHIND lastProcessedId --
  // that's the whole point of the split (see DEFAULT_ACCUMULATOR_SNAPSHOT_INTERVAL_CHUNKS's
  // comment for the real cost that makes every-chunk snapshotting
  // infeasible). streamArchiveWithResume reconciles that lag on resume by
  // re-fetching and re-folding exactly the bounded gap between the two
  // cursors -- never double-counting (the gap is fetched and folded
  // exactly once, into the restored snapshot) and never losing readings
  // (the gap is always well-defined and re-fetchable, bounded by
  // lastProcessedId on one end and accumulatorSnapshotLastProcessedId, or
  // the start of the dataset, on the other).
  accumulatorSnapshotLastProcessedId: string | null;
}

interface ArchiveStreamCheckpointRow {
  archive_dataset_id: string;
  last_processed_id: string;
  readings_processed_count: number;
  accumulator_snapshot_last_processed_id: string | null;
}

export interface ArchiveStreamCheckpointQueryBuilder extends PromiseLike<SupabaseQueryResult<ArchiveStreamCheckpointRow[]>> {
  eq(column: string, value: string): ArchiveStreamCheckpointQueryBuilder;
  maybeSingle(): PromiseLike<SupabaseQueryResult<ArchiveStreamCheckpointRow>>;
}

// Returned by .update(), then narrowed by .eq() to the one row being
// updated, then .select()ed to get the affected row(s) back -- PostgREST
// (and by extension supabase-js) doesn't report an UPDATE's affected row
// count any other way, and a plain UPDATE matching zero rows isn't itself
// an error, so this is what lets saveArchiveStreamAccumulatorSnapshot's
// row-count check work.
export interface ArchiveStreamCheckpointUpdateEqBuilder {
  select(columns: string): PromiseLike<SupabaseQueryResult<ArchiveStreamCheckpointRow[]>>;
}

export interface ArchiveStreamCheckpointUpdateQueryBuilder {
  eq(column: string, value: string): ArchiveStreamCheckpointUpdateEqBuilder;
}

export interface ArchiveStreamCheckpointSupabaseTableBuilder {
  select(columns: string): ArchiveStreamCheckpointQueryBuilder;
  upsert(values: Record<string, unknown>, options: { onConflict: string }): PromiseLike<SupabaseQueryResult>;
  update(values: Record<string, unknown>): ArchiveStreamCheckpointUpdateQueryBuilder;
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
    .select(
      "archive_dataset_id, last_processed_id, readings_processed_count, accumulator_snapshot_last_processed_id",
    )
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
    accumulatorSnapshotLastProcessedId: data.accumulator_snapshot_last_processed_id,
  };
}

// Cheap: updates ONLY the stream's own position. Deliberately does NOT
// include accumulator_snapshot_last_processed_id in the upsert payload, so
// PostgREST's ON CONFLICT DO UPDATE only touches (and the client only ever
// transmits) these two small columns -- whatever snapshot cursor already
// exists on this row is left completely untouched. Called after every
// chunk, unconditionally.
export async function saveArchiveStreamPosition(
  client: ArchiveStreamCheckpointSupabaseClient,
  position: {
    archiveDatasetId: string;
    lastProcessedId: string;
    readingsProcessedCount: number;
  },
): Promise<void> {
  const { error } = await client.from("archive_stream_checkpoint").upsert(
    {
      archive_dataset_id: position.archiveDatasetId,
      last_processed_id: position.lastProcessedId,
      readings_processed_count: position.readingsProcessedCount,
    },
    { onConflict: "archive_dataset_id" },
  );

  if (error !== null) {
    throw new Error(
      `saveArchiveStreamPosition: writing stream position for archive_dataset_id=${position.archiveDatasetId} failed: ${error.message}`,
    );
  }
}

// --- archive_stream_accumulator_buckets persistence ----------------------
//
// The accumulator's per-bucket state (WeightedStatsAccumulator, one entry
// per blockface/iso_day/hour) used to be written as a single JSONB blob on
// archive_stream_checkpoint (accumulator_state), snapshotted as one big
// write. Real, live, controlled testing found that write hitting a hard,
// SIZE-INDEPENDENT ~20-second failure ceiling at realistic bucket counts
// (~110,000+ buckets): payloads ranging from 12.4MB to 16.9MB (a 36% size
// spread) all failed within about 1.4 seconds of each other, which is not
// what a genuine Postgres statement_timeout raised well above that (even a
// SET LOCAL-scoped 60s, tried and live-verified NOT to fix this) should
// look like -- a real per-query timeout would either let all of these
// succeed or fail with times that scale with payload size. That clustering
// is much better explained by an external, fixed-duration cutoff upstream
// of Postgres itself (most plausibly Supabase's connection pooler or API
// gateway) that no amount of raising Postgres's own statement_timeout can
// reach.
//
// This table replaces that single blob with one row per bucket, written via
// many small batched upserts (see upsertAccumulatorBuckets) instead of one
// large write -- structurally avoiding the failure mode regardless of its
// exact external cause, since no individual request ever again carries the
// full accumulator state.
export interface ArchiveStreamAccumulatorBucketRow {
  blockface_id: string;
  iso_day: number;
  hour: number;
  count: number;
  total_weight: number;
  mean: number;
  sum_squared_diff: number;
}

export interface ArchiveStreamAccumulatorBucketsQueryBuilder extends PromiseLike<SupabaseQueryResult<ArchiveStreamAccumulatorBucketRow[]>> {
  eq(column: string, value: string): ArchiveStreamAccumulatorBucketsQueryBuilder;
  order(column: string): ArchiveStreamAccumulatorBucketsQueryBuilder;
  range(from: number, to: number): PromiseLike<SupabaseQueryResult<ArchiveStreamAccumulatorBucketRow[]>>;
}

export interface ArchiveStreamAccumulatorBucketsSupabaseTableBuilder {
  select(columns: string): ArchiveStreamAccumulatorBucketsQueryBuilder;
  upsert(values: Record<string, unknown>[], options: { onConflict: string }): PromiseLike<SupabaseQueryResult>;
}

export interface ArchiveStreamAccumulatorBucketsSupabaseClient {
  from(table: string): ArchiveStreamAccumulatorBucketsSupabaseTableBuilder;
}

// Same DI pattern used throughout this module: both clients are typically
// the same real supabase-js client cast to two different, narrow,
// purpose-specific interfaces (see backfill-occupancy-stats.ts's main()),
// kept separate here because they genuinely target different tables with
// different shapes.
export interface ArchiveStreamClients {
  checkpointClient: ArchiveStreamCheckpointSupabaseClient;
  bucketsClient: ArchiveStreamAccumulatorBucketsSupabaseClient;
}

// Read page size for fetchAccumulatorBuckets -- much larger than the 500
// used for writes (upsertAccumulatorBuckets), since PostgREST reads via
// .range() are cheap, ordinary SELECTs (no write-side timeout risk at all),
// and this table's realistic upper bound (~1,500 blockfaces x 7 days x 24
// hours ~= 252,000 rows max, per archive) is nowhere near the depth where
// even ordinary offset-based pagination would degrade -- that concern
// (CLAUDE.md's Architecture section) is specific to Socrata's
// hundreds-of-millions-of-rows scale, not this table's.
const ACCUMULATOR_BUCKET_READ_PAGE_SIZE = 1000;

// Reads every accumulator bucket row for one archive back into an
// AccumulatorSnapshot, paginating until a short page confirms the end --
// same "page until shorter than the page size" idiom used elsewhere in this
// project (e.g. fetchSocrataRecordsPaginated). Ordered by id for a stable,
// gap-free/duplicate-free .range() walk.
export async function fetchAccumulatorBuckets(
  client: ArchiveStreamAccumulatorBucketsSupabaseClient,
  archiveDatasetId: string,
): Promise<AccumulatorSnapshot> {
  const snapshot: AccumulatorSnapshot = {};
  let from = 0;

  while (true) {
    const to = from + ACCUMULATOR_BUCKET_READ_PAGE_SIZE - 1;
    const { data, error } = await client
      .from("archive_stream_accumulator_buckets")
      .select(
        "blockface_id, iso_day, hour, count, total_weight, mean, sum_squared_diff",
      )
      .eq("archive_dataset_id", archiveDatasetId)
      .order("id")
      .range(from, to);

    if (error !== null) {
      throw new Error(
        `fetchAccumulatorBuckets: reading accumulator buckets for archive_dataset_id=${archiveDatasetId} failed: ${error.message}`,
      );
    }

    const page = data ?? [];
    for (const row of page) {
      const bucketKey = buildAccumulatorBucketKey(
        row.blockface_id,
        row.iso_day,
        row.hour,
      );
      snapshot[bucketKey] = {
        count: row.count,
        totalWeight: row.total_weight,
        mean: row.mean,
        sumSquaredDiff: row.sum_squared_diff,
      };
    }

    if (page.length < ACCUMULATOR_BUCKET_READ_PAGE_SIZE) {
      break;
    }
    from += ACCUMULATOR_BUCKET_READ_PAGE_SIZE;
  }

  return snapshot;
}

// Chosen to match upsertOccupancyStatsBatch's already-proven batch size
// (upsertOccupancyStats.ts): 200 rows/call measured at 129.8ms (0.65ms/row),
// 500 rows/call at 165.7ms (0.33ms/row), both comfortably fast and, more
// importantly here, comfortably far from the ~20s external ceiling this
// table's design exists to avoid.
const ACCUMULATOR_BUCKET_WRITE_CHUNK_SIZE = 500;

function buildAccumulatorBucketRow(
  archiveDatasetId: string,
  bucketKey: string,
  accumulator: WeightedStatsAccumulator,
): Record<string, unknown> {
  const { blockfaceId, isoDay, hour } = parseAccumulatorBucketKey(bucketKey);
  return {
    archive_dataset_id: archiveDatasetId,
    blockface_id: blockfaceId,
    iso_day: isoDay,
    hour,
    count: accumulator.count,
    total_weight: accumulator.totalWeight,
    mean: accumulator.mean,
    sum_squared_diff: accumulator.sumSquaredDiff,
  };
}

// Writes the ENTIRE current accumulator state (not a delta -- same as the
// old single-blob design, and same as how occupancy_stats itself is always
// written as a full row) as many small batched upserts instead of one large
// write. Unlike upsertOccupancyStatsBatch, a batch that fails here is NOT
// retried row-by-row with the failure swallowed: occupancy_stats' row-level
// fallback exists because THAT table ingests externally-computed stats that
// could genuinely contain one bad row needing isolation from its batch-
// mates. This table's rows are internal, structurally-controlled
// accumulator state (every field is always a finite number, by
// construction of WeightedStatsAccumulator) -- there's no realistic "one
// row is bad" case to isolate, and a retry-with-backoff wrapper already
// sits above this whole function (saveArchiveStreamAccumulatorSnapshot), so
// throwing on the first batch error and letting that wrapper retry the
// whole (idempotent) upsert is simpler and just as safe.
async function upsertAccumulatorBuckets(
  client: ArchiveStreamAccumulatorBucketsSupabaseClient,
  archiveDatasetId: string,
  accumulatorState: AccumulatorSnapshot,
): Promise<void> {
  const rows = Object.entries(accumulatorState).map(
    ([bucketKey, accumulator]) =>
      buildAccumulatorBucketRow(archiveDatasetId, bucketKey, accumulator),
  );

  for (let i = 0; i < rows.length; i += ACCUMULATOR_BUCKET_WRITE_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + ACCUMULATOR_BUCKET_WRITE_CHUNK_SIZE);
    const { error } = await client
      .from("archive_stream_accumulator_buckets")
      .upsert(chunk, {
        onConflict: "archive_dataset_id,blockface_id,iso_day,hour",
      });

    if (error !== null) {
      throw new Error(
        `upsertAccumulatorBuckets: batch upsert failed for archive_dataset_id=${archiveDatasetId} (rows ${i}-${i + chunk.length - 1} of ${rows.length}): ${error.message}`,
      );
    }
  }
}

// Marks the one kind of failure known to be structural, not transient: the
// cursor-update row-count check below finding zero matching rows. Retrying
// that would never succeed -- there's no row to update, and no amount of
// waiting creates one -- so it's classified separately from every other
// failure this write can hit (bucket upsert errors included), which
// defaults to retryable.
class SnapshotRowNotFoundError extends Error {}

// Expensive-ish step (many small requests instead of one big one -- see
// upsertAccumulatorBuckets), followed by a cheap cursor advance. The cursor
// (archive_stream_checkpoint.accumulator_snapshot_last_processed_id) is
// updated ONLY after every bucket row has landed successfully -- preserving
// the same atomicity guarantee the old design had (those two specifically
// must never drift apart from EACH OTHER): if the bucket upsert throws, this
// function never reaches the cursor update at all, so a resume correctly
// still sees the OLD snapshot cursor and re-attempts (an idempotent, safe
// redo) rather than believing a snapshot exists that doesn't.
//
// A genuine UPDATE, not an upsert -- same reasoning established for this
// write previously (see this module's git history / PR history): this
// function is only ever called after saveArchiveStreamPosition has already
// created the row for this chunk, or against a checkpoint
// fetchArchiveStreamCheckpoint has just confirmed exists (gap-replay's
// catch-up write), so there's no legitimate case where this row doesn't
// already exist. .select() after .update().eq() is what makes the affected
// row count visible -- PostgREST doesn't report it any other way, and an
// UPDATE matching zero rows isn't itself a PostgREST error.
async function saveArchiveStreamAccumulatorSnapshotOnce(
  clients: ArchiveStreamClients,
  snapshot: {
    archiveDatasetId: string;
    accumulatorSnapshotLastProcessedId: string;
    accumulatorState: AccumulatorSnapshot;
  },
): Promise<void> {
  await upsertAccumulatorBuckets(clients.bucketsClient, snapshot.archiveDatasetId, snapshot.accumulatorState);

  const { data, error } = await clients.checkpointClient
    .from("archive_stream_checkpoint")
    .update({
      accumulator_snapshot_last_processed_id:
        snapshot.accumulatorSnapshotLastProcessedId,
    })
    .eq("archive_dataset_id", snapshot.archiveDatasetId)
    .select("archive_dataset_id");

  if (error !== null) {
    throw new Error(
      `saveArchiveStreamAccumulatorSnapshot: advancing the snapshot cursor for archive_dataset_id=${snapshot.archiveDatasetId} failed: ${error.message}`,
    );
  }

  if (data === null || data.length !== 1) {
    throw new SnapshotRowNotFoundError(
      `saveArchiveStreamAccumulatorSnapshot: expected exactly one existing archive_stream_checkpoint row for archive_dataset_id=${snapshot.archiveDatasetId}, but the cursor update affected ${data?.length ?? 0} row(s) -- this function is only ever called after saveArchiveStreamPosition has already created the row for this chunk, so a missing row signals a real bug upstream, not a normal case to handle gracefully`,
    );
  }
}

// One initial attempt plus up to 3 retries, exponential backoff (1s, 2s,
// 4s) -- same shape as fetchSocrataRecords.ts's fetchPage retry logic, kept
// as a real, meaningful layer even now that no individual request in this
// sequence is large: many small requests still each have their own
// (small) chance of a transient failure, and retrying the whole sequence is
// cheap and safe (upsertAccumulatorBuckets is idempotent; a failure before
// the cursor update simply means the next attempt redoes the upsert
// against a checkpoint cursor that hasn't moved yet).
export const MAX_SNAPSHOT_WRITE_ATTEMPTS = 4;
const SNAPSHOT_WRITE_RETRY_BASE_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function saveArchiveStreamAccumulatorSnapshot(
  clients: ArchiveStreamClients,
  snapshot: {
    archiveDatasetId: string;
    accumulatorSnapshotLastProcessedId: string;
    accumulatorState: AccumulatorSnapshot;
  },
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_SNAPSHOT_WRITE_ATTEMPTS; attempt++) {
    try {
      await saveArchiveStreamAccumulatorSnapshotOnce(clients, snapshot);
      return;
    } catch (err) {
      const retryable = !(err instanceof SnapshotRowNotFoundError);
      const isLastAttempt = attempt === MAX_SNAPSHOT_WRITE_ATTEMPTS;
      if (!retryable || isLastAttempt) {
        throw err;
      }

      const delayMs = SNAPSHOT_WRITE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `saveArchiveStreamAccumulatorSnapshot: attempt ${attempt}/${MAX_SNAPSHOT_WRITE_ATTEMPTS} failed for archive_dataset_id=${snapshot.archiveDatasetId} (${reason}); retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }
}

// Deletes the checkpoint row once a stream has fully exhausted the dataset.
// archive_stream_checkpoint has no separate 'complete' status column --
// adding one would need its own migration -- so a finished run is
// represented the same way a never-started one is: no row at all. That's a
// deliberate, not just convenient, choice: both cases want exactly the same
// next action (start fresh, no cursors) on a future call for this
// archive_dataset_id, so collapsing them onto one "no checkpoint exists"
// state doesn't lose any information a caller needs. Deliberately does NOT
// also delete this archive's rows from archive_stream_accumulator_buckets --
// those hold the actual accumulated stats, which main() still needs to read
// from the in-memory Map immediately after this returns; deleting them here
// would risk data loss if the subsequent occupancy_stats write step crashes
// before completing (see the buckets-cleanup note in this project's own
// design discussion -- deliberately left as a known non-issue for now, not
// built).
export async function clearArchiveStreamCheckpoint(
  client: ArchiveStreamCheckpointSupabaseClient,
  archiveDatasetId: string,
): Promise<void> {
  const { error } = await client
    .from("archive_stream_checkpoint")
    .delete()
    .eq("archive_dataset_id", archiveDatasetId);

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
// means no lower bound -- deliberately no $where clause on that side at
// all, rather than inventing a fake floor value to compare against.
// upperBoundId, when given, bounds a fetch to a known, already-fetched
// range (used by the gap-replay logic below) -- both conditions combine
// into a single AND'd $where when both are present.
function buildArchivePageUrl(
  archiveDatasetId: string,
  cursorId: string | null,
  chunkSize: number,
  upperBoundId: string | null = null,
): string {
  const url = new URL(`${SOCRATA_BASE_URL}/${archiveDatasetId}.json`);
  // SoQL requires a star selection to come first in the select-list --
  // live-verified against the real API: "*,:id" succeeds, ":id,*" fails
  // with query.compiler.malformed ("Star selections must come at the start
  // of the select-list").
  url.searchParams.set("$select", "*,:id");
  url.searchParams.set("$order", ":id");
  url.searchParams.set("$limit", String(chunkSize));

  const whereClauses: string[] = [];
  if (cursorId !== null) {
    whereClauses.push(`:id > '${cursorId}'`);
  }
  if (upperBoundId !== null) {
    whereClauses.push(`:id <= '${upperBoundId}'`);
  }
  if (whereClauses.length > 0) {
    url.searchParams.set("$where", whereClauses.join(" AND "));
  }

  return url.toString();
}

// Marks the one kind of failure this can identify with certainty as
// non-transient: a successfully-received response carrying a 4xx status --
// same reasoning as fetchSocrataRecords.ts's SocrataRequestError. The
// request itself is wrong (bad $where, bad dataset id) -- retrying it would
// fail identically every time. Everything else (fetch() failing to connect,
// response.json() failing to read/parse the body, a 5xx, or anything else
// not explicitly classified here) defaults to retryable, same reasoning as
// that module's fetchPage.
class ArchiveFetchError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "ArchiveFetchError";
    this.retryable = retryable;
  }
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

// This was, until now, the one fetch path in the whole pipeline with NO
// retry protection -- fetchSocrataRecords.ts's fetchPage (used for the
// rolling window) already had this. Confirmed as a real, live gap, not a
// hypothetical: a real production run hit a transient ECONNRESET (undici's
// "TypeError: terminated" wrapping it) immediately on resuming, and a fresh
// retry of that same run later died on a 10-second UND_ERR_CONNECT_TIMEOUT
// after successfully processing 120 more chunks -- both exactly the class
// of transient, non-4xx failure this retry logic exists to absorb. Same
// shape as fetchSocrataRecords.ts's fetchPage: one initial attempt plus up
// to 3 retries, exponential backoff (1s, 2s, 4s).
export const MAX_ARCHIVE_FETCH_ATTEMPTS = 4;
const ARCHIVE_FETCH_RETRY_BASE_DELAY_MS = 1000;

async function fetchArchivePageOnce(url: string): Promise<SocrataRecord[]> {
  const response = await fetch(url, { headers: buildRequestHeaders() });

  if (!response.ok) {
    throw new ArchiveFetchError(
      `streamArchiveWithResume: request to ${url} failed with status ${response.status} ${response.statusText}`,
      isRetryableStatus(response.status),
    );
  }

  return (await response.json()) as SocrataRecord[];
}

async function fetchArchivePage(
  archiveDatasetId: string,
  cursorId: string | null,
  chunkSize: number,
  upperBoundId: string | null = null,
): Promise<SocrataRecord[]> {
  const url = buildArchivePageUrl(archiveDatasetId, cursorId, chunkSize, upperBoundId);

  for (let attempt = 1; attempt <= MAX_ARCHIVE_FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetchArchivePageOnce(url);
    } catch (err) {
      const retryable = !(err instanceof ArchiveFetchError) || err.retryable;
      const isLastAttempt = attempt === MAX_ARCHIVE_FETCH_ATTEMPTS;
      if (!retryable || isLastAttempt) {
        throw err;
      }

      const delayMs = ARCHIVE_FETCH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `streamArchiveWithResume: attempt ${attempt}/${MAX_ARCHIVE_FETCH_ATTEMPTS} failed to fetch archive page (${reason}); retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }

  // Unreachable: the loop above always either returns a page or throws on
  // its final iteration.
  throw new Error("streamArchiveWithResume: fetchArchivePage exhausted retries without a resolved result");
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
  // Real Socrata dataset id to fetch archive pages from -- used ONLY for
  // building Socrata request URLs (fetchArchivePage/buildArchivePageUrl,
  // including inside replayAccumulatorGap). Never used as a table identity
  // -- see storageIdentity below.
  archiveDatasetId: string;
  // Which archive_dataset_id identity to read/write against in
  // archive_stream_checkpoint and archive_stream_accumulator_buckets.
  // Defaults to archiveDatasetId when omitted -- every caller before this
  // field existed had its storage identity match its Socrata source 1:1,
  // so omitting this preserves that behavior exactly. Set it explicitly
  // when the two need to diverge -- e.g. streaming a real dataset (say,
  // "q2e4-e7e5") into an accumulator identity that isn't itself a real
  // Socrata dataset id at all (e.g. "combined-history-staging", a manually
  // seeded merge of multiple archives' totals).
  storageIdentity?: string;
  // Defaults to DEFAULT_STREAM_CHUNK_SIZE (Socrata's own per-request cap).
  chunkSize?: number;
  // Defaults to DEFAULT_ACCUMULATOR_SNAPSHOT_INTERVAL_CHUNKS.
  snapshotIntervalChunks?: number;
  // Called once, before ANY onChunk call (including gap-replay's below),
  // only when a checkpoint already existed for this archiveDatasetId --
  // hands back the accumulator state exactly as it was last snapshotted
  // (accumulatorSnapshotLastProcessedId), which may itself still be behind
  // lastProcessedId. This is what seeds the caller's own accumulators
  // (e.g. repopulate a Map<bucketKey, WeightedStatsAccumulator>) with a
  // correct starting point -- onChunk's contract only ever receives a page
  // of readings, never "the current state," so gap-replay's onChunk calls
  // have nothing right to build on unless the caller was seeded first via
  // this hook. Never called on a genuinely fresh start (nothing to
  // restore).
  onResume?: (accumulatorState: AccumulatorSnapshot) => Promise<void> | void;
  // Called once per fetched chunk, in order -- including chunks fetched
  // during startup gap-replay, not just the main loop -- and must return
  // the caller's complete, up-to-date accumulator snapshot after folding
  // this chunk's readings in.
  //
  // IMPORTANT: onChunk may be called again with the same chunk of readings
  // after a crash-and-resume (either the main loop's own chunk, or a gap
  // chunk being replayed) -- this module guarantees at-least-once delivery
  // of every reading, not exactly-once. Making onChunk's own effect
  // idempotent (e.g. upserting into a per-bucket accumulator keyed by
  // bucket, not appending to a list) is the caller's responsibility.
  onChunk: (readings: SocrataRecord[]) => Promise<AccumulatorSnapshot> | AccumulatorSnapshot;
}

interface GapReplayResult {
  accumulatorState: AccumulatorSnapshot;
}

// Re-fetches and re-folds only the bounded range of readings between a
// stale accumulator snapshot and the stream's actual position -- never the
// whole dataset. fromCursorId (exclusive) is the snapshot's own cursor, or
// null if no snapshot has ever been taken yet (replay from the very start
// of the dataset); toCursorId (inclusive) is lastProcessedId. Because the
// upper bound is known exactly in advance, this can detect "done" by
// reaching that exact id, rather than relying on a short-page heuristic
// the way the open-ended main loop does.
async function replayAccumulatorGap(
  archiveDatasetId: string,
  chunkSize: number,
  fromCursorId: string | null,
  toCursorId: string,
  initialAccumulatorState: AccumulatorSnapshot,
  onChunk: StreamArchiveOptions["onChunk"],
): Promise<GapReplayResult> {
  let cursorId = fromCursorId;
  let accumulatorState = initialAccumulatorState;

  while (cursorId !== toCursorId) {
    const page = await fetchArchivePage(archiveDatasetId, cursorId, chunkSize, toCursorId);
    if (page.length === 0) {
      // The bound is inclusive and toCursorId is itself a real row that was
      // already fetched by the main stream, so this can only happen if
      // fromCursorId and toCursorId were equal to begin with (no gap) --
      // streamArchiveWithResume skips calling this function in that case,
      // so reaching here with an empty page would indicate a real bug, not
      // a normal empty-dataset outcome.
      throw new Error(
        `streamArchiveWithResume: gap replay for archive_dataset_id=${archiveDatasetId} found no rows between '${fromCursorId}' and '${toCursorId}', but the two cursors differ -- this should be unreachable`,
      );
    }

    accumulatorState = await onChunk(page);
    cursorId = getRecordId(page[page.length - 1] as SocrataRecord);
  }

  return { accumulatorState };
}

// Streams an entire archive dataset chunk by chunk, resuming from
// archive_stream_checkpoint if a prior run for this archiveDatasetId was
// interrupted. Uses Socrata's :id system field for keyset pagination
// ($where=:id > cursor, $order=:id, no $offset -- see CLAUDE.md's
// Architecture section for why), which stays fast at depth and, since :id
// is guaranteed unique per row, can never skip or duplicate a row at a
// resume boundary the way a timestamp cursor could.
//
// Checkpointing is split into two independently-paced pieces (see
// DEFAULT_ACCUMULATOR_SNAPSHOT_INTERVAL_CHUNKS for the real cost numbers
// behind this): a cheap stream-position update every chunk, and an
// accumulator-state snapshot (many small batched upserts into
// archive_stream_accumulator_buckets, see saveArchiveStreamAccumulatorSnapshot)
// only every snapshotIntervalChunks chunks. A resume reconciles the
// resulting gap between the two by re-fetching and re-folding exactly that
// bounded range before continuing normal streaming -- never the whole
// dataset, and never double-counting, since the gap is fetched and folded
// exactly once into the restored snapshot.
export async function streamArchiveWithResume(clients: ArchiveStreamClients, options: StreamArchiveOptions): Promise<void> {
  const { checkpointClient, bucketsClient } = clients;
  const chunkSize = options.chunkSize ?? DEFAULT_STREAM_CHUNK_SIZE;
  const snapshotIntervalChunks = options.snapshotIntervalChunks ?? DEFAULT_ACCUMULATOR_SNAPSHOT_INTERVAL_CHUNKS;
  // Resolved once, used for every checkpoint/accumulator-table call below --
  // options.archiveDatasetId (the real Socrata source) is used only where a
  // Socrata request is actually made (fetchArchivePage, including inside
  // replayAccumulatorGap). See StreamArchiveOptions.storageIdentity's own
  // comment for why these two can differ.
  const storageIdentity = options.storageIdentity ?? options.archiveDatasetId;

  const existingCheckpoint = await fetchArchiveStreamCheckpoint(checkpointClient, storageIdentity);
  let cursorId: string | null = existingCheckpoint?.lastProcessedId ?? null;
  let readingsProcessedCount = existingCheckpoint?.readingsProcessedCount ?? 0;
  let accumulatorState: AccumulatorSnapshot = {};

  if (existingCheckpoint !== null) {
    // Read back whatever accumulator state has been durably snapshotted so
    // far for this archive (empty if no snapshot has ever landed yet -- see
    // fetchAccumulatorBuckets, which simply returns {} for zero matching
    // rows, same as a fresh run).
    accumulatorState = await fetchAccumulatorBuckets(bucketsClient, storageIdentity);

    // Fires FIRST, before any onChunk call (including gap-replay's below)
    // -- this is what seeds the caller's own local accumulator (e.g. a
    // Map<bucketKey, WeightedStatsAccumulator>) with the last snapshotted
    // state. onChunk's contract only ever receives a page of readings, not
    // "the current accumulator state" -- the caller is expected to
    // maintain that state itself across calls, so gap-replay's onChunk
    // calls below would have nothing correct to build on if onResume
    // hadn't already restored the starting point first.
    await options.onResume?.(accumulatorState);

    const snapshotCursorId = existingCheckpoint.accumulatorSnapshotLastProcessedId;

    if (snapshotCursorId !== existingCheckpoint.lastProcessedId) {
      // The accumulator snapshot lags behind the stream's real position --
      // expected and normal under this design, not a sign of corruption.
      // Catch it up now, folding the gap into the (already-seeded) caller
      // state via the normal onChunk path. Fetches from the real Socrata
      // source (archiveDatasetId), same as the main loop below.
      const replayResult = await replayAccumulatorGap(
        options.archiveDatasetId,
        chunkSize,
        snapshotCursorId,
        existingCheckpoint.lastProcessedId,
        accumulatorState,
        options.onChunk,
      );
      accumulatorState = replayResult.accumulatorState;

      // Persist the now-caught-up snapshot immediately -- the expensive
      // recompute has already been paid for, so a future crash shouldn't
      // have to redo this same replay.
      await saveArchiveStreamAccumulatorSnapshot(clients, {
        archiveDatasetId: storageIdentity,
        accumulatorSnapshotLastProcessedId: existingCheckpoint.lastProcessedId,
        accumulatorState,
      });
    }
  }

  let chunksSinceLastSnapshot = 0;
  let totalChunksProcessed = 0;

  while (true) {
    const page = await fetchArchivePage(options.archiveDatasetId, cursorId, chunkSize);
    if (page.length === 0) {
      break;
    }

    accumulatorState = await options.onChunk(page);

    cursorId = getRecordId(page[page.length - 1] as SocrataRecord);
    readingsProcessedCount += page.length;
    chunksSinceLastSnapshot += 1;
    totalChunksProcessed += 1;

    // Cheap, every chunk -- see saveArchiveStreamPosition's own comment for
    // why this stays cheap even once a large accumulator snapshot already
    // exists on the row.
    await saveArchiveStreamPosition(checkpointClient, {
      archiveDatasetId: storageIdentity,
      lastProcessedId: cursorId,
      readingsProcessedCount,
    });

    if (totalChunksProcessed % ARCHIVE_STREAM_PROGRESS_LOG_INTERVAL_CHUNKS === 0) {
      console.log(`Archive streaming progress: ${totalChunksProcessed} chunks processed this run, ${readingsProcessedCount} total readings processed.`);
    }

    if (chunksSinceLastSnapshot >= snapshotIntervalChunks) {
      // Written AFTER the position update above (never before): that
      // ordering guarantees accumulator_snapshot_last_processed_id can
      // only ever be behind or equal to last_processed_id, never ahead of
      // it -- if it could get ahead (e.g. this write landed but the
      // position write above then failed), a resume would under-fetch and
      // silently skip readings the snapshot already counted, rather than
      // the safe, bounded-replay gap this design is built to handle.
      await saveArchiveStreamAccumulatorSnapshot(clients, {
        archiveDatasetId: storageIdentity,
        accumulatorSnapshotLastProcessedId: cursorId,
        accumulatorState,
      });
      chunksSinceLastSnapshot = 0;
    }

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

  await clearArchiveStreamCheckpoint(checkpointClient, storageIdentity);
}
