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
export interface OccupancyStatsSupabaseTableBuilder {
  upsert(
    values: Record<string, unknown> | Record<string, unknown>[],
    options: { onConflict: string },
  ): PromiseLike<SupabaseQueryResult>;
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

// Writes many blockface/day/hour bucket rows in a small number of batched
// upsert calls instead of one call per row. A batch upsert is one PostgREST
// request containing multiple VALUES rows in a single SQL statement, which
// live-verified fails atomically: one row violating a constraint (e.g. a
// malformed mean_occupancy) aborts the *entire* batch, none of the rows in
// it get written, even the otherwise-valid ones. So a chunk that fails is
// retried one row at a time (falling back to upsertOccupancyStats), which
// both isolates exactly which row(s) actually failed and preserves the
// pre-batching behavior of attributing each real failure to exactly the
// blockface that caused it, rather than wrongly failing every blockface in
// a chunk alongside one bad one.
export async function upsertOccupancyStatsBatch(
  supabaseClient: OccupancyStatsSupabaseClient,
  requests: OccupancyStatsWriteRequest[],
): Promise<OccupancyStatsBatchResult> {
  let writtenCount = 0;
  const failures: OccupancyStatsWriteFailure[] = [];

  for (const batch of chunkRequests(requests, BATCH_CHUNK_SIZE)) {
    const { error } = await supabaseClient.from("occupancy_stats").upsert(
      batch.map((request) => buildOccupancyStatsRow(request.blockfaceId, request.isoDay, request.hour, request.stats)),
      { onConflict: "blockface_id,day_of_week,hour_of_day" },
    );

    if (error === null) {
      writtenCount += batch.length;
      continue;
    }

    for (const request of batch) {
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
  }

  return { writtenCount, failures };
}
