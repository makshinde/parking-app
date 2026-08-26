-- Removes the single-JSONB-blob accumulator snapshot approach entirely, now
-- that archive_stream_accumulator_buckets (migrations/015, applied
-- alongside this one) replaces it with one row per bucket. This is a
-- deliberate, explicit removal, not a deprecation-in-place: no real
-- production data ever lived durably in accumulator_state -- every run that
-- reached this write path either failed outright or was a disposable test
-- row (see migrations/014's and streamArchiveWithResume.ts's own comments
-- for the live-verified timeout failures that motivated this replacement)
-- -- so there is nothing real to lose, and leaving a dead column and an
-- orphaned function in place would only confuse a future reader.
--
-- update_archive_stream_accumulator_snapshot (migrations/014) was the
-- Postgres function wrapping accumulator_state's UPDATE in a scoped 60s
-- statement_timeout via SET LOCAL. Live verification after that migration
-- was applied showed it did NOT fix the real problem: at realistic bucket
-- counts (~110,000+), writes still failed at a size-independent ~20 seconds
-- regardless of the 60s SET LOCAL -- strong evidence the true constraint
-- was an external cutoff (Supabase's connection pooler or API gateway) that
-- a database-level statement_timeout has no ability to reach. Its only
-- caller (saveArchiveStreamAccumulatorSnapshotOnce) has been rewritten to
-- use archive_stream_accumulator_buckets instead, so this function has no
-- remaining callers.
DROP FUNCTION IF EXISTS update_archive_stream_accumulator_snapshot(text, text, jsonb);

-- accumulator_state itself is dropped for the same reason: nothing reads or
-- writes it anymore now that streamArchiveWithResume.ts reads/writes
-- archive_stream_accumulator_buckets instead (see fetchAccumulatorBuckets /
-- saveArchiveStreamAccumulatorSnapshot).
ALTER TABLE archive_stream_checkpoint DROP COLUMN IF EXISTS accumulator_state;
