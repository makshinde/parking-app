-- Adds archive_stream_checkpoint to an existing database (see schema.sql
-- for the full schema). Safe to run on its own against the live Supabase
-- project.

-- Tracks resumability state for a full-archive streaming run (see CLAUDE.md's
-- Architecture section), one row per archive_dataset_id -- so each yearly
-- archive (e.g. "7c2e-uany" for 2025, "wtpb-jp8d" for 2020) gets its own
-- independent checkpoint, and streaming one year's archive never interferes
-- with another's progress. On startup, a streaming run checks for an
-- existing checkpoint row for the archive it's about to process and, if one
-- exists, resumes from just after last_processed_id instead of restarting
-- from the beginning of the dataset.
CREATE TABLE archive_stream_checkpoint (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  archive_dataset_id text NOT NULL UNIQUE,

  -- Socrata's own :id system field value (e.g. "row-km8v~rgdh.iue6") for the
  -- last row successfully processed, NOT a timestamp. Live-verified: :id
  -- pagination ($where=:id > cursor&$order=:id, no $offset) stays fast at
  -- depth (300ms-1.3s per 50,000-row page vs 14-16s for the equivalent
  -- occupancydatetime-based cursor -- 10-40x faster), and, since :id is
  -- guaranteed unique per row, resuming from it can never skip or duplicate
  -- a row the way a timestamp cursor can when multiple readings share the
  -- exact same timestamp at a resume boundary. Confirmed gap-free and
  -- duplicate-free by independently paginating an entire day (2025-06-10)
  -- this way and matching its row count exactly (1,002,814 rows) against a
  -- separately-verified count(*).
  last_processed_id text NOT NULL,

  -- Running count of readings processed so far in this archive's streaming
  -- run, purely informational (progress reporting/sanity-checking) -- not
  -- used to decide where to resume from, that's last_processed_id's job.
  readings_processed_count bigint NOT NULL,

  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE archive_stream_checkpoint IS
  'Tracks resumability state for a full-archive streaming run, one row per archive_dataset_id so each yearly archive checkpoints independently. On restart, a streaming run resumes from just after last_processed_id instead of re-fetching the whole dataset. Purely internal/operational bookkeeping for the batch job itself, not part of the public-facing schema. Deliberately has RLS enabled with NO policies at all (not even public read), same reasoning as occupancy_stats_backfill_progress and occupancy_stats_backfill_failures: it holds no parking data of any public interest, only this project''s own job-checkpoint state.';
COMMENT ON COLUMN archive_stream_checkpoint.archive_dataset_id IS
  'Socrata dataset id for the yearly archive being streamed (e.g. "7c2e-uany" for 2025), matching resolveYearlyArchiveDatasetId''s output. UNIQUE so each archive gets its own independent checkpoint.';
COMMENT ON COLUMN archive_stream_checkpoint.last_processed_id IS
  'Socrata''s own :id system field value for the last row successfully processed -- not a timestamp. Live-verified unique per row, gap-free and duplicate-free under keyset pagination, and 10-40x faster at depth than an occupancydatetime-based cursor. Resuming from this can never skip or duplicate a row the way a timestamp cursor can when multiple readings share the same timestamp at a resume boundary.';
COMMENT ON COLUMN archive_stream_checkpoint.readings_processed_count IS
  'Running count of readings processed so far in this archive''s streaming run. Informational only (progress reporting) -- resuming is driven by last_processed_id, not this count.';

ALTER TABLE archive_stream_checkpoint ENABLE ROW LEVEL SECURITY;
-- No CREATE POLICY statements, intentionally: same reasoning as
-- occupancy_stats_backfill_progress and occupancy_stats_backfill_failures.
-- With RLS enabled and zero policies, Postgres denies all access by default
-- to any role without BYPASSRLS -- only the service-role key (used
-- server-side by the batch job) can read or write it.
