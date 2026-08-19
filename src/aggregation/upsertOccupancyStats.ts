import type { SupabaseQueryResult } from "../importers/upsertBlockface.ts";
import type { BucketStats } from "./decideBucketStats.ts";

// Minimal, table-name-generic client shape, same DI pattern as
// upsertBlockface.ts/upsertOffStreetFacility.ts -- this upsert doesn't need
// anything back from the row it writes (unlike those two, which chain
// .select().single() to get a generated id for a dependent child-table
// insert), so this gets its own smaller interface rather than reusing
// SupabaseTableBuilder's select-shaped one.
export interface OccupancyStatsSupabaseTableBuilder {
  upsert(values: Record<string, unknown>, options: { onConflict: string }): PromiseLike<SupabaseQueryResult>;
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
