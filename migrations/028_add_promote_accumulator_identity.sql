-- Makes CLAUDE.md's "Rebuild policy" promote step (step 3: rename the real
-- identity's current rows to a backup identity, then rename the staging
-- identity's rows to become the new real identity) into real, atomic code
-- for the first time -- previously a manual SQL operation only, per that
-- section's own text. archive_stream_accumulator_buckets/
-- archive_stream_checkpoint are both keyed by a plain archive_dataset_id
-- text column (no foreign key to a separate "identities" table), so
-- promoting an identity really is just relabeling that column across both
-- tables' matching rows -- reversible by relabeling back, and the prior
-- live identity's rows are never deleted, only renamed to the backup
-- identity, exactly matching the proven manual process.
--
-- A single function call is one implicit transaction in Postgres, so all
-- four UPDATEs below either all apply or none do -- there is no
-- intermediate state a concurrent reader could observe where, say,
-- accumulator_buckets has been promoted but checkpoint hasn't.
--
-- Rename order matters: stable -> backup happens first, before staging ->
-- stable, so at every point in the transaction the value being assigned to
-- archive_dataset_id is one not currently in use by any row of that table
-- (p_backup_identity is a freshly-generated name; by the time the second
-- rename runs, nothing is tagged p_stable_identity any more) -- avoiding
-- any transient unique-constraint collision on archive_stream_checkpoint's
-- own UNIQUE(archive_dataset_id).
--
-- This is a new function -- a safe, cleanly reversible DB change per
-- CLAUDE.md's "Applying database changes" policy (creating a new function
-- may be applied directly against the live project).
CREATE FUNCTION promote_accumulator_identity(
  p_stable_identity text,
  p_staging_identity text,
  p_backup_identity text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_stable_identity = p_staging_identity OR p_stable_identity = p_backup_identity OR p_staging_identity = p_backup_identity THEN
    RAISE EXCEPTION 'promote_accumulator_identity: stable/staging/backup identities must all be distinct, got stable=%, staging=%, backup=%', p_stable_identity, p_staging_identity, p_backup_identity;
  END IF;

  UPDATE archive_stream_accumulator_buckets
  SET archive_dataset_id = p_backup_identity
  WHERE archive_dataset_id = p_stable_identity;

  UPDATE archive_stream_checkpoint
  SET archive_dataset_id = p_backup_identity
  WHERE archive_dataset_id = p_stable_identity;

  UPDATE archive_stream_accumulator_buckets
  SET archive_dataset_id = p_stable_identity
  WHERE archive_dataset_id = p_staging_identity;

  UPDATE archive_stream_checkpoint
  SET archive_dataset_id = p_stable_identity
  WHERE archive_dataset_id = p_staging_identity;
END;
$$;

COMMENT ON FUNCTION promote_accumulator_identity(text, text, text) IS
  'Atomically renames archive_dataset_id across archive_stream_accumulator_buckets and archive_stream_checkpoint: the current p_stable_identity rows become p_backup_identity (kept, never deleted), and p_staging_identity rows become the new p_stable_identity. Both tables are updated in one transaction. SECURITY INVOKER (the default): runs under the calling role''s own RLS context -- the service-role key, same as every other write to these tables.';

REVOKE ALL ON FUNCTION promote_accumulator_identity(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION promote_accumulator_identity(text, text, text) TO service_role;
