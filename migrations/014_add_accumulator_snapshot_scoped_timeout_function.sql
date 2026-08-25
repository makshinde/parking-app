-- Adds a Postgres function wrapping saveArchiveStreamAccumulatorSnapshot's
-- update to archive_stream_checkpoint with a scoped, generous
-- statement_timeout, without changing the default timeout for any other
-- query against this database (see streamArchiveWithResume.ts for the full
-- reasoning). Safe to run on its own against the live Supabase project.

-- Live-confirmed via direct, controlled testing (9 real timed writes
-- against a disposable checkpoint row, 60,000-150,000 synthetic buckets)
-- that this table's accumulator_state writes hit real, load-dependent
-- Postgres statement timeouts that are NOT a fixed function of payload
-- size: the IDENTICAL ~94,064-bucket payload (~10.6MB serialized) failed
-- at 18.65s in one attempt and succeeded at 39.78s in the very next, no
-- code or data difference between them. A retry-with-backoff layer already
-- exists around this write (saveArchiveStreamAccumulatorSnapshot), but a
-- real run still hit 4 consecutive timeouts across that retry loop --
-- confirming the underlying per-query ceiling itself needed raising, not
-- just retried around.
--
-- Postgres's statement_timeout can be scoped to exactly one transaction via
-- SET LOCAL, without touching the database- or role-wide default that every
-- other query on this database -- including the cheap, frequent
-- saveArchiveStreamPosition writes on this SAME table -- still uses.
-- PostgREST already runs every request, including an RPC call, as its own
-- single transaction, so a SET LOCAL as this function's first statement
-- reverts automatically the instant the request ends, with zero risk of
-- leaking into any other query on the shared service-role connection. This
-- is the standard, idiomatic way to scope statement_timeout through a
-- PostgREST-based API like Supabase's -- confirmed directly against the
-- actual installed @supabase/postgrest-js client that no client-side
-- option (abortSignal, the client's own timeout option) touches Postgres's
-- server-enforced limit at all; those only control how long the client is
-- willing to wait for a response.
--
-- 60 seconds: the highest real observed SUCCESS in testing was 39.78s. 60s
-- gives roughly 1.5x margin above that worst-case success, and 3-4x margin
-- above the normal successful range (9.6-18.4s) -- generous enough to
-- absorb further variance of the same kind already observed, while still
-- comfortably bounded rather than unbounded.
CREATE OR REPLACE FUNCTION update_archive_stream_accumulator_snapshot(
  p_archive_dataset_id text,
  p_accumulator_snapshot_last_processed_id text,
  p_accumulator_state jsonb
)
RETURNS SETOF archive_stream_checkpoint
LANGUAGE plpgsql
AS $$
BEGIN
  SET LOCAL statement_timeout = '60s';

  RETURN QUERY
    UPDATE archive_stream_checkpoint
    SET accumulator_snapshot_last_processed_id = p_accumulator_snapshot_last_processed_id,
        accumulator_state = p_accumulator_state
    WHERE archive_dataset_id = p_archive_dataset_id
    RETURNING *;
END;
$$;

COMMENT ON FUNCTION update_archive_stream_accumulator_snapshot(text, text, jsonb) IS
  'Updates archive_stream_checkpoint''s accumulator snapshot fields with a scoped 60s statement_timeout (via SET LOCAL, reverting automatically at the end of this function''s own transaction), instead of whatever shorter default applies to every other query on this database. Called via supabase-js''s .rpc() from saveArchiveStreamAccumulatorSnapshot (streamArchiveWithResume.ts) instead of a plain .update(), specifically to survive the real, load-dependent Postgres statement timeouts observed on this table''s large accumulator_state writes. Returns the updated row (zero rows if archive_dataset_id had no existing checkpoint -- the caller''s row-count check treats that as a real, structural error, not a case to retry).';

-- Same "server-side batch job only" restriction as every other operation on
-- this internal checkpoint table (see its own RLS comment in schema.sql):
-- this function has no legitimate public-facing caller, so EXECUTE is
-- revoked from the default PUBLIC/anon/authenticated grants and restricted
-- to service_role alone.
REVOKE EXECUTE ON FUNCTION update_archive_stream_accumulator_snapshot(text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION update_archive_stream_accumulator_snapshot(text, text, jsonb) TO service_role;
