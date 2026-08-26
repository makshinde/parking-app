-- Replaces archive_stream_checkpoint.accumulator_state (a single JSONB blob
-- holding the entire per-bucket accumulator state) with one row per bucket.
-- See migrations/016 (applied alongside this one) for removing that old
-- column and its supporting RPC function.
--
-- Real, live, controlled testing (streamArchiveWithResume.ts's git history)
-- found the old single-blob write hitting a hard, SIZE-INDEPENDENT ~20-
-- second failure ceiling at realistic bucket counts (~110,000+ buckets):
-- payloads ranging from 12.4MB to 16.9MB (a 36% size spread) all failed
-- within about 1.4 seconds of each other. That clustering is inconsistent
-- with a genuine Postgres statement_timeout (even a SET LOCAL-scoped 60s,
-- tried and live-verified NOT to fix this -- migrations/014) and points to
-- an external, fixed-duration cutoff upstream of Postgres itself (most
-- plausibly Supabase's connection pooler or API gateway) that raising
-- Postgres's own statement_timeout cannot reach.
--
-- This table structurally avoids that failure mode regardless of its exact
-- cause: writes become many small batched upserts (see
-- upsertAccumulatorBuckets in streamArchiveWithResume.ts, reusing the
-- already-proven ~500-row batch size from upsertOccupancyStatsBatch), never
-- one large write carrying the full accumulator state at once.
CREATE TABLE archive_stream_accumulator_buckets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Plain text, NOT a foreign key to archive_stream_checkpoint.archive_dataset_id.
  -- clearArchiveStreamCheckpoint deletes the checkpoint row on successful
  -- completion -- an FK with ON DELETE CASCADE here would wipe these bucket
  -- rows at exactly the moment a crash-recovery scenario might still need
  -- them (occupancy_stats is written from the in-memory accumulator Map
  -- right after streaming finishes, in the same process -- if that write
  -- step crashes before completing, these rows are the only durable copy
  -- left).
  archive_dataset_id text NOT NULL,

  blockface_id uuid NOT NULL REFERENCES blockfaces(id) ON DELETE CASCADE,

  -- ISO 8601 day-of-week numbering (1=Monday..7=Sunday), matching
  -- occupancy_stats.day_of_week and every other iso_day column in this
  -- schema.
  iso_day smallint NOT NULL CHECK (iso_day BETWEEN 1 AND 7),
  hour smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),

  -- WeightedStatsAccumulator's own fields (incrementalWeightedStats.ts),
  -- unchanged shape from the old JSONB blob, just relational now. double
  -- precision, not real: unlike occupancy_stats.mean_occupancy (a real,
  -- written once as a terminal value), these rows are read back into the
  -- in-memory accumulator and continue being folded via addReading() across
  -- further snapshots -- real's precision loss would compound on every
  -- round trip over a multi-hour run; double precision matches JS's own
  -- number precision and avoids that.
  count integer NOT NULL,
  total_weight double precision NOT NULL,
  mean double precision NOT NULL,
  sum_squared_diff double precision NOT NULL,

  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One row per (archive, blockface, day, hour) bucket; re-snapshotting
  -- (streamArchiveWithResume writes the ENTIRE current accumulator state on
  -- every snapshot, not a delta) upserts each bucket's row in place instead
  -- of duplicating it. Also the index a resume's paginated
  -- WHERE archive_dataset_id = ... read-back (fetchAccumulatorBuckets)
  -- uses -- no separate index needed for that.
  UNIQUE (archive_dataset_id, blockface_id, iso_day, hour)
);

COMMENT ON TABLE archive_stream_accumulator_buckets IS
  'One row per (archive_dataset_id, blockface_id, iso_day, hour) bucket, holding that bucket''s incremental accumulator state (see incrementalWeightedStats.ts) as of the archive stream''s last accumulator snapshot. Replaces archive_stream_checkpoint.accumulator_state (a single JSONB blob written as one large, timeout-prone write) with many small batched upserts -- see streamArchiveWithResume.ts for the full reasoning. Purely internal/operational bookkeeping for the batch job itself, not part of the public-facing schema.';
COMMENT ON COLUMN archive_stream_accumulator_buckets.archive_dataset_id IS
  'Socrata dataset id for the yearly archive this bucket belongs to (e.g. "7c2e-uany" for 2025). Not a foreign key -- see this table''s own comment for why not.';
COMMENT ON COLUMN archive_stream_accumulator_buckets.count IS
  'WeightedStatsAccumulator.count: number of readings folded into this bucket so far.';
COMMENT ON COLUMN archive_stream_accumulator_buckets.total_weight IS
  'WeightedStatsAccumulator.totalWeight: sum of recency weights folded into this bucket so far.';
COMMENT ON COLUMN archive_stream_accumulator_buckets.mean IS
  'WeightedStatsAccumulator.mean: running weighted mean occupancy ratio for this bucket.';
COMMENT ON COLUMN archive_stream_accumulator_buckets.sum_squared_diff IS
  'WeightedStatsAccumulator.sumSquaredDiff: running variance accumulator term (West''s algorithm) for this bucket.';

-- Postgres does not automatically index foreign key columns; without this,
-- looking up a blockface's accumulator buckets (or cascading its delete)
-- would force a sequential scan of this table as it grows.
CREATE INDEX idx_archive_stream_accumulator_buckets_blockface_id ON archive_stream_accumulator_buckets (blockface_id);

ALTER TABLE archive_stream_accumulator_buckets ENABLE ROW LEVEL SECURITY;
-- No CREATE POLICY statements, intentionally: same reasoning as
-- archive_stream_checkpoint, occupancy_stats_backfill_progress, and
-- occupancy_stats_backfill_failures. With RLS enabled and zero policies,
-- Postgres denies all access by default to any role without BYPASSRLS --
-- only the service-role key (used server-side by the batch job) can read
-- or write it.
