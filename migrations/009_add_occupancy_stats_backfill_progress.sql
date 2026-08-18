-- Adds occupancy_stats_backfill_progress to an existing database (see
-- schema.sql for the full schema). Safe to run on its own against the live
-- Supabase project.

-- Tracks the occupancy_stats batch aggregation job's progress, one row per
-- (iso_day, hour) bucket combination -- the same 91-bucket granularity the
-- batch job queries Socrata at (see CLAUDE.md's Architecture section). Lets
-- the job resume from where it left off after an interruption instead of
-- needing a full restart: on startup it can skip any bucket already marked
-- 'complete' and retry any left 'in_progress' or 'failed' from a previous
-- run.
CREATE TABLE occupancy_stats_backfill_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ISO 8601 day-of-week numbering (1=Monday..7=Sunday), matching
  -- occupancy_stats.day_of_week and blockfaces.operating_days.
  iso_day smallint NOT NULL CHECK (iso_day BETWEEN 1 AND 7),
  hour smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),

  status text NOT NULL CHECK (status IN ('pending', 'in_progress', 'complete', 'failed')),

  started_at timestamptz,
  completed_at timestamptz,

  -- Set only when status = 'failed', so a re-run (or a human) can see why a
  -- bucket didn't complete without digging through logs.
  error_message text,

  -- One row per (iso_day, hour) bucket combination; re-running the job
  -- updates the existing row's status instead of accumulating duplicates.
  UNIQUE (iso_day, hour)
);

COMMENT ON TABLE occupancy_stats_backfill_progress IS
  'Tracks the occupancy_stats batch aggregation job''s progress per (iso_day, hour) bucket, so an interrupted run can resume instead of restarting from scratch. Purely internal/operational bookkeeping for the batch job itself, not part of the public-facing schema. Deliberately has RLS enabled with NO policies at all (not even public read), unlike every other table in this schema: it holds no parking data of any public interest, only this project''s own job-scheduling state, and a public read policy here would serve no purpose while needlessly exposing internal operational details (job timing, failure messages) to anyone with API access.';
COMMENT ON COLUMN occupancy_stats_backfill_progress.status IS
  'pending (not yet attempted), in_progress (currently being processed -- also the state a bucket is left in if the job crashes mid-write), complete, or failed.';
COMMENT ON COLUMN occupancy_stats_backfill_progress.error_message IS
  'Set only when status = ''failed'', so a re-run or a human can see why without digging through logs.';

ALTER TABLE occupancy_stats_backfill_progress ENABLE ROW LEVEL SECURITY;
-- No CREATE POLICY statements, intentionally: unlike every other table in
-- this schema (which get public-read policies added manually via the
-- Supabase dashboard, outside these tracked files), this table must never
-- be publicly readable. With RLS enabled and zero policies, Postgres denies
-- all access by default to any role without BYPASSRLS -- only the
-- service-role key (used server-side by the batch job) can read or write
-- it.
