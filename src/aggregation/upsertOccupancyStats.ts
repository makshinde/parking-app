import type { SupabaseQueryResult } from "../importers/upsertBlockface.ts";
import type { BucketStats } from "./decideBucketStats.ts";

// Minimal, table-name-generic client shape, same DI pattern as
// upsertBlockface.ts/upsertOffStreetFacility.ts -- this upsert doesn't need
// anything back from the row it writes (unlike those two, which chain
// .select().single() to get a generated id for a dependent child-table
// insert), so this gets its own smaller interface rather than reusing
// SupabaseTableBuilder's select-shaped one.
//
// values accepts either a single row or an array -- the real
// @supabase/supabase-js client's upsert() already supports both (a single
// PostgREST request with multiple VALUES rows for an array), live-verified
// this session at 200 rows/129.8ms and 500 rows/165.7ms in one call versus
// ~88ms/call writing one row at a time, which is what upsertOccupancyStatsBatch
// below uses to cut the sequential-write cost of a full combo (~1,500
// blockfaces) from minutes to a fraction of a second.

// One occupancy_stats row as read back from the database -- the shape
// returned by chaining .select() onto an upsert (Supabase's "return the
// written rows" capability) or by an ordinary .select() read. Deliberately
// mirrors the DB's actual column names (day_of_week/hour_of_day, not
// isoDay/hour), unlike OccupancyStatsWriteRequest, since this is what
// PostgREST actually hands back.
export interface OccupancyStatsRow {
  id: string;
  blockface_id: string;
  day_of_week: number;
  hour_of_day: number;
  mean_occupancy: number;
  std_dev: number;
  sample_count: number;
}

// PromiseLike, not Promise -- see SupabaseQueryResult's own comment
// (upsertBlockface.ts): the real client's query builders are thenable but
// don't declare the full Promise interface, and only .select()/direct
// await are ever used here.
export interface OccupancyStatsUpsertQueryBuilder extends PromiseLike<SupabaseQueryResult> {
  select(columns: string): PromiseLike<SupabaseQueryResult<OccupancyStatsRow[]>>;
}

export interface OccupancyStatsSelectQueryBuilder extends PromiseLike<SupabaseQueryResult<OccupancyStatsRow[]>> {
  in(column: string, values: string[]): PromiseLike<SupabaseQueryResult<OccupancyStatsRow[]>>;
}

export interface OccupancyStatsSupabaseTableBuilder {
  upsert(
    values: Record<string, unknown> | Record<string, unknown>[],
    options: { onConflict: string },
  ): OccupancyStatsUpsertQueryBuilder;
  // Used only by verifyBatchPersisted's independent follow-up read below --
  // upsertOccupancyStats (the single-row path) never calls this.
  select(columns: string): OccupancyStatsSelectQueryBuilder;
}

export interface OccupancyStatsSupabaseClient {
  from(table: string): OccupancyStatsSupabaseTableBuilder;
}

// Used in the thrown error so a failure during a 91-combo batch run is
// traceable to exactly which blockface/day/hour bucket it belongs to.
function describeBucket(blockfaceId: string, isoDay: number, hour: number): string {
  return `blockface_id=${blockfaceId}, day_of_week=${isoDay}, hour_of_day=${hour}`;
}

function buildOccupancyStatsRow(
  blockfaceId: string,
  isoDay: number,
  hour: number,
  stats: BucketStats,
): Record<string, unknown> {
  return {
    blockface_id: blockfaceId,
    day_of_week: isoDay,
    hour_of_day: hour,
    mean_occupancy: stats.mean,
    std_dev: stats.stdDev,
    sample_count: stats.sampleCount,
  };
}

// Writes one blockface/day-of-week/hour bucket's precomputed stats to
// occupancy_stats. Upserted on (blockface_id, day_of_week, hour_of_day) --
// the schema's own UNIQUE constraint (schema.sql) -- so re-running the
// batch job for a bucket that already has a row updates it in place instead
// of duplicating it.
//
// Deliberately NOT given the same post-write verification as
// upsertOccupancyStatsBatch below: live investigation of the batch path's
// silent-failure bug found the single-row path reliable every time it was
// tested directly against real data (see this project's own investigation
// notes), so verifying it too would add cost without (so far) any evidence
// of a matching problem there. Revisit if that assumption is ever
// contradicted.
export async function upsertOccupancyStats(
  supabaseClient: OccupancyStatsSupabaseClient,
  blockfaceId: string,
  isoDay: number,
  hour: number,
  stats: BucketStats,
): Promise<void> {
  const { error } = await supabaseClient
    .from("occupancy_stats")
    .upsert(buildOccupancyStatsRow(blockfaceId, isoDay, hour, stats), {
      onConflict: "blockface_id,day_of_week,hour_of_day",
    });

  if (error !== null) {
    throw new Error(
      `upsertOccupancyStats: occupancy_stats upsert failed for ${describeBucket(blockfaceId, isoDay, hour)}: ${error.message}`,
    );
  }
}

// --- Batched writes ---------------------------------------------------

export interface OccupancyStatsWriteRequest {
  blockfaceId: string;
  isoDay: number;
  hour: number;
  stats: BucketStats;
}

export interface OccupancyStatsWriteFailure {
  blockfaceId: string;
  isoDay: number;
  hour: number;
  stats: BucketStats;
  errorMessage: string;
}

export interface OccupancyStatsBatchResult {
  writtenCount: number;
  failures: OccupancyStatsWriteFailure[];
}

// Chosen from real, measured batch upserts (not a guess): 200 rows in one
// call took 129.8ms (0.65ms/row) and 500 rows took 165.7ms (0.33ms/row),
// both comfortably fast, versus ~88ms/call writing one row at a time (12
// real calls, live-benchmarked). 500 keeps each request's payload modest
// while still cutting round trips for a full combo (~1,500 blockfaces)
// from ~1,500 down to ~3.
const BATCH_CHUNK_SIZE = 500;

function chunkRequests(requests: OccupancyStatsWriteRequest[], size: number): OccupancyStatsWriteRequest[][] {
  const chunks: OccupancyStatsWriteRequest[][] = [];
  for (let i = 0; i < requests.length; i += size) {
    chunks.push(requests.slice(i, i + size));
  }
  return chunks;
}

function requestKey(request: { blockfaceId: string; isoDay: number; hour: number }): string {
  return `${request.blockfaceId}:${request.isoDay}:${request.hour}`;
}

function rowKey(row: OccupancyStatsRow): string {
  return `${row.blockface_id}:${row.day_of_week}:${row.hour_of_day}`;
}

// --- Post-batch write verification ---------------------------------------
//
// A real, live-confirmed bug: a batched upsert can report success (error
// === null) while NOT actually persisting for a large, seemingly variable
// fraction of its rows. Discovered by comparing occupancy_stats directly
// against archive_stream_accumulator_buckets and finding two-thirds of the
// table silently holding stale, pre-existing values despite every recent
// run's own log claiming a full, zero-failure write -- and confirmed not to
// be a per-bucket problem (a small, closely-watched --max-chunks=1 run's
// write phase, using the exact same code, correctly wrote several
// previously-stale buckets moments later). This went completely undetected
// by the existing error-handling/retry infrastructure
// (occupancy_stats_backfill_failures had zero entries throughout) because
// the failure never surfaces as a client-visible error at all.
//
// Two independent checks, not one:
//  1. Does the upsert's OWN "return the written rows" representation
//     (Supabase's .select() chained onto the same upsert request) even
//     claim to have written everything sent, with the right values?
//  2. A genuinely SEPARATE follow-up read (a brand new request, not just
//     the same response) -- a same-request "success" is not, by itself,
//     proof of durable persistence; resolving exactly that ambiguity is
//     the whole reason this check exists.
const VERIFICATION_SUB_CHUNK_SIZE = 100;

// mean_occupancy/std_dev are `real` (float4) columns -- a round trip
// through Postgres can introduce tiny precision differences from the JS
// number (float64) that was sent, which is not itself evidence of a silent
// write failure and would otherwise cause false-positive mismatches on
// every single batch.
const FLOAT_TOLERANCE = 1e-4;

function floatsMatch(a: number, b: number): boolean {
  return Math.abs(a - b) < FLOAT_TOLERANCE;
}

function rowMatchesRequest(row: OccupancyStatsRow, request: OccupancyStatsWriteRequest): boolean {
  return (
    row.blockface_id === request.blockfaceId &&
    row.day_of_week === request.isoDay &&
    row.hour_of_day === request.hour &&
    floatsMatch(row.mean_occupancy, request.stats.mean) &&
    floatsMatch(row.std_dev, request.stats.stdDev) &&
    row.sample_count === request.stats.sampleCount
  );
}

function describeStats(stats: BucketStats): string {
  return `mean=${stats.mean}, stdDev=${stats.stdDev}, sampleCount=${stats.sampleCount}`;
}

function describeRowStats(row: OccupancyStatsRow): string {
  return `mean=${row.mean_occupancy}, stdDev=${row.std_dev}, sampleCount=${row.sample_count}`;
}

export interface OccupancyStatsVerificationMismatch {
  blockfaceId: string;
  isoDay: number;
  hour: number;
  reason: string;
}

// Sub-chunked at VERIFICATION_SUB_CHUNK_SIZE for the follow-up read to stay
// comfortably within any URL-length limit on a large .in() filter (a
// 500-item filter of full UUIDs was never actually tested against that
// limit -- this sidesteps the question rather than assuming either answer).
export async function verifyBatchPersisted(
  supabaseClient: OccupancyStatsSupabaseClient,
  batch: OccupancyStatsWriteRequest[],
  upsertReturnedRows: OccupancyStatsRow[],
): Promise<OccupancyStatsVerificationMismatch[]> {
  const mismatches: OccupancyStatsVerificationMismatch[] = [];
  const requestsByKey = new Map(batch.map((request) => [requestKey(request), request]));

  // Check 1: the upsert's own same-request returned representation.
  const returnedKeys = new Set(upsertReturnedRows.map(rowKey));
  for (const request of batch) {
    if (!returnedKeys.has(requestKey(request))) {
      mismatches.push({
        blockfaceId: request.blockfaceId,
        isoDay: request.isoDay,
        hour: request.hour,
        reason: "missing from the upsert's own returned representation (.select() on the same request)",
      });
    }
  }
  for (const row of upsertReturnedRows) {
    const request = requestsByKey.get(rowKey(row));
    if (request !== undefined && !rowMatchesRequest(row, request)) {
      mismatches.push({
        blockfaceId: request.blockfaceId,
        isoDay: request.isoDay,
        hour: request.hour,
        reason: `value mismatch in the upsert's own returned representation: sent ${describeStats(request.stats)}; got ${describeRowStats(row)}`,
      });
    }
  }

  // Check 2: a genuinely independent follow-up read, keyed by the id each
  // row was returned with.
  const idsToRecheck = upsertReturnedRows.map((row) => row.id);
  const recheckedById = new Map<string, OccupancyStatsRow>();
  for (let i = 0; i < idsToRecheck.length; i += VERIFICATION_SUB_CHUNK_SIZE) {
    const idChunk = idsToRecheck.slice(i, i + VERIFICATION_SUB_CHUNK_SIZE);
    const { data, error } = await supabaseClient.from("occupancy_stats").select("id, blockface_id, day_of_week, hour_of_day, mean_occupancy, std_dev, sample_count").in("id", idChunk);

    if (error !== null) {
      // The verification read itself failing is worth surfacing loudly too
      // -- this sub-chunk's persistence could not be confirmed either way,
      // which must not be silently treated as "fine".
      for (const id of idChunk) {
        const row = upsertReturnedRows.find((candidate) => candidate.id === id);
        const request = row === undefined ? undefined : requestsByKey.get(rowKey(row));
        if (request === undefined) continue;
        mismatches.push({
          blockfaceId: request.blockfaceId,
          isoDay: request.isoDay,
          hour: request.hour,
          reason: `independent verification read itself failed, persistence could not be confirmed: ${error.message}`,
        });
      }
      continue;
    }

    for (const row of data ?? []) {
      recheckedById.set(row.id, row);
    }
  }

  for (const row of upsertReturnedRows) {
    const request = requestsByKey.get(rowKey(row));
    if (request === undefined) continue;
    const actual = recheckedById.get(row.id);
    if (actual === undefined) {
      mismatches.push({
        blockfaceId: request.blockfaceId,
        isoDay: request.isoDay,
        hour: request.hour,
        reason: "present in the upsert's own returned representation but NOT found on an independent follow-up read -- the exact silent-failure signature this check exists to catch",
      });
    } else if (!rowMatchesRequest(actual, request)) {
      mismatches.push({
        blockfaceId: request.blockfaceId,
        isoDay: request.isoDay,
        hour: request.hour,
        reason: `value mismatch on independent follow-up read: sent ${describeStats(request.stats)}; got ${describeRowStats(actual)}`,
      });
    }
  }

  return mismatches;
}

function logMismatchesLoudly(mismatches: OccupancyStatsVerificationMismatch[]): void {
  for (const mismatch of mismatches) {
    console.error(
      `upsertOccupancyStatsBatch: SILENT WRITE FAILURE DETECTED for ${describeBucket(mismatch.blockfaceId, mismatch.isoDay, mismatch.hour)}: ${mismatch.reason}`,
    );
  }
}

async function fallbackRowByRow(
  supabaseClient: OccupancyStatsSupabaseClient,
  requests: OccupancyStatsWriteRequest[],
): Promise<{ writtenCount: number; failures: OccupancyStatsWriteFailure[] }> {
  let writtenCount = 0;
  const failures: OccupancyStatsWriteFailure[] = [];

  for (const request of requests) {
    try {
      await upsertOccupancyStats(supabaseClient, request.blockfaceId, request.isoDay, request.hour, request.stats);
      writtenCount += 1;
    } catch (rowError) {
      failures.push({
        blockfaceId: request.blockfaceId,
        isoDay: request.isoDay,
        hour: request.hour,
        stats: request.stats,
        errorMessage: rowError instanceof Error ? rowError.message : String(rowError),
      });
    }
  }

  return { writtenCount, failures };
}

// Writes many blockface/day/hour bucket rows in a small number of batched
// upsert calls instead of one call per row. A batch upsert is one PostgREST
// request containing multiple VALUES rows in a single SQL statement, which
// live-verified fails atomically: one row violating a constraint (e.g. a
// malformed mean_occupancy) aborts the *entire* batch, none of the rows in
// it get written, even the otherwise-valid ones. A chunk whose upsert call
// itself errors is retried one row at a time (fallbackRowByRow), which both
// isolates exactly which row(s) actually failed and preserves the
// pre-batching behavior of attributing each real failure to exactly the
// blockface that caused it.
//
// A chunk whose upsert call reports SUCCESS is not trusted on that basis
// alone -- verifyBatchPersisted independently confirms it actually landed
// before counting it as written (see that function's own comment for why).
// Any row verifyBatchPersisted flags is retried the same way an outright
// error would be (fallbackRowByRow) rather than immediately given up on --
// the single-row path has been reliable every time it's been tested
// directly, so retrying through it gives the run a real chance to
// self-heal instead of just recording the failure. The mismatch is still
// logged loudly regardless of whether the retry recovers it: silently
// succeeding on retry would hide that the batch path failed here at all.
export async function upsertOccupancyStatsBatch(
  supabaseClient: OccupancyStatsSupabaseClient,
  requests: OccupancyStatsWriteRequest[],
): Promise<OccupancyStatsBatchResult> {
  let writtenCount = 0;
  const failures: OccupancyStatsWriteFailure[] = [];

  for (const batch of chunkRequests(requests, BATCH_CHUNK_SIZE)) {
    const { data, error } = await supabaseClient
      .from("occupancy_stats")
      .upsert(
        batch.map((request) => buildOccupancyStatsRow(request.blockfaceId, request.isoDay, request.hour, request.stats)),
        { onConflict: "blockface_id,day_of_week,hour_of_day" },
      )
      .select("id, blockface_id, day_of_week, hour_of_day, mean_occupancy, std_dev, sample_count");

    if (error !== null) {
      const fallback = await fallbackRowByRow(supabaseClient, batch);
      writtenCount += fallback.writtenCount;
      failures.push(...fallback.failures);
      continue;
    }

    const returnedRows = data ?? [];
    const mismatches = await verifyBatchPersisted(supabaseClient, batch, returnedRows);

    if (mismatches.length === 0) {
      writtenCount += batch.length;
      continue;
    }

    logMismatchesLoudly(mismatches);
    const mismatchedKeys = new Set(mismatches.map((mismatch) => requestKey(mismatch)));
    const cleanRequests = batch.filter((request) => !mismatchedKeys.has(requestKey(request)));
    const mismatchedRequests = batch.filter((request) => mismatchedKeys.has(requestKey(request)));

    writtenCount += cleanRequests.length;
    const retryResult = await fallbackRowByRow(supabaseClient, mismatchedRequests);
    writtenCount += retryResult.writtenCount;
    failures.push(...retryResult.failures);
  }

  return { writtenCount, failures };
}
