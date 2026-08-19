-- Adds occupancy_stats_backfill_failures to an existing database (see
-- schema.sql for the full schema). Safe to run on its own against the live
-- Supabase project.

-- Durably logs each bucket that fails during the occupancy_stats batch
-- aggregation job's main 91-combo run, so a final retry pass afterward has
-- a real record of exactly what failed and why, instead of relying on logs
-- from a run that may no longer be available (see CLAUDE.md's Architecture
-- section for how this fits into the batch job as a whole). A successful
-- retry deletes its row; a retry that fails again updates error_message
-- and increments retry_count in place, rather than accumulating duplicate
-- rows for the same bucket.
CREATE TABLE occupancy_stats_backfill_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  blockface_id uuid NOT NULL REFERENCES blockfaces(id) ON DELETE CASCADE,

  -- ISO 8601 day-of-week numbering (1=Monday..7=Sunday), matching
  -- occupancy_stats.day_of_week and occupancy_stats_backfill_progress.iso_day.
  iso_day smallint NOT NULL CHECK (iso_day BETWEEN 1 AND 7),
  hour smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),

  -- The computed stats that failed to be written, when the failure happened
  -- after aggregation completed (e.g. the occupancy_stats upsert itself
  -- failed). Left null when the failure happened earlier, before any stats
  -- were computed for this bucket (e.g. the Socrata fetch itself failed) --
  -- there's nothing meaningful to store in that case.
  mean_occupancy real,
  std_dev real,
  sample_count integer,

  -- Always set: every row in this table exists because something failed,
  -- so there's always a reason to record, unlike
  -- occupancy_stats_backfill_progress.error_message which is only set
  -- conditionally on that table's status.
  error_message text NOT NULL,

  -- How many times the retry pass has attempted this bucket again after
  -- its initial failure during the main run.
  retry_count integer NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),

  -- One row per (blockface_id, iso_day, hour) bucket combination; a retry
  -- that fails again updates the existing row instead of accumulating
  -- duplicates for the same bucket.
  UNIQUE (blockface_id, iso_day, hour)
);

COMMENT ON TABLE occupancy_stats_backfill_failures IS
  'Durably logs each blockface/day/hour bucket that fails during the occupancy_stats batch aggregation job''s main 91-combo run, so a final retry pass afterward has a real record of what failed and why (see CLAUDE.md''s Architecture section). A successful retry deletes its row; a retry that fails again updates error_message and increments retry_count in place. Purely internal/operational bookkeeping for the batch job itself, not part of the public-facing schema. Deliberately has RLS enabled with NO policies at all (not even public read), same reasoning as occupancy_stats_backfill_progress: it holds no parking data of any public interest, only this project''s own job-failure bookkeeping.';
COMMENT ON COLUMN occupancy_stats_backfill_failures.mean_occupancy IS
  'The computed mean occupancy that failed to be written, if aggregation completed before the failure. Null if the failure happened earlier (e.g. the Socrata fetch itself failed), before any stats existed for this bucket.';
COMMENT ON COLUMN occupancy_stats_backfill_failures.retry_count IS
  'Number of times the retry pass has re-attempted this bucket after its initial failure during the main run.';

-- Postgres does not automatically index foreign key columns; without this,
-- looking up a blockface's failed buckets would force a sequential scan of
-- occupancy_stats_backfill_failures as it grows.
CREATE INDEX idx_occupancy_stats_backfill_failures_blockface_id ON occupancy_stats_backfill_failures (blockface_id);

ALTER TABLE occupancy_stats_backfill_failures ENABLE ROW LEVEL SECURITY;
-- No CREATE POLICY statements, intentionally: same reasoning as
-- occupancy_stats_backfill_progress. With RLS enabled and zero policies,
-- Postgres denies all access by default to any role without BYPASSRLS --
-- only the service-role key (used server-side by the batch job) can read
-- or write it.
