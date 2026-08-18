-- Parking Availability App — database schema
-- Requires PostGIS (spatial types/indexes) and pgcrypto (gen_random_uuid()).
-- Supabase Postgres has both available; CREATE EXTENSION is idempotent.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Static, slowly-changing facts about a single blockface (one side of one
-- street between two cross streets) — the unit we predict availability for.
CREATE TABLE blockfaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Centerline of the blockface as a LineString, not a Point, so we can
  -- measure proximity and eventually render/snap to the actual curb geometry.
  -- SRID 4326 (WGS84) matches GPS/OSM/Nominatim coordinates.
  location geography(LineString, 4326) NOT NULL,

  street_name text NOT NULL,
  cross_street_from text NOT NULL,
  cross_street_to text NOT NULL,

  -- Compass side of the street this blockface's curb is on. Distinguishes the
  -- two blockfaces that share the same street/cross-street pair. Includes
  -- intercardinal directions (NE/NW/SE/SW), not just the 4 cardinal ones --
  -- live-verified against the source data that roughly 40-50% of real
  -- records are on diagonal streets and report an intercardinal side (see
  -- resolveBlockfaceSides.ts).
  side_of_street text NOT NULL CHECK (side_of_street IN ('N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW')),

  -- ELMNTKEY of the source street segment this blockface was assembled from
  -- (see assembleBlockface.ts), matching the source_facility_id pattern on
  -- off_street_facilities. One ELMNTKEY covers both sides of a segment, so
  -- uniqueness is enforced on the pair with side_of_street below, not on
  -- this column alone.
  source_element_key integer NOT NULL,

  is_paid boolean NOT NULL DEFAULT false,
  -- Null when the block is free (is_paid = false), or when it's paid but the
  -- rate genuinely isn't known yet (a DATA_GAP side -- see
  -- resolveBlockfaceSides.ts -- where curb-spaces evidence says a pay
  -- station belongs here but its record is missing). Enforced below: a free
  -- block must never have a rate attached, but a paid block's rate may be
  -- temporarily unknown.
  --
  -- Named starting_rate_usd, not hourly_rate_usd: this is ONLY the first
  -- weekday morning tier's rate (see rate_tiers), not a representative or
  -- average price across the full posted schedule. See CLAUDE.md's
  -- Conventions section -- this must never be shown to an end user as "the"
  -- rate without also pulling the full schedule from rate_tiers.
  starting_rate_usd numeric(6, 2),

  -- Days the posted restrictions/rates apply, using ISO 8601 numbering
  -- (1 = Monday ... 7 = Sunday) so it lines up with occupancy_stats.day_of_week.
  operating_days smallint[] NOT NULL DEFAULT ARRAY[1, 2, 3, 4, 5, 6, 7],
  operating_hours_start time NOT NULL DEFAULT '00:00',
  operating_hours_end time NOT NULL DEFAULT '23:59',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- A rate implies the block is paid, but not the reverse: is_paid = true
  -- with a null rate is allowed (DATA_GAP -- paid, rate unknown). Only
  -- is_paid = false with a non-null rate is rejected -- a free block should
  -- never have a rate attached.
  CONSTRAINT starting_rate_requires_paid CHECK (
    is_paid OR starting_rate_usd IS NULL
  ),

  -- One ELMNTKEY identifies a segment, not a single blockfaces row -- each
  -- side of that segment is its own row -- so uniqueness is the pair, not
  -- source_element_key alone.
  CONSTRAINT blockfaces_source_element_key_side_unique
    UNIQUE (source_element_key, side_of_street)
);

COMMENT ON TABLE blockfaces IS
  'Static reference data for each parking blockface: where it is and what the posted rules are. Does not change based on observed occupancy.';
COMMENT ON COLUMN blockfaces.location IS
  'Blockface centerline geometry, used for nearest-blockface and radius queries around a destination.';
COMMENT ON COLUMN blockfaces.starting_rate_usd IS
  'ONLY the first weekday morning tier''s rate -- not a representative or average price. Never show this alone as "the" rate for a blockface; pull the full schedule from rate_tiers for the relevant day/time instead.';
COMMENT ON COLUMN blockfaces.operating_days IS
  'ISO 8601 day-of-week numbers (1=Monday..7=Sunday) the posted hours/rate apply on.';
COMMENT ON COLUMN blockfaces.source_element_key IS
  'ELMNTKEY of the source street segment this blockface was assembled from (see assembleBlockface.ts). Paired with side_of_street for uniqueness, since one ELMNTKEY covers both sides of a segment.';

-- Spatial index (GiST) so "find blockfaces within N meters of this point"
-- queries stay fast as the table grows past a handful of streets.
CREATE INDEX idx_blockfaces_location ON blockfaces USING GIST (location);

ALTER TABLE blockfaces ENABLE ROW LEVEL SECURITY;

-- Detailed rate schedule for a paid blockface, one row per day-type/tier. A
-- single pay station can have up to 3 rate tiers per day-type (WKD/SAT/SUN),
-- each with its own time window and rate -- e.g. $2.50 8-11am, $1.50
-- 11am-5pm, $1 5-8pm on weekdays. blockfaces.starting_rate_usd only holds
-- the first weekday morning tier's rate, not a representative summary or
-- average; this table holds the full real schedule.
CREATE TABLE rate_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  blockface_id uuid NOT NULL REFERENCES blockfaces(id) ON DELETE CASCADE,

  -- Source data (SDOT Pay Stations) groups tiers by day-type, not individual
  -- day-of-week -- all weekdays share the same WKD schedule, so this matches
  -- the source's actual granularity instead of forcing a false per-day
  -- distinction the data doesn't have.
  day_type text NOT NULL CHECK (day_type IN ('WKD', 'SAT', 'SUN')),
  tier_number smallint NOT NULL CHECK (tier_number BETWEEN 1 AND 3),

  start_time time NOT NULL,
  end_time time NOT NULL,
  rate_usd numeric(6, 2) NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One row per day-type/tier per blockface; re-aggregation updates the
  -- existing row instead of accumulating duplicates.
  UNIQUE (blockface_id, day_type, tier_number)
);

COMMENT ON TABLE rate_tiers IS
  'Detailed rate schedule for a paid blockface, one row per day-type (WKD/SAT/SUN) and tier (up to 3 per day-type), sourced from SDOT Pay Stations. blockfaces.starting_rate_usd is only the first weekday morning tier''s rate, not a representative summary; this table is the authoritative detail.';
COMMENT ON COLUMN rate_tiers.day_type IS
  'WKD (Monday-Friday), SAT, or SUN -- matches the source data''s own day-type grouping, not individual ISO days.';
COMMENT ON COLUMN rate_tiers.tier_number IS
  'Ordinal position of this tier within its day-type (1-3), matching the source''s WKD_RATE1/2/3-style fields. Not necessarily chronological across day-types.';

-- Postgres does not automatically index foreign key columns; without this,
-- every lookup of a blockface's rate schedule would force a sequential scan
-- of rate_tiers as it grows.
CREATE INDEX idx_rate_tiers_blockface_id ON rate_tiers (blockface_id);

ALTER TABLE rate_tiers ENABLE ROW LEVEL SECURITY;

-- Historical occupancy stats, bucketed per blockface / day-of-week /
-- hour-of-day. This is the actively-used, primary storage for precomputed
-- predictions -- populated by a periodic batch aggregation job (see
-- CLAUDE.md's Architecture section) and read directly by the Edge Function
-- at request time, for fast, millisecond-level responses rather than a
-- live Socrata query per request. That batch job has not yet been built as
-- of this note, so this table needs populating before predictions can work.
CREATE TABLE occupancy_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  blockface_id uuid NOT NULL REFERENCES blockfaces(id) ON DELETE CASCADE,

  -- ISO 8601 day-of-week numbering (1=Monday..7=Sunday), matching
  -- blockfaces.operating_days so the two can be joined/filtered consistently.
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  hour_of_day smallint NOT NULL CHECK (hour_of_day BETWEEN 0 AND 23),

  -- Fraction of observations in this bucket where the blockface was occupied,
  -- 0 (always empty) to 1 (always full).
  mean_occupancy real NOT NULL CHECK (mean_occupancy BETWEEN 0 AND 1),

  -- Standard deviation of occupancy within the bucket, also on a 0-1 scale;
  -- feeds the "consistency" term of the prediction confidence score.
  std_dev real NOT NULL CHECK (std_dev BETWEEN 0 AND 1),

  -- Number of historical observations behind this bucket's stats; feeds the
  -- "sample size" term of the confidence score, so low-data buckets don't
  -- overstate how reliable the prediction is.
  sample_count integer NOT NULL CHECK (sample_count >= 0),

  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One precomputed row per blockface/day/hour bucket; re-aggregation updates
  -- the existing row instead of accumulating duplicates.
  UNIQUE (blockface_id, day_of_week, hour_of_day)
);

COMMENT ON TABLE occupancy_stats IS
  'Historical occupancy statistics per blockface, bucketed by day-of-week and hour-of-day. Primary storage for precomputed predictions, populated by a periodic batch aggregation job and read directly by the Edge Function at request time (see CLAUDE.md''s Architecture section). That batch job has not yet been built as of this note.';
COMMENT ON COLUMN occupancy_stats.mean_occupancy IS
  'Average fraction of capacity occupied in this bucket, 0 (empty) to 1 (full).';
COMMENT ON COLUMN occupancy_stats.std_dev IS
  'Standard deviation of occupancy in this bucket, 0 (always the same) to 1 (totally random).';

-- Postgres does not automatically index foreign key columns; without this,
-- every lookup of a blockface's stats (the app's main read pattern) would
-- force a sequential scan of occupancy_stats as it grows.
CREATE INDEX idx_occupancy_stats_blockface_id ON occupancy_stats (blockface_id);

ALTER TABLE occupancy_stats ENABLE ROW LEVEL SECURITY;

-- Privately-operated garages and lots that are open to the public (Seattle's
-- "Public Garages and Parking Lots" dataset). Kept separate from blockfaces
-- since these are off-street facilities, not curbside blockfaces, and the
-- source data has a very different (much sparser) shape.
CREATE TABLE off_street_facilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source dataset's own identifier, so re-imports can upsert instead of
  -- accumulating duplicate rows.
  source_facility_id text NOT NULL UNIQUE,

  name text NOT NULL,

  -- Source data (Seattle's Public Garages and Parking Lots dataset) arrives in
  -- SRID 2926 (Washington State Plane North) and must be reprojected to 4326
  -- at import time; this column is WGS84 to match blockfaces.location.
  location geography(Point, 4326) NOT NULL,

  address text,
  capacity integer,

  facility_type text CHECK (facility_type IN ('GARAGE', 'SURFACE LOT')),

  operator_name text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE off_street_facilities IS
  'Privately-operated, publicly-accessible garages and lots, imported from Seattle''s Public Garages and Parking Lots dataset. In that source data, only capacity and address are populated for nearly all records (~99% and ~97% respectively) — facility_type and operator_name are each populated for only a few percent of records, so nulls in those columns are expected and normal, not a sign of a broken import. Rate information lives in off_street_rate_tiers, not on this table -- the source data has 4 independent duration-based rate fields (1HR/2HR/3HR/ALLDAY), which a single column here couldn''t represent without discarding 3 of the 4.';
COMMENT ON COLUMN off_street_facilities.source_facility_id IS
  'Identifier from the source dataset (e.g. its business-license location ID), used to upsert on re-import rather than duplicate rows.';
COMMENT ON COLUMN off_street_facilities.location IS
  'Facility location as a point, reprojected from the source SRID (2926) to WGS84 (4326) at import time.';

-- Spatial index (GiST) so proximity queries against off-street facilities
-- stay fast, matching the index on blockfaces.location.
CREATE INDEX idx_off_street_facilities_location ON off_street_facilities USING GIST (location);

ALTER TABLE off_street_facilities ENABLE ROW LEVEL SECURITY;

-- Detailed rate schedule for an off-street facility, one row per duration
-- type. The source data (Public Garages and Parking Lots dataset) expresses
-- rates as 4 independent duration-based fields (RTE_1HR, RTE_2HR, RTE_3HR,
-- RTE_ALLDAY) rather than a single number -- live-verified against the real
-- FeatureServer, each field independently populated for only ~3-4% of
-- records. A single hourly_rate_usd column on off_street_facilities could
-- only ever hold one of these four, silently discarding the rest; this table
-- holds the full set, the same summary-vs-detail split blockfaces uses for
-- rate_tiers.
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
