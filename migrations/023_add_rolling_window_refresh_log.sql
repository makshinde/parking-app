-- Tracks each rolling-window refresh's REAL, observed data coverage
-- (min/max occupancydatetime, row count) over time, specifically to
-- detect a real, live-confirmed failure mode: rke9-rsvs (Seattle's
-- current-year Paid Parking Occupancy dataset) is a genuine EVICTING
-- rolling window, not merely an append-only growing one -- live-verified
-- directly (2026-09-12): its own earliest available row moved forward
-- ~51 minutes over just ~62 real minutes between two checks, with real
-- row count dropping in that same short window even while its latest edge
-- stayed frozen (a separate, real ~10-day upstream ingestion stall at the
-- time).
--
-- Without tracking this, a reading that both APPEARS in the window and is
-- EVICTED from it entirely between two refresh runs would be permanently
-- lost -- captured by neither the closed-year archive (wrong year) nor
-- any surviving copy of the rolling window itself (evicted) -- silently,
-- with no error anywhere. This table makes that failure mode detectable:
-- each refresh records its own real observed [earliest_covered,
-- latest_covered] window, and detectCoverageGap
-- (rollingWindowRefreshLog.ts) compares each new run's earliest_covered
-- against the PREVIOUS run's latest_covered. Since every refresh does a
-- full, unfiltered pull of the entire current window (not an incremental
-- delta), any one run's own [earliest, latest] represents everything that
-- existed in the real source at that moment -- so a real gap between two
-- runs' windows (this run's earliest strictly after the last run's
-- latest) proves something was evicted before either run could capture
-- it.
CREATE TABLE rolling_window_refresh_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The real Socrata dataset id this refresh pulled from (e.g.
  -- "rke9-rsvs") -- text, not a foreign key: this table tracks refreshes
  -- of a live, external, ever-changing Socrata dataset, not anything
  -- owned by this schema.
  archive_dataset_id text NOT NULL,

  checked_at timestamptz NOT NULL DEFAULT now(),

  -- Raw, naive "YYYY-MM-DDTHH:mm:ss[.sss]" strings, exactly as Socrata's
  -- occupancydatetime field itself returns them (Pacific-local, no
  -- timezone marker -- see blockfaceLookup.ts's own live-verified finding
  -- on this) -- deliberately NOT timestamptz, to avoid Postgres silently
  -- assuming a timezone (UTC or session default) these naive strings don't
  -- actually carry. Compared as plain, lexicographically-ordered text in
  -- detectCoverageGap -- valid for this fixed-width, zero-padded format,
  -- and avoids any timezone-resolution complexity for what's fundamentally
  -- just a relative-ordering check between two markers from the same
  -- source convention.
  earliest_covered text NOT NULL,
  latest_covered text NOT NULL,

  row_count bigint NOT NULL,

  gap_detected boolean NOT NULL,
  gap_detail text,

  -- gap_detected and gap_detail must agree: a detected gap always carries
  -- an explanation, and no explanation is ever stored without a detected
  -- gap.
  CHECK (gap_detected = (gap_detail IS NOT NULL))

  -- One row per refresh attempt, not upserted -- this is an append-only
  -- audit log (same reasoning as occupancy_stats_backfill_failures'
  -- retry_count tracking, just for a different real failure mode), so
  -- history is preserved rather than overwritten.
);

CREATE INDEX idx_rolling_window_refresh_log_dataset_checked_at
  ON rolling_window_refresh_log (archive_dataset_id, checked_at DESC);

COMMENT ON TABLE rolling_window_refresh_log IS
  'Append-only audit log of each rolling-window (e.g. rke9-rsvs) refresh''s real observed data coverage, used to detect a real eviction-driven data-loss gap between consecutive refreshes -- see this migration''s own header comment and rollingWindowRefreshLog.ts''s detectCoverageGap for the full reasoning. Purely internal/operational bookkeeping, not part of the public-facing schema.';

ALTER TABLE rolling_window_refresh_log ENABLE ROW LEVEL SECURITY;
-- No CREATE POLICY statements, intentionally: same reasoning as
-- occupancy_stats_backfill_progress/occupancy_stats_backfill_failures. It
-- holds no parking data of any public interest, only this project's own
-- refresh-bookkeeping. With RLS enabled and zero policies, Postgres denies
-- all access by default to any role without BYPASSRLS -- only the
-- service-role key (used server-side by the refresh job) can read or
-- write it.
