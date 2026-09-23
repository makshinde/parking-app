-- Persists SDOT's own paid-parking-area/subarea designation onto each
-- blockface, sourced from the authoritative Blockface FeatureServer
-- (PAIDAREA/SUBAREA fields, keyed by ELMNTKEY+SIDE -- see
-- syncBlockfaceParkingAreas.ts). This project's own pipeline never
-- persisted this field before now -- it only ever existed transiently on
-- raw Socrata readings (paidparkingarea/paidparkingsubarea) before being
-- folded into the accumulator and discarded (see CLAUDE.md's Architecture
-- section). Needed as the grouping key for the area-aware occupancy
-- correction layer -- see area_occupancy_corrections, migration 025 --
-- built after tonight's field testing, the Annual Parking Study
-- comparison, and the transaction-coverage rebuild all independently
-- confirmed the same geographic pattern (worse under-prediction downtown
-- than in Ballard).
--
-- Nullable: not every blockface has a designated paid-parking area (a
-- free/unpaid blockface, or a paid one SDOT simply hasn't assigned one
-- to -- live-verified tonight this is common outside the dense
-- commercial cores) -- null here means "no area on record", not a
-- missing or failed sync.
ALTER TABLE blockfaces
  ADD COLUMN paidparkingarea text,
  ADD COLUMN paidparkingsubarea text;

COMMENT ON COLUMN blockfaces.paidparkingarea IS
  'SDOT''s own paid-parking-area designation for this blockface (e.g. "Ballard", "Belltown"), sourced from the Blockface FeatureServer''s PAIDAREA field via syncBlockfaceParkingAreas.ts. Null when SDOT has no area on record for this blockface, not necessarily a sync failure.';
COMMENT ON COLUMN blockfaces.paidparkingsubarea IS
  'SDOT''s own paid-parking-subarea designation (e.g. "North", "Core"), sourced from the Blockface FeatureServer''s SUBAREA field. Null when the area has no subarea division, or none is on record.';

-- Supports the area-correction lookup's per-area grouping without a full
-- table scan, same reasoning as idx_occupancy_stats_blockface_id. Partial
-- (WHERE NOT NULL) since most queries against this column only care about
-- blockfaces that actually have an area assigned.
CREATE INDEX idx_blockfaces_paidparkingarea ON blockfaces (paidparkingarea) WHERE paidparkingarea IS NOT NULL;
