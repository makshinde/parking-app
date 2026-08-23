import type { SupabaseQueryResult } from "../importers/upsertBlockface.ts";
import { buildRequestHeaders, type SocrataRecord } from "../utils/fetchSocrataRecords.ts";
import type { AccumulatorSnapshot } from "./incrementalWeightedStats.ts";

const SOCRATA_BASE_URL = "https://data.seattle.gov/resource";

// Matches SOCRATA_PAGE_LIMIT (fetchSocrataRecords.ts) -- Socrata's own
// per-request cap, so a chunk maps to exactly one Socrata page.
export const DEFAULT_STREAM_CHUNK_SIZE = 50000;

// How often (in chunks) to persist the expensive accumulator_state
// snapshot, versus the cheap last_processed_id/readings_processed_count
// position update that happens every chunk regardless. Derived from real,
// live-measured numbers, not a guess:
//
//   - A realistic ~94,064-bucket AccumulatorSnapshot (last night's real
//     observed bucket count) serializes to ~13.66MB and, written as part of
//     a checkpoint upsert against the live archive_stream_checkpoint table,
//     averaged 17,890ms/write across 3 successful live attempts -- and
//     outright failed with a Postgres statement timeout on 2 of 5 attempts.
//     That's ~175x slower than the ~102ms/write lightweight position-only
//     checkpoint measured earlier (9.5s / 93 chunks).
//   - The full archive is ceil(300,055,806 / 50,000) = 6,002 chunks.
//   - Target: keep total accumulator-snapshot overhead to roughly 5% of the
//     ~5-hour (18,000,000ms) honest full-archive estimate, i.e. a budget of
//     900,000ms.
//   - Solving (totalChunks / N) * measuredSnapshotWriteMs <= budgetMs for N:
//       N >= totalChunks * measuredSnapshotWriteMs / budgetMs
//          = 6,002 * 17,890 / 900,000
//          ~= 119.37
//   - Rounded UP to 120 (rounding up means fewer, not more, snapshots --
//     the direction that keeps overhead at or under the target rather than
//     over it): ceil(6002/120) = 51 snapshots x 17.89s ~= 912.9s ~= 15.2
//     minutes, ~5.07% of the 5-hour estimate -- matching the "roughly 5%"
//     target this was solved for.
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
  // Expensive pair: updated only every
  // DEFAULT_ACCUMULATOR_SNAPSHOT_INTERVAL_CHUNKS chunks via
  // saveArchiveStreamAccumulatorSnapshot, written atomically together (see
  // that function's own comment for why those two specifically must never
  // drift apart from EACH OTHER). accumulatorSnapshotLastProcessedId is
  // null when no snapshot has been taken yet (a fresh run, or one still
  // short of its first snapshot boundary) -- accumulatorState is then just
  // the default empty '{}'.
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
  accumulatorState: AccumulatorSnapshot;
}

interface ArchiveStreamCheckpointRow {
  archive_dataset_id: string;
  last_processed_id: string;
  readings_processed_count: number;
  accumulator_snapshot_last_processed_id: string | null;
  accumulator_state: AccumulatorSnapshot;
}

// Same DI shape as BackfillFailuresSupabaseClient (backfill-occupancy-stats.ts):
// a chainable .eq() query builder resolving via .maybeSingle() (zero rows is
// a valid, expected outcome -- a fresh archive with no checkpoint yet --
// not an error), plus upsert, update, and delete.
export interface ArchiveStreamCheckpointQueryBuilder extends PromiseLike<SupabaseQueryResult<ArchiveStreamCheckpointRow[]>> {
  eq(column: string, value: string): ArchiveStreamCheckpointQueryBuilder;
  maybeSingle(): PromiseLike<SupabaseQueryResult<ArchiveStreamCheckpointRow>>;
}

// .update()'s own builder shape, distinct from .select()'s above: chains
// .eq() the same way, but resolves via .select() instead of .maybeSingle()
// -- requesting the updated row(s) back (Prefer: return=representation) is
// what lets saveArchiveStreamAccumulatorSnapshot confirm exactly one row
// was actually affected, rather than assuming success from a null-data,
// zero-rows-matched response the way a bare .upsert() would.
export interface ArchiveStreamCheckpointUpdateQueryBuilder {
  eq(column: string, value: string): ArchiveStreamCheckpointUpdateQueryBuilder;
  select(): PromiseLike<SupabaseQueryResult<ArchiveStreamCheckpointRow[]>>;
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
      "archive_dataset_id, last_processed_id, readings_processed_count, accumulator_snapshot_last_processed_id, accumulator_state",
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
    accumulatorState: data.accumulator_state,
  };
}

// Cheap: updates ONLY the stream's own position. Deliberately does NOT
// include accumulator_snapshot_last_processed_id/accumulator_state in the
// upsert payload, so PostgREST's ON CONFLICT DO UPDATE only touches (and
// the client only ever transmits) these two small columns -- whatever
// accumulator snapshot already exists on this row is left completely
// untouched, which is what keeps this cheap even after a multi-megabyte
// snapshot has been written to the same row (real per-chunk cost target:
// the ~102ms/write this project measured before accumulator_state existed
// at all). Called after every chunk, unconditionally.
export async function saveArchiveStreamPosition(
  client: ArchiveStreamCheckpointSupabaseClient,
  position: { archiveDatasetId: string; lastProcessedId: string; readingsProcessedCount: number },
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

// Expensive: writes accumulator_state and the :id cursor it reflects
// (accumulator_snapshot_last_processed_id) together, in one write. These
// two specifically must never drift apart from EACH OTHER -- that pairing
// is what "the accumulator exactly as of this :id position" means, and
// losing it would reintroduce the original double-counting/undercounting
// risk this design exists to fix, just between these two fields instead of
// against last_processed_id.
//
// A genuine UPDATE, not an upsert -- live-confirmed as a real, would-have-
// broken-every-production-run bug: an .upsert() with onConflict targeting
// archive_dataset_id's UNIQUE constraint, for a payload that omits
// last_processed_id (a NOT NULL column with no default), reproducibly
// failed with a "null value in column last_processed_id violates not-null
// constraint" error EVEN AGAINST AN ALREADY-EXISTING ROW -- confirmed via
// direct, isolated testing against a disposable row (not this project's
// real data) that Postgres was genuinely attempting a fresh INSERT (a new,
// randomly-generated id in the failing-row detail) rather than recognizing
// the conflict, while a plain UPDATE against that identical row succeeded
// immediately. Root mechanism unconfirmed (a PostgREST/postgrest-js
// upsert-with-partial-payload interaction, not this table's schema -- the
// UNIQUE constraint itself is real and correctly declared), but a genuine
// UPDATE sidesteps it entirely and is also the more semantically correct
// operation here regardless: this function is only ever called immediately
// after saveArchiveStreamPosition has run for the same chunk (see
// streamArchiveWithResume), or against a checkpoint row
// fetchArchiveStreamCheckpoint has just confirmed exists (gap-replay's
// catch-up write) -- there is no legitimate case where this row doesn't
// already exist, unlike saveArchiveStreamPosition, which genuinely does
// need upsert's create-or-update behavior for a truly fresh run's first
// chunk.
//
// The .select() after .eq() requests the updated row back (Prefer:
// return=representation) specifically so the row count can be checked --
// an UPDATE matching zero rows is not an error PostgREST reports on its
// own (it just quietly returns an empty result), and silently doing
// nothing here would be exactly the kind of quiet, hard-to-detect failure
// this whole checkpoint design exists to avoid.
//
// Marks the one kind of failure known to be structural, not transient: the
// row-count check above finding zero matching rows. Retrying that would
// never succeed -- there's no row to update, and no amount of waiting
// creates one -- so it's classified separately from every other failure
// this write can hit, which defaults to retryable (see
// saveArchiveStreamAccumulatorSnapshot's own comment for why a default-
// retryable-except-one-known-case design, not per-error-type handling, is
// what this project already learned to do here).
class SnapshotRowNotFoundError extends Error {}

async function saveArchiveStreamAccumulatorSnapshotOnce(
  client: ArchiveStreamCheckpointSupabaseClient,
  snapshot: { archiveDatasetId: string; accumulatorSnapshotLastProcessedId: string; accumulatorState: AccumulatorSnapshot },
): Promise<void> {
  const { data, error } = await client
    .from("archive_stream_checkpoint")
    .update({
      accumulator_snapshot_last_processed_id: snapshot.accumulatorSnapshotLastProcessedId,
      accumulator_state: snapshot.accumulatorState,
    })
    .eq("archive_dataset_id", snapshot.archiveDatasetId)
    .select();

  if (error !== null) {
    throw new Error(
      `saveArchiveStreamAccumulatorSnapshot: writing accumulator snapshot for archive_dataset_id=${snapshot.archiveDatasetId} failed: ${error.message}`,
    );
  }

  if (data === null || data.length !== 1) {
    throw new SnapshotRowNotFoundError(
      `saveArchiveStreamAccumulatorSnapshot: expected exactly one existing archive_stream_checkpoint row for archive_dataset_id=${snapshot.archiveDatasetId}, but the update affected ${data?.length ?? 0} row(s) -- this function is only ever called after saveArchiveStreamPosition has already created the row for this chunk, so a missing row signals a real bug upstream, not a normal case to handle gracefully`,
    );
  }
}

// One initial attempt plus up to 3 retries, exponential backoff (1s, 2s,
// 4s) -- same shape as fetchSocrataRecords.ts's fetchPage retry logic.
// Live-confirmed this write's failures are transient and load-dependent,
// not a fixed function of payload size: direct testing found the IDENTICAL
// ~94,064-bucket payload fail at 18.65s in one attempt and succeed at
// 39.78s in the very next, with no code or data difference between them.
// Lowering DEFAULT_ACCUMULATOR_SNAPSHOT_INTERVAL_CHUNKS was considered and
// rejected as a fix for this: every snapshot write serializes the FULL
// accumulator state (onChunk always returns Object.fromEntries(accumulators),
// never a delta -- see backfill-occupancy-stats.ts's main()), and that
// state's size is dominated by the rolling window's one-time initial fold
// (~100K+ buckets, live-verified), not by how many chunks have elapsed
// since the last snapshot -- so a smaller interval doesn't shrink any
// individual write, it only attempts the same already-risky size more
// often. Retrying is the fix that actually matches the evidence.
export const MAX_SNAPSHOT_WRITE_ATTEMPTS = 4;
const SNAPSHOT_WRITE_RETRY_BASE_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function saveArchiveStreamAccumulatorSnapshot(
  client: ArchiveStreamCheckpointSupabaseClient,
  snapshot: { archiveDatasetId: string; accumulatorSnapshotLastProcessedId: string; accumulatorState: AccumulatorSnapshot },
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_SNAPSHOT_WRITE_ATTEMPTS; attempt++) {
    try {
      await saveArchiveStreamAccumulatorSnapshotOnce(client, snapshot);
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
// state doesn't lose any information a caller needs.
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

async function fetchArchivePage(
  archiveDatasetId: string,
  cursorId: string | null,
  chunkSize: number,
  upperBoundId: string | null = null,
): Promise<SocrataRecord[]> {
  const url = buildArchivePageUrl(archiveDatasetId, cursorId, chunkSize, upperBoundId);
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
// expensive accumulator-state snapshot only every snapshotIntervalChunks
// chunks. A resume reconciles the resulting gap between the two by
// re-fetching and re-folding exactly that bounded range before continuing
// normal streaming -- never the whole dataset, and never double-counting,
// since the gap is fetched and folded exactly once into the restored
// snapshot.
export async function streamArchiveWithResume(
  checkpointClient: ArchiveStreamCheckpointSupabaseClient,
  options: StreamArchiveOptions,
): Promise<void> {
  const chunkSize = options.chunkSize ?? DEFAULT_STREAM_CHUNK_SIZE;
  const snapshotIntervalChunks = options.snapshotIntervalChunks ?? DEFAULT_ACCUMULATOR_SNAPSHOT_INTERVAL_CHUNKS;

  const existingCheckpoint = await fetchArchiveStreamCheckpoint(checkpointClient, options.archiveDatasetId);
  let cursorId: string | null = existingCheckpoint?.lastProcessedId ?? null;
  let readingsProcessedCount = existingCheckpoint?.readingsProcessedCount ?? 0;
  let accumulatorState: AccumulatorSnapshot = existingCheckpoint?.accumulatorState ?? {};

  if (existingCheckpoint !== null) {
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
      // state via the normal onChunk path.
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
      await saveArchiveStreamAccumulatorSnapshot(checkpointClient, {
        archiveDatasetId: options.archiveDatasetId,
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
      archiveDatasetId: options.archiveDatasetId,
      lastProcessedId: cursorId,
      readingsProcessedCount,
    });

    if (totalChunksProcessed % ARCHIVE_STREAM_PROGRESS_LOG_INTERVAL_CHUNKS === 0) {
      console.log(`Archive streaming progress: ${totalChunksProcessed} chunks processed this run, ${readingsProcessedCount} total readings processed.`);
    }

    if (chunksSinceLastSnapshot >= snapshotIntervalChunks) {
      // Expensive, only every snapshotIntervalChunks chunks. Written AFTER
      // the position update above (never before): that ordering guarantees
      // accumulator_snapshot_last_processed_id can only ever be behind or
      // equal to last_processed_id, never ahead of it -- if it could get
      // ahead (e.g. this write landed but the position write above then
      // failed), a resume would under-fetch and silently skip readings the
      // snapshot already counted, rather than the safe, bounded-replay gap
      // this design is built to handle.
      await saveArchiveStreamAccumulatorSnapshot(checkpointClient, {
        archiveDatasetId: options.archiveDatasetId,
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

  await clearArchiveStreamCheckpoint(checkpointClient, options.archiveDatasetId);
}
