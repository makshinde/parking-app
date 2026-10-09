-- Adds the dry-run gate requested before scheduled-rebuild.ts is ever
-- allowed to actually promote: a run now records whether it was a real
-- attempt or a dry run (checks only, promotion deliberately skipped), and
-- 'dry_run_complete' is a new, distinct terminal step so a dry run's
-- "stopped on purpose after the integrity check" is never confused with
-- either a genuine failure or a genuine full promotion in the audit trail.
--
-- Both changes are additive (a new column with a safe default, a widened
-- CHECK constraint that only ever permits one more value than before) --
-- no existing row's data changes, and both are reversible by dropping the
-- column / narrowing the constraint back.

ALTER TABLE scheduled_rebuild_runs ADD COLUMN dry_run boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN scheduled_rebuild_runs.dry_run IS
  'true when this run was deliberately stopped after the integrity check, with promotion never attempted -- the default for every manual AND (once added) scheduled trigger unless --allow-promotion is explicitly passed.';

ALTER TABLE scheduled_rebuild_runs DROP CONSTRAINT scheduled_rebuild_runs_step_check;
ALTER TABLE scheduled_rebuild_runs ADD CONSTRAINT scheduled_rebuild_runs_step_check CHECK (step IN (
  'streaming_archive', 'streaming_rolling_window', 'gap_check',
  'integrity_check', 'promoting', 'reconciling', 'verifying', 'done',
  'dry_run_complete'
));
