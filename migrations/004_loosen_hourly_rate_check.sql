-- Loosens blockfaces.hourly_rate_requires_paid: DATA_GAP sides are
-- is_paid = true with a genuinely unknown (null) rate (see
-- assembleBlockface.ts / resolveBlockfaceSides.ts -- curb-spaces evidence
-- says a pay station belongs on that side, but its record is missing), which
-- the original constraint rejected since it required is_paid = true to
-- always come with a non-null rate.
--
-- is_paid = false must still require a null rate -- that direction stays
-- strict, since a free blockface should never have a rate attached. Only
-- is_paid = false with a non-null rate is now rejected.
ALTER TABLE blockfaces DROP CONSTRAINT hourly_rate_requires_paid;

ALTER TABLE blockfaces ADD CONSTRAINT hourly_rate_requires_paid
  CHECK (is_paid OR hourly_rate_usd IS NULL);
