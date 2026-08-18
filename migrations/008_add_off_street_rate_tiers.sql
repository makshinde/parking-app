-- Adds off_street_rate_tiers and drops off_street_facilities.hourly_rate_usd
-- /rate_note (see schema.sql for the full schema). Safe to run on its own
-- against the live Supabase project.

-- Live-verified against the real Public Garages and Parking Lots
-- FeatureServer (services.arcgis.com/ZOyb2t4B0UYuYNYH/.../Public_Garages_and_Parking_Lots):
-- source rates are NOT a single field -- there are 4 separate duration-based
-- rate fields (RTE_1HR, RTE_2HR, RTE_3HR, RTE_ALLDAY), each independently
-- populated for only ~3-4% of records (consistent with CLAUDE.md's existing
-- "off_street_facilities data has only ~2-4% coverage on rate..." note). A
-- single hourly_rate_usd/rate_note pair can only ever hold one of these four,
-- silently discarding the other three -- the exact problem blockfaces solved
-- for its own multi-tier rate schedule via a separate rate_tiers table (see
-- migrations/003_add_rate_tiers.sql). off_street_facilities gets the same
-- treatment here, rather than an arbitrary "pick one field" compromise.
ALTER TABLE off_street_facilities DROP COLUMN hourly_rate_usd;
ALTER TABLE off_street_facilities DROP COLUMN rate_note;

CREATE TABLE off_street_rate_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  facility_id uuid NOT NULL REFERENCES off_street_facilities(id) ON DELETE CASCADE,

  -- Matches the source data's own duration grouping (RTE_1HR/2HR/3HR/ALLDAY)
  -- -- not a time-of-day window like blockfaces' rate_tiers.day_type/
  -- start_time/end_time, since this source expresses rates by how long a
  -- vehicle stays, not by time of day.
  duration_type text NOT NULL CHECK (duration_type IN ('1HR', '2HR', '3HR', 'ALLDAY')),

  -- Parsed via parseRateValue.ts: exactly one of rate_usd/rate_note is set
  -- per tier (or neither, if the source field was null/empty) -- rate_usd
  -- for a clean numeric value, rate_note for non-numeric source text (e.g.
  -- "Permit only") that would otherwise be silently discarded.
  rate_usd numeric(6, 2),
  rate_note text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One row per duration type per facility; re-import updates the existing
  -- row instead of accumulating duplicates.
  UNIQUE (facility_id, duration_type),

  -- Mirrors parseRateValue's own output contract: a tier's rate is either a
  -- clean number, non-numeric text, or genuinely unknown -- never both a
  -- number and text for the same tier.
  CONSTRAINT off_street_rate_tiers_rate_xor_note CHECK (
    rate_usd IS NULL OR rate_note IS NULL
  )
);

COMMENT ON TABLE off_street_rate_tiers IS
  'Detailed rate schedule for an off-street facility, one row per duration type (1HR/2HR/3HR/ALLDAY), sourced from the Public Garages and Parking Lots dataset''s RTE_1HR/2HR/3HR/ALLDAY fields. Replaces the single hourly_rate_usd/rate_note pair off_street_facilities previously had, the same summary-vs-detail split blockfaces uses for rate_tiers.';
COMMENT ON COLUMN off_street_rate_tiers.duration_type IS
  '1HR, 2HR, 3HR, or ALLDAY -- matches the source data''s own RTE_1HR/2HR/3HR/ALLDAY field grouping.';
COMMENT ON COLUMN off_street_rate_tiers.rate_usd IS
  'Parsed rate in USD for this duration type, set only when the source value is a clean positive number. Null if unknown or if rate_note holds non-numeric source text instead.';
COMMENT ON COLUMN off_street_rate_tiers.rate_note IS
  'Raw source text for this duration type when it did not parse as a clean positive number (e.g. "Permit only"), preserved instead of discarded.';

-- Postgres does not automatically index foreign key columns; without this,
-- every lookup of a facility's rate schedule would force a sequential scan
-- of off_street_rate_tiers as it grows.
CREATE INDEX idx_off_street_rate_tiers_facility_id ON off_street_rate_tiers (facility_id);

ALTER TABLE off_street_rate_tiers ENABLE ROW LEVEL SECURITY;
