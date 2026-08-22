-- Adds accumulator_state to the existing archive_stream_checkpoint table
-- (see schema.sql for the full schema, migrations/011 for the original
-- table). Safe to run on its own against the live Supabase project.

-- Without this column, a streaming run's per-bucket incremental accumulator
-- (incrementalWeightedStats.ts) would need to be persisted separately from
-- archive_stream_checkpoint's last_processed_id/readings_processed_count --
-- two independently-timed writes that can drift apart across a crash. If
-- the accumulator were persisted ahead of last_processed_id, a resume would
-- replay an already-counted chunk into it (double-counting); if persisted
-- behind, a resume would silently lose whatever a checkpointed chunk had
-- already folded in (undercounting). Storing accumulator_state in the same
-- row, written in the same upsert as last_processed_id/
-- readings_processed_count (see streamArchiveWithResume.ts's
-- saveArchiveStreamCheckpoint), makes that drift impossible: a resume
-- always restores a mutually consistent pair.
ALTER TABLE archive_stream_checkpoint
  ADD COLUMN accumulator_state jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN archive_stream_checkpoint.accumulator_state IS
  'Serialized per-bucket incremental accumulator state (AccumulatorSnapshot, see incrementalWeightedStats.ts), exactly as it stood when last_processed_id was last checkpointed. Written in the same upsert as last_processed_id/readings_processed_count, never separately -- a resume restores this alongside the stream position atomically, so it can never be ahead (causing double-counting on replay) or behind (silently losing a checkpointed chunk''s contribution).';
