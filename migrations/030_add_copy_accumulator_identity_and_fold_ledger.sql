-- Two additive pieces for the xkas-9n43 catch-up (staging only -- neither
-- of these, on their own, touches any live-tagged row):
--
-- 1. copy_accumulator_identity: duplicates one identity's real rows under
--    a new identity name, in archive_stream_accumulator_buckets only (the
--    catch-up never needs a checkpoint row for the copy -- it's seeding a
--    staging identity from already-folded data, not resuming a Socrata
--    stream). A plain INSERT...SELECT, safe/reversible (the source rows
--    are never touched; the new identity's rows can simply be deleted to
--    undo it).
--
-- 2. rolling_window_fold_ledger: one row per real calendar day this
--    project has ever decided about for a given logical rolling window --
--    'folded' (real data folded in), 'permanent_gap' (confirmed no source
--    covers this day at all -- e.g. the real Sep 2-7 2026 gap between
--    rke9-rsvs and xkas-9n43), or 'low_volume' (folded, but its real row
--    count was unusually low, flagged for visibility, not retried).
--    logical_window is deliberately independent of source_dataset_id --
--    the same logical rolling window (the "current 30-day window") can be
--    backed by different real dataset ids over time (rke9-rsvs, then
--    xkas-9n43, and whatever comes after that, given the now-confirmed
--    real cutover pattern), and the ledger should survive that.

CREATE FUNCTION copy_accumulator_identity(
  p_source_identity text,
  p_destination_identity text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_source_identity = p_destination_identity THEN
    RAISE EXCEPTION 'copy_accumulator_identity: source and destination must differ, got "%"', p_source_identity;
  END IF;

  INSERT INTO archive_stream_accumulator_buckets (archive_dataset_id, blockface_id, iso_day, hour, count, total_weight, mean, sum_squared_diff)
  SELECT p_destination_identity, blockface_id, iso_day, hour, count, total_weight, mean, sum_squared_diff
  FROM archive_stream_accumulator_buckets
  WHERE archive_dataset_id = p_source_identity;
END;
$$;

COMMENT ON FUNCTION copy_accumulator_identity(text, text) IS
  'Duplicates p_source_identity''s real rows in archive_stream_accumulator_buckets under a new p_destination_identity. Never touches the source rows, never touches archive_stream_checkpoint. SECURITY INVOKER (the default): runs under the service-role key, same as every other write to this table.';

REVOKE ALL ON FUNCTION copy_accumulator_identity(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION copy_accumulator_identity(text, text) TO service_role;

CREATE TABLE rolling_window_fold_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  logical_window text NOT NULL,
  date date NOT NULL,
  -- Null only for a permanent_gap row, where by definition no real source
  -- dataset covers this day at all.
  source_dataset_id text,
  row_count_at_fold bigint,
  folded_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('folded', 'permanent_gap', 'low_volume')),

  CONSTRAINT rolling_window_fold_ledger_gap_has_no_source CHECK (
    (status = 'permanent_gap' AND source_dataset_id IS NULL) OR (status != 'permanent_gap' AND source_dataset_id IS NOT NULL)
  ),

  UNIQUE (logical_window, date)
);

COMMENT ON TABLE rolling_window_fold_ledger IS
  'One row per real calendar day ever decided about for a logical rolling window, so no day is ever folded twice and a confirmed-permanent gap (e.g. the real Sep 2-7 2026 gap between rke9-rsvs and xkas-9n43) is recorded explicitly rather than silently absent.';

CREATE INDEX idx_rolling_window_fold_ledger_window_date ON rolling_window_fold_ledger (logical_window, date);

-- Same deliberately-zero-policy RLS as this project's other job-bookkeeping
-- tables -- holds no parking data of public interest, only this project's
-- own fold-tracking state.
ALTER TABLE rolling_window_fold_ledger ENABLE ROW LEVEL SECURITY;
