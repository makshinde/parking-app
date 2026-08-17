-- Renames blockfaces.hourly_rate_usd to starting_rate_usd. The old name was
-- misleading: this column has only ever held the first weekday morning
-- tier's rate (see assembleBlockface.ts), not an hourly rate representative
-- of the full posted schedule -- a paid blockface can have up to 3 tiers per
-- day-type with different rates at different times (see rate_tiers). The new
-- name is meant to read honestly as a starting/base figure, not "the" rate.
-- See CLAUDE.md's Conventions section for the full rule this enforces.
ALTER TABLE blockfaces RENAME COLUMN hourly_rate_usd TO starting_rate_usd;

-- Same rename for the CHECK constraint, for consistency with the column;
-- its logic (is_paid OR starting_rate_usd IS NULL) is unchanged.
ALTER TABLE blockfaces RENAME CONSTRAINT hourly_rate_requires_paid TO starting_rate_requires_paid;

COMMENT ON COLUMN blockfaces.starting_rate_usd IS
  'ONLY the first weekday morning tier''s rate -- not a representative or average price. Never show this alone as "the" rate for a blockface; pull the full schedule from rate_tiers for the relevant day/time instead.';
