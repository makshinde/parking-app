-- Adds accumulator_snapshot_last_processed_id to the existing
-- archive_stream_checkpoint table (see schema.sql for the full schema,
-- migrations/011 and 012 for the table and its accumulator_state column).
-- Safe to run on its own against the live Supabase project.

-- Decouples the (cheap, every-chunk) stream-position checkpoint from the
-- (expensive, infrequent) accumulator-state snapshot -- see
-- streamArchiveWithResume.ts for the full reasoning. Live-measured: writing
-- a realistic ~94,064-bucket accumulator_state blob (~13.66MB serialized)
-- averaged 17,890ms/write across 3 successful attempts against this table,
-- and outright failed with a Postgres statement timeout on 2 of 5 real
-- attempts -- ~175x slower than the ~102ms/write lightweight
-- position-only checkpoint measured earlier. Snapshotting on every chunk
-- would cost roughly 30 hours across the full archive's ~6,002 chunks,
-- dwarfing the ~5 hour honest full-archive estimate for everything else
-- combined -- clearly not viable at that cadence.
--
-- accumulator_snapshot_last_processed_id tracks which :id cursor
-- accumulator_state was last snapshotted at, separately from
-- last_processed_id (the stream's own fetch position, still updated every
-- chunk). This column deliberately lags behind last_processed_id between
-- snapshots; a resume re-fetches and re-folds exactly that bounded gap
-- (never the whole dataset) before continuing.
ALTER TABLE archive_stream_checkpoint
  ADD COLUMN accumulator_snapshot_last_processed_id text;

COMMENT ON COLUMN archive_stream_checkpoint.accumulator_snapshot_last_processed_id IS
  'The :id cursor value accumulator_state was last snapshotted at -- distinct from last_processed_id (the stream''s own fetch position), which advances every chunk while this only advances every snapshotIntervalChunks chunks (see streamArchiveWithResume.ts). Null means no snapshot has been taken yet (a fresh run, or one still short of its first snapshot boundary). A gap where this lags behind last_processed_id is expected and normal -- a resume re-fetches and re-folds exactly that bounded gap, never the whole dataset, before continuing.';

COMMENT ON COLUMN archive_stream_checkpoint.accumulator_state IS
  'Serialized per-bucket incremental accumulator state (AccumulatorSnapshot, see incrementalWeightedStats.ts), exactly as it stood when accumulator_snapshot_last_processed_id was last written -- NOT necessarily as of last_processed_id (see that column''s comment). Written atomically together with accumulator_snapshot_last_processed_id (streamArchiveWithResume.ts''s saveArchiveStreamAccumulatorSnapshot), never separately from it, so those two can never disagree with each other about what''s actually been counted.';
