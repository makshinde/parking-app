-- Durable run-state for the new scheduled rolling-window refresh pipeline
-- (src/aggregation/scheduled-rebuild.ts), one row per weekly attempt --
-- the same reasoning as occupancy_stats_backfill_progress/
-- archive_stream_checkpoint/rolling_window_refresh_log: a job that can run
-- unattended on a schedule must leave a real, queryable record of where it
-- got to, so a failure mid-run (crash, timeout, a genuinely bad gap/
-- integrity result) is visible and the next run can tell whether it's safe
-- to resume from "promoted, but reconcile/verify didn't finish" rather than
-- blindly re-streaming a fresh staging identity every time.
--
-- step is an ordered checkpoint of how far this run got, not just a status
-- flag: 'streaming_archive' -> 'streaming_rolling_window' -> 'gap_check' ->
-- 'integrity_check' -> 'promoting' -> 'reconciling' -> 'verifying' -> 'done'.
-- Only once step has reached 'promoting' has anything LIVE actually been
-- touched (the rename) -- a failure at any earlier step leaves the real,
-- live identity completely untouched and the next run can simply start
-- over with a fresh staging identity, never trying to resume a half-folded
-- stream from this table.
CREATE TABLE scheduled_rebuild_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,

  -- The real, live accumulator identity this run is refreshing (e.g. the
  -- current resolveYearlyArchiveDatasetId(getPriorYear(now)) value).
  stable_identity text NOT NULL,
  -- This run's own, freshly-generated staging identity -- never reused
  -- across runs, so a resumed/retried run's intermediate state can never be
  -- confused with a different run's.
  staging_identity text NOT NULL,
  -- Set only once promotion actually happens (the prior live identity's
  -- rows get renamed here, not deleted) -- null before that point.
  backup_identity text,

  step text NOT NULL CHECK (step IN (
    'streaming_archive', 'streaming_rolling_window', 'gap_check',
    'integrity_check', 'promoting', 'reconciling', 'verifying', 'done'
  )),
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),

  gap_detected boolean,
  failure_reason text,

  -- A run must be in exactly one of these two shapes: still finishing
  -- (completed_at null, status 'running'), or finished one way or the
  -- other (completed_at set, status 'succeeded'/'failed') -- never a
  -- "completed but still running" row.
  CONSTRAINT scheduled_rebuild_runs_completed_matches_status CHECK (
    (completed_at IS NULL AND status = 'running')
    OR (completed_at IS NOT NULL AND status IN ('succeeded', 'failed'))
  )
);

COMMENT ON TABLE scheduled_rebuild_runs IS
  'One row per weekly scheduled-rebuild attempt (src/aggregation/scheduled-rebuild.ts). Tracks real progress through the promote/reconcile/verify pipeline so a failed or interrupted run can be told apart from a successful one, and so a resumed run knows whether anything live was actually touched.';
COMMENT ON COLUMN scheduled_rebuild_runs.step IS
  'Ordered checkpoint of how far this run got. Only step >= ''promoting'' means the live accumulator identity was actually renamed -- anything earlier means the live identity is untouched and a retry can safely start fresh.';

CREATE INDEX idx_scheduled_rebuild_runs_stable_identity_started_at
  ON scheduled_rebuild_runs (stable_identity, started_at DESC);

-- Same deliberately-zero-policy RLS as this project's other job-bookkeeping
-- tables (occupancy_stats_backfill_progress, archive_stream_checkpoint,
-- rolling_window_refresh_log) -- holds no parking data of public interest,
-- only this project's own job-scheduling state, so only the service-role
-- key (used server-side by the scheduled job) can read or write it.
ALTER TABLE scheduled_rebuild_runs ENABLE ROW LEVEL SECURITY;
