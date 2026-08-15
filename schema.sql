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
  -- two blockfaces that share the same street/cross-street pair.
  side_of_street text NOT NULL CHECK (side_of_street IN ('N', 'S', 'E', 'W')),

  is_paid boolean NOT NULL DEFAULT false,
  -- Null when the block is free (is_paid = false), or when it's paid but the
  -- rate genuinely isn't known yet (a DATA_GAP side -- see
  -- resolveBlockfaceSides.ts -- where curb-spaces evidence says a pay
  -- station belongs here but its record is missing). Enforced below: a free
  -- block must never have a rate attached, but a paid block's rate may be
  -- temporarily unknown.
  hourly_rate_usd numeric(6, 2),

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
  CONSTRAINT hourly_rate_requires_paid CHECK (
    is_paid OR hourly_rate_usd IS NULL
  )
);

COMMENT ON TABLE blockfaces IS
  'Static reference data for each parking blockface: where it is and what the posted rules are. Does not change based on observed occupancy.';
COMMENT ON COLUMN blockfaces.location IS
  'Blockface centerline geometry, used for nearest-blockface and radius queries around a destination.';
COMMENT ON COLUMN blockfaces.operating_days IS
  'ISO 8601 day-of-week numbers (1=Monday..7=Sunday) the posted hours/rate apply on.';

-- Spatial index (GiST) so "find blockfaces within N meters of this point"
-- queries stay fast as the table grows past a handful of streets.
CREATE INDEX idx_blockfaces_location ON blockfaces USING GIST (location);

ALTER TABLE blockfaces ENABLE ROW LEVEL SECURITY;

-- Detailed rate schedule for a paid blockface, one row per day-type/tier. A
-- single pay station can have up to 3 rate tiers per day-type (WKD/SAT/SUN),
-- each with its own time window and rate -- e.g. $2.50 8-11am, $1.50
-- 11am-5pm, $1 5-8pm on weekdays. blockfaces.hourly_rate_usd only holds a
-- single representative summary rate (the first weekday tier); this table
-- holds the full real schedule.
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
  'Detailed rate schedule for a paid blockface, one row per day-type (WKD/SAT/SUN) and tier (up to 3 per day-type), sourced from SDOT Pay Stations. blockfaces.hourly_rate_usd is only a representative summary; this table is the authoritative detail.';
COMMENT ON COLUMN rate_tiers.day_type IS
  'WKD (Monday-Friday), SAT, or SUN -- matches the source data''s own day-type grouping, not individual ISO days.';
COMMENT ON COLUMN rate_tiers.tier_number IS
  'Ordinal position of this tier within its day-type (1-3), matching the source''s WKD_RATE1/2/3-style fields. Not necessarily chronological across day-types.';

-- Postgres does not automatically index foreign key columns; without this,
-- every lookup of a blockface's rate schedule would force a sequential scan
-- of rate_tiers as it grows.
CREATE INDEX idx_rate_tiers_blockface_id ON rate_tiers (blockface_id);

ALTER TABLE rate_tiers ENABLE ROW LEVEL SECURITY;

-- Precomputed historical occupancy stats, bucketed per blockface / day-of-week
-- / hour-of-day. This is the aggregate the confidence-score and prediction
-- logic reads from — raw observations live elsewhere and are rolled up here.
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
  'Precomputed historical occupancy statistics per blockface, bucketed by day-of-week and hour-of-day. Rebuilt periodically from raw historical observations; not written to per-request.';
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

  -- Only set when the source rate value parses as a clean dollar amount (e.g.
  -- "3" or "4.9"); non-numeric source values like "Permit only" go to
  -- rate_note instead so that information isn't silently discarded.
  hourly_rate_usd numeric(6, 2),
  rate_note text,

  operator_name text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE off_street_facilities IS
  'Privately-operated, publicly-accessible garages and lots, imported from Seattle''s Public Garages and Parking Lots dataset. In that source data, only capacity and address are populated for nearly all records (~99% and ~97% respectively) — facility_type, hourly_rate_usd, rate_note, and operator_name are each populated for only a few percent of records, so nulls in those columns are expected and normal, not a sign of a broken import.';
COMMENT ON COLUMN off_street_facilities.source_facility_id IS
  'Identifier from the source dataset (e.g. its business-license location ID), used to upsert on re-import rather than duplicate rows.';
COMMENT ON COLUMN off_street_facilities.location IS
  'Facility location as a point, reprojected from the source SRID (2926) to WGS84 (4326) at import time.';
COMMENT ON COLUMN off_street_facilities.hourly_rate_usd IS
  'Parsed hourly rate in USD, set only when the source rate value is a clean dollar amount.';
COMMENT ON COLUMN off_street_facilities.rate_note IS
  'Raw source rate text when it did not parse as a dollar amount (e.g. "Permit only"), preserved instead of discarded.';

-- Spatial index (GiST) so proximity queries against off-street facilities
-- stay fast, matching the index on blockfaces.location.
CREATE INDEX idx_off_street_facilities_location ON off_street_facilities USING GIST (location);

ALTER TABLE off_street_facilities ENABLE ROW LEVEL SECURITY;
