-- Adds a link from blockfaces back to its source data's own identifier,
-- matching the source_facility_id pattern already used on
-- off_street_facilities. Without this, a blockfaces row can't be traced
-- back to the curb-spaces/pay-station records it was assembled from
-- (see assembleBlockface.ts), which makes re-imports and debugging
-- ambiguous.
--
-- Type is integer to match ELMNTKEY as it appears in the source data (see
-- assembleBlockface.test.ts's makeCurbSpace/makeMultiTierPayStationRecord
-- fixtures, e.g. ELMNTKEY: 70501).
--
-- One ELMNTKEY identifies a street segment, not a single blockfaces row --
-- each side of that segment is its own row (see side_of_street). So the
-- uniqueness constraint has to be the pair (source_element_key,
-- side_of_street), not source_element_key alone, or the two sides of the
-- same segment would collide.
--
-- NOT NULL with no DEFAULT: every real blockface is assembled from a known
-- ELMNTKEY, so a missing value would signal a bug upstream, not legitimate
-- absence (same reasoning as blockfaces.side_of_street). This assumes
-- blockfaces has no existing rows yet -- true as of this migration, since no
-- import script writes to the table yet. If that's no longer true when this
-- runs, backfill source_element_key before applying, or this ALTER will fail.
ALTER TABLE blockfaces ADD COLUMN source_element_key integer NOT NULL;

ALTER TABLE blockfaces ADD CONSTRAINT blockfaces_source_element_key_side_unique
  UNIQUE (source_element_key, side_of_street);

COMMENT ON COLUMN blockfaces.source_element_key IS
  'ELMNTKEY of the source street segment this blockface was assembled from (see assembleBlockface.ts). Paired with side_of_street for uniqueness, since one ELMNTKEY covers both sides of a segment.';
